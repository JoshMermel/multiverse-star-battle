"""
solution_first_core.py

Shared "solution-first" board construction primitives.

Used by both SolutionFirstGenerator (single boards with exactly one
solution) and SolutionFirstPairComparator (matched groups of boards that
are each individually ambiguous, but jointly unique) -- the two problems
share the same core move, just checked against different targets: a single
board's own solution set for the former, the intersection of several
boards' solution sets for the latter.

The common idea: fix a valid star placement FIRST, seed one region per
star at its own cell (so the placement is trivially guaranteed valid under
any resulting region partition, since star cells never move once seeded),
grow the rest of each board with a star-biased flood fill, then run a
diff-guided repair loop that locally relocates cells to invalidate
unwanted alternate solutions.
"""

import random
from collections import deque, defaultdict

from ortools.sat.python import cp_model

from board_utils import get_neighbors_4, get_neighbors_8, is_contiguous, voronoi_flood_fill

# Repair-loop attempt budget shared by SolutionFirstGenerator and
# SolutionFirstPairComparator -- each iteration is one diff-guided local
# repair (relocate one disagreeing cell, re-solve, check again).
MAX_REPAIR_STEPS = 400


def random_star_placement(n, stars_per_unit=1, time_limit_seconds=15.0):
    """
    Finds one random valid star placement (stars_per_unit stars per row/col,
    no two stars 8-adjacent) via CP-SAT with a random linear objective to
    ensure genuine variety across calls.

    The random objective is only there for variety, not because any
    particular placement is actually "better" than another -- so this
    accepts the first FEASIBLE solution CP-SAT finds under a time budget
    rather than waiting for it to prove OPTIMAL. Without a cap, solve()
    will keep searching for proof of optimality against a fully random
    objective, which at larger n/stars_per_unit (e.g. n=25,
    stars_per_unit=6) can occasionally take minutes for no practical
    benefit -- any feasible placement is exactly as "random" as the
    provably-best one for this purpose.

    Returns a list of n*stars_per_unit cell indices, or None if no
    feasible placement was found within the time budget (which callers
    should treat the same as genuine infeasibility: just retry).
    """
    model = cp_model.CpModel()
    x = [model.new_bool_var(f'x_{i}') for i in range(n * n)]

    for r in range(n):
        model.add(sum(x[r * n + c] for c in range(n)) == stars_per_unit)
    for c in range(n):
        model.add(sum(x[r * n + c] for r in range(n)) == stars_per_unit)
    for i in range(n * n):
        for nb in get_neighbors_8(i, n):
            if nb > i:
                model.add_implication(x[i], x[nb].negated())

    weights = [random.randint(1, 1000) for _ in range(n * n)]
    model.maximize(sum(w * xi for w, xi in zip(weights, x)))

    solver = cp_model.CpSolver()
    solver.parameters.random_seed = random.randint(0, 2**31 - 1)
    solver.parameters.randomize_search = True
    solver.parameters.max_time_in_seconds = time_limit_seconds
    status = solver.solve(model)
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return None
    return [i for i in range(n * n) if solver.value(x[i])]


def stars_to_solution_string(star_cells_set, n):
    return "".join('x' if i in star_cells_set else '.' for i in range(n * n))


def seed_and_grow(star_cells, n, stars_per_unit=1, size_variation=0.0,
                   small_region_frac=0.0, small_region_weight=0.02,
                   small_region_weight_max=None):
    """
    Grows an n×n board from `star_cells` (a flat list of n*stars_per_unit
    cell indices) into n contiguous regions, each containing exactly
    stars_per_unit star cells.

    For stars_per_unit=1: each star seeds its own region directly, then
    voronoi_flood_fill grows them all from there -- no bridging needed,
    a single cell is trivially already "connected".

    For stars_per_unit>1, a single star cell can't seed a whole region on
    its own (a region needs stars_per_unit of them, and they's non-adjacent
    by construction, so they'll never end up 4-connected by accident).
    Growing one Voronoi cell per INDIVIDUAL star and merging adjacent cells
    into groups of stars_per_unit afterward (the previous approach) turns
    that into a graph-matching problem that gets exponentially likelier to
    strand a piece as stars_per_unit grows -- empirically it stopped
    reliably succeeding anywhere past stars_per_unit=2, regardless of n.

    Instead: decide which stars_per_unit stars belong together FIRST
    (_cluster_stars_into_groups, spatially compact groups), explicitly
    connect each group's own stars into one component via short, round-
    robin-interleaved bridging paths (_connect_all_groups) BEFORE any
    general growth happens, then hand the board -- now fully pre-seeded
    with n already-contiguous groups -- to voronoi_flood_fill for the
    remaining cells. Since every group starts the flood-fill already
    connected, and flood-fill only ever grows a label outward from cells
    it already owns, the final regions stay connected by construction; no
    matching/merge step, no failure mode from it.

    size_variation is forwarded to voronoi_flood_fill to control how
    unequal region sizes are for the leftover (non-bridge) cells. 0.0
    (default) gives roughly equal sizes; larger values (e.g. 1.0–3.0)
    produce a wider spread. See voronoi_flood_fill in board_utils.

    small_region_frac / small_region_weight (stars_per_unit>1 only): forces
    that fraction of groups (rounded, chosen at random) to grow with a
    near-zero weight instead of the normal 1.0, so they stay pinned close
    to just their own stars-plus-bridge-cells while the rest of the board
    is absorbed by the other groups. A region that small has very few
    valid star arrangements, so it tends to resolve almost immediately via
    ordinary Beginner-tier deduction once solving starts -- useful for
    biasing generation toward easier boards, especially at high
    stars_per_unit where the sheer region/cell count would otherwise give
    a solver little to grab onto early. 0.0 (default) leaves every group
    at equal weight, matching the old unbiased behaviour.

    small_region_weight_max: optional. When set (> small_region_weight),
    each small group gets its own weight drawn uniformly from
    [small_region_weight, small_region_weight_max] instead of every small
    group sharing exactly small_region_weight. A single shared weight
    means every "small" region finishes at roughly the same (tiny) size,
    so a puzzle either has a wall of trivially-resolvable regions at the
    very start or none at all -- graded weights spread those regions out:
    some stay pinned near-minimal (still resolve immediately), others grow
    enough that they only become solvable once a dot inferred elsewhere
    narrows their candidates down, so easy deductions keep surfacing
    through the solve instead of front-loading them all in the first few
    seconds. None (default) keeps the old single-weight behaviour.

    Returns (grid, star_groups) or None on failure (including: this
    particular grouping couldn't all be connected without running out of
    board -- callers should just retry with a fresh star placement).
    """
    grid = [None] * (n * n)

    if stars_per_unit == 1:
        for tmp_id, cell in enumerate(star_cells):
            grid[cell] = tmp_id
        grid = voronoi_flood_fill(grid, n, size_variation=size_variation)
        if grid is None:
            return None
        return grid, [[cell] for cell in star_cells]

    groups = _cluster_stars_into_groups(star_cells, n, stars_per_unit)
    star_owner = {cell: gid for gid, stars in enumerate(groups) for cell in stars}

    if not _connect_all_groups(grid, groups, star_owner, n):
        # The fast greedy pass can strand a group even when a jointly-
        # feasible bridging exists -- it just committed an earlier group's
        # cell that a later one turned out to need. Reset (the greedy pass
        # may have partially mutated grid before failing) and fall back to
        # a joint CP-SAT solve, which can trade off contested cells across
        # groups instead of first-come-first-served.
        grid = [None] * (n * n)
        if not _connect_all_groups_cpsat(grid, groups, star_owner, n):
            return None  # even the joint solver found no feasible bridging -- retry from scratch

    weights = None
    if small_region_frac > 0:
        n_small = round(len(groups) * small_region_frac)
        small_gids = set(random.sample(range(len(groups)), n_small))
        hi = small_region_weight_max if small_region_weight_max is not None else small_region_weight
        weights = {gid: (random.uniform(small_region_weight, hi) if gid in small_gids else 1.0)
                   for gid in range(len(groups))}

    grid = voronoi_flood_fill(grid, n, size_variation=size_variation, weights=weights)
    if grid is None:
        return None

    return grid, groups


def _cluster_stars_into_groups(star_cells, n, stars_per_unit):
    """
    Partitions star_cells into n groups of stars_per_unit, each spatially
    compact, via recursive spatial bisection (k-d tree style): split the
    current set along whichever axis (row or column) it spans more widely,
    at whatever point divides it into two halves that are themselves each
    an exact multiple of stars_per_unit, and recurse until each side is
    down to exactly stars_per_unit stars.

    An earlier version picked a random still-unclaimed star and greedily
    claimed its (stars_per_unit - 1) nearest still-unclaimed neighbours,
    repeating until none were left. That has a straggler problem: whichever
    stars are left over once most of the board's been claimed have no
    guarantee of being anywhere near each other -- empirically this could
    leave one group's stars spanning nearly the entire board (e.g. a span
    of 18 cells on a 25x25 board), which then made THAT group's bridging
    (greedy or CP-SAT) needlessly expensive or outright infeasible, even
    though every other group was compact. Recursive bisection can't produce
    that failure mode: every split only ever separates spatially, so no
    leaf group can end up wider than the split that created it.
    """
    def rc(cell):
        return divmod(cell, n)

    def split(cells):
        if len(cells) == stars_per_unit:
            return [cells]
        rows = [rc(c)[0] for c in cells]
        cols = [rc(c)[1] for c in cells]
        by_row = (max(rows) - min(rows)) >= (max(cols) - min(cols))
        cells_sorted = sorted(cells, key=lambda c: rc(c)[0] if by_row else rc(c)[1])
        n_groups = len(cells) // stars_per_unit
        split_idx = (n_groups // 2) * stars_per_unit
        return split(cells_sorted[:split_idx]) + split(cells_sorted[split_idx:])

    return split(list(star_cells))


def _connect_all_groups(grid, groups, star_owner, n):
    """
    Connects every group's own stars into one 4-connected component each,
    all in `grid`, round-robin: each round, every group that isn't already
    fully connected takes exactly ONE step (its single nearest remaining
    connection, via _connect_one_step) before any group takes a second.

    This matters more than it might look: connecting groups one at a time,
    fully, in some fixed order (e.g. hardest-first) lets whichever group
    goes first claim as much of the still-empty board as ITS OWN
    connections need, before anyone else gets a look in -- and the last
    few groups to run can end up boxed in with no path left at all, even
    though the board had plenty of room overall. Round-robin means no
    single group can hog territory ahead of the others; everyone stakes
    out roughly their fair share of the board while it's still open,
    instead of the process order picking winners and losers. Empirically
    this is the difference between a ~20% and a reliable success rate at
    higher stars_per_unit.

    Mutates `grid` in place. Returns True on success, False if some
    group's next connection has no available path at all (the caller
    should abandon this attempt -- fresh star placement/grouping -- rather
    than try to partially recover).
    """
    trees = {}
    remaining = {}
    for gid, stars in enumerate(groups):
        grid[stars[0]] = gid
        trees[gid] = {stars[0]}
        remaining[gid] = set(stars[1:])

    active = [gid for gid in range(len(groups)) if remaining[gid]]
    while active:
        random.shuffle(active)
        still_active = []
        for gid in active:
            if not _connect_one_step(grid, gid, trees[gid], remaining[gid], star_owner, n):
                return False
            if remaining[gid]:
                still_active.append(gid)
        active = still_active

    return True


def _connect_one_step(grid, group_id, tree, remaining, star_owner, n):
    """
    Advances one group's connection by exactly one star: multi-source BFS
    from the whole current `tree` at once to find the NEAREST still-
    unconnected cell in `remaining`, and claims the shortest available
    path to it (mutating `tree`/`remaining`/`grid` in place).

    A cell is only usable in a path if it's either unclaimed by every
    group so far (grid[cell] is None) or one of THIS group's own not-yet-
    connected stars (star_owner[cell] == group_id) -- crucially, another
    group's star cell is off limits even though it hasn't been formally
    claimed in `grid` yet (that only happens when ITS path to it gets
    claimed), since routing through it would corrupt that group's own
    seed. This is what actually guarantees two groups' bridge paths never
    cut each other up: each new path is routed with full knowledge of
    everything already claimed (by any group) or reserved (any group's
    own star cells), never just hoped to avoid it.

    Returns True on success, False if `remaining` has no cell reachable
    from `tree` at all under those rules.
    """
    visited = {c: None for c in tree}
    queue = deque(tree)
    found = None
    while queue:
        cur = queue.popleft()
        if cur in remaining:
            found = cur
            break
        for nb in get_neighbors_4(cur, n):
            if nb in visited:
                continue
            owner = star_owner.get(nb)
            if owner is not None and owner != group_id:
                continue  # another group's star -- always off limits
            if grid[nb] is not None and nb not in remaining:
                continue  # already claimed by some group (any group, including this one)
            visited[nb] = cur
            queue.append(nb)
    if found is None:
        return False

    path = []
    cur = found
    while cur not in tree:
        path.append(cur)
        cur = visited[cur]
    for cell in path:
        grid[cell] = group_id
        tree.add(cell)
    remaining.discard(found)
    return True


def _connect_all_groups_cpsat(grid, groups, star_owner, n, margin=3, time_limit_seconds=20.0):
    """
    Joint CP-SAT fallback for _connect_all_groups: rather than committing
    each group's bridge path greedily and irrevocably -- which can strand a
    later group even when a jointly-feasible assignment of bridge cells
    exists, just because an earlier group happened to grab the cell it
    needed first -- solve ALL groups' connections as one simultaneous
    feasibility problem, so the solver can trade off which group gets which
    contested cell instead of first-come-first-served. Round-robin
    interleaving (_connect_all_groups) softens the same problem but can't
    eliminate it: no purely sequential order can, since a cell committed to
    one group is gone for everyone else regardless of turn order.

    Each group gets a local candidate window (its own stars' bounding box,
    padded by `margin`, clipped to the board) rather than the whole board,
    keeping the model tractable even with many groups: _cluster_stars_
    into_groups already keeps a group's own stars spatially compact, so a
    modest fixed padding is normally enough room to route around whatever
    other groups' stars happen to land nearby. A cell that falls inside two
    groups' windows gets an "at most one owner" constraint tying the two
    groups' variables together -- exactly the constraint the greedy pass
    could paint itself into a corner over; here it's just part of the one
    model the solver satisfies (or proves infeasible) all at once.

    Connectivity is enforced with a standard single-commodity flow
    formulation per group: pick one of its stars as the root, require every
    other star to absorb one unit of flow that can only travel through
    cells the group actually claims, and forbid a claimed non-root,
    non-terminal cell from existing without flow genuinely passing through
    it. On its own, that constraint is necessary but NOT sufficient: a
    disconnected loop of claimed cells elsewhere in the window can satisfy
    it too, by just circulating flow among themselves (each cell's inflow
    equals its outflow, same as a real bridge cell, without that loop ever
    touching the root). Nothing so far stops the solver from claiming such
    a loop for free, since unclaimed window cells cost nothing. The fix is
    the minimize() call below: claiming any cell beyond the stars
    themselves has a strictly positive cost and zero benefit unless it's
    truly on a path to the root, so an optimal (or merely improved-over-
    the-trivial-all-claimed-window) solution can never contain one. The
    post-solve contiguity check below is the backstop in case the solver
    hits the time limit before fully eliminating such slack.

    Mutates `grid` in place (only cells that got assigned; only meaningful
    on success). Returns True/False; False can mean truly infeasible within
    the window, the solver didn't finish inside the time budget, or (via
    the backstop check) it finished with unremoved slack -- either way the
    caller should treat it as "retry from scratch" same as
    _connect_all_groups failing.
    """
    def rc(cell):
        return divmod(cell, n)

    candidates = []  # candidates[gid] = set of cells this group may claim
    for gid, stars in enumerate(groups):
        rows = [rc(c)[0] for c in stars]
        cols = [rc(c)[1] for c in stars]
        r0, r1 = max(0, min(rows) - margin), min(n - 1, max(rows) + margin)
        c0, c1 = max(0, min(cols) - margin), min(n - 1, max(cols) + margin)
        cells = set()
        for r in range(r0, r1 + 1):
            for c in range(c0, c1 + 1):
                cell = r * n + c
                owner = star_owner.get(cell)
                if owner is not None and owner != gid:
                    continue  # another group's star -- never available to this one
                cells.add(cell)
        candidates.append(cells)

    model = cp_model.CpModel()
    x = {}  # (cell, gid) -> BoolVar, "group gid claims cell"
    for gid, cells in enumerate(candidates):
        for cell in cells:
            x[cell, gid] = model.new_bool_var(f'x_{cell}_{gid}')

    # A group's own stars are always claimed by it.
    for gid, stars in enumerate(groups):
        for cell in stars:
            model.add(x[cell, gid] == 1)

    # At most one group per contested (window-overlap) cell.
    owners_of = defaultdict(list)
    for (cell, gid) in x:
        owners_of[cell].append(gid)
    for cell, gids in owners_of.items():
        if len(gids) > 1:
            model.add(sum(x[cell, gid] for gid in gids) <= 1)

    # Single-commodity flow per group, rooted at one of its own stars, to
    # force its claimed cells into one connected piece.
    for gid, stars in enumerate(groups):
        cells = candidates[gid]
        root = stars[0]
        terminals = set(stars[1:])
        k = len(terminals)
        if k == 0:
            continue  # single-star group -- trivially already connected

        arcs = {}  # (u, v) -> IntVar, directed flow u->v within this group's window
        for cell in cells:
            for nb in get_neighbors_4(cell, n):
                if nb in cells:
                    f = model.new_int_var(0, k, f'f_{cell}_{nb}_{gid}')
                    arcs[cell, nb] = f
                    # Flow can only move between cells this group claims.
                    model.add(f <= k * x[cell, gid])
                    model.add(f <= k * x[nb, gid])

        for cell in cells:
            inflow = sum(arcs[u, cell] for u in cells if (u, cell) in arcs)
            outflow = sum(arcs[cell, v] for v in cells if (cell, v) in arcs)
            if cell == root:
                model.add(inflow - outflow == -k)  # supplies one unit per terminal
            elif cell in terminals:
                model.add(inflow - outflow == 1)  # each terminal consumes one unit
            else:
                model.add(inflow - outflow == 0)
                # A claimed bridge cell must genuinely carry flow (be on a
                # real path), not just be switched on with no route to it.
                model.add(x[cell, gid] <= inflow)

    # See docstring: without this, the solver is free to claim disconnected
    # "loop" cells that satisfy flow conservation locally without ever
    # connecting to the root, since unclaimed cells are otherwise free.
    model.minimize(sum(x.values()))

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = time_limit_seconds
    solver.parameters.num_search_workers = 8
    solver.parameters.random_seed = random.randint(0, 2**31 - 1)
    status = solver.solve(model)
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return False

    claimed = defaultdict(list)
    for (cell, gid), var in x.items():
        if solver.value(var):
            claimed[gid].append(cell)

    # Backstop: confirm every group's claimed cells are actually one
    # connected piece before committing anything to `grid`. Should only
    # ever fire if the solver hit the time limit before fully optimizing
    # away leftover slack (see docstring) -- in that case, fail cleanly
    # rather than hand back a board with a hidden discontiguity.
    for gid, cells in claimed.items():
        if not is_contiguous(cells, n):
            return False

    for gid, cells in claimed.items():
        for cell in cells:
            grid[cell] = gid
    return True


def _check_move(grid, n, cells_to_move, r_src, r_dst):
    """
    Returns True if moving `cells_to_move` from r_src to r_dst would leave
    both the source and destination regions 4-connected.

    The theory says that orphan-carry and subtree moves should always
    preserve contiguity, but the interaction between the spanning-tree
    representation and the actual region topology can produce counterexamples
    in practice. A direct BFS check is O(n^2) and definitively correct.
    """
    move_set = set(cells_to_move)
    new_src = [i for i in range(n * n) if grid[i] == r_src and i not in move_set]
    new_dst = [i for i in range(n * n) if grid[i] == r_dst] + list(move_set)
    return is_contiguous(new_src, n) and is_contiguous(new_dst, n)


def orphaned_fragment(grid, region_id, anchor_cells, removed_cell, n):
    """
    BFS from ALL of region_id's anchor (star) cells across region_id's
    cells (excluding removed_cell). Returns the set of region_id cells NOT
    reachable from any anchor -- the pieces that would be cut off if
    removed_cell were simply deleted.

    anchor_cells: frozenset/set of the region's star cells (one for
    stars_per_unit=1, more for larger values).
    """
    remaining = {i for i in range(n * n) if grid[i] == region_id and i != removed_cell}
    seeds = frozenset(anchor_cells) & remaining
    seen = set(seeds)
    queue = deque(seeds)
    while queue:
        cur = queue.popleft()
        for nb in get_neighbors_4(cur, n):
            if nb in remaining and nb not in seen:
                seen.add(nb)
                queue.append(nb)
    return remaining - seen


def seed_rooted_subtree(grid, region_id, anchor_cells, cell, n):
    """
    Builds a spanning tree of region_id rooted at an arbitrary anchor cell,
    then returns the subtree hanging below `cell` -- every region_id cell
    whose only path back to the root (in the spanning tree) passes through
    it. anchor_cells: frozenset/set of the region's star cells.
    """
    seed_cell = next(iter(anchor_cells))
    region_cells = {i for i in range(n * n) if grid[i] == region_id}
    parent = {seed_cell: None}
    queue = deque([seed_cell])
    while queue:
        cur = queue.popleft()
        for nb in get_neighbors_4(cur, n):
            if nb in region_cells and nb not in parent:
                parent[nb] = cur
                queue.append(nb)

    children = defaultdict(list)
    for node, par in parent.items():
        if par is not None:
            children[par].append(node)

    subtree = set()
    stack = [cell]
    while stack:
        cur = stack.pop()
        subtree.add(cur)
        stack.extend(children[cur])
    return subtree


def attempt_local_repair(grid, n, protected_cells, region_stars, target_cell):
    """
    Tries to relocate `target_cell` out of its current region and into a
    neighbouring one, mutating `grid` in place.

    region_stars: dict mapping region_id → frozenset of that region's star
    cells (use a single-element frozenset for stars_per_unit=1).
    protected_cells: flat set of ALL star cells; these are never moved.

    Both candidate move types (orphan-carry and spanning-tree subtree) are
    pre-validated with _check_move before being committed: if a move would
    leave either the source or destination region non-contiguous, we try the
    next candidate destination, or fall through to the subtree approach.
    This makes repair provably contiguity-safe regardless of topology.

    Returns True if a move was made, False if no valid move was found.
    """
    assert target_cell not in protected_cells

    r_c = grid[target_cell]
    anchor_cells = region_stars[r_c]

    # Primary: move target_cell + any orphaned cells to a neighbour region.
    # Only consider destinations directly adjacent to target_cell so the
    # moved cells always touch the destination after the move.
    neighbor_regions = list({grid[nb] for nb in get_neighbors_4(target_cell, n) if grid[nb] != r_c})
    if neighbor_regions:
        orphans = orphaned_fragment(grid, r_c, anchor_cells, target_cell, n)
        if not (orphans & protected_cells):
            cells_to_move = orphans | {target_cell}
            random.shuffle(neighbor_regions)
            for r_alt in neighbor_regions:
                if _check_move(grid, n, cells_to_move, r_c, r_alt):
                    for cell in cells_to_move:
                        grid[cell] = r_alt
                    return True

    # Fallback: move the spanning-tree subtree rooted at target_cell.
    # This reaches interior cells that have no direct foreign neighbour.
    subtree = seed_rooted_subtree(grid, r_c, anchor_cells, target_cell, n)
    if subtree & protected_cells:
        return False
    subtree_neighbors = list({
        grid[nb]
        for cell in subtree
        for nb in get_neighbors_4(cell, n)
        if grid[nb] != r_c
    })
    random.shuffle(subtree_neighbors)
    for r_alt in subtree_neighbors:
        if _check_move(grid, n, subtree, r_c, r_alt):
            for cell in subtree:
                grid[cell] = r_alt
            return True

    return False
