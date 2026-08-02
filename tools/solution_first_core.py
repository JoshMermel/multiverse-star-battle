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

from board_utils import get_neighbors_4, get_neighbors_8, voronoi_flood_fill

# Repair-loop attempt budget shared by SolutionFirstGenerator and
# SolutionFirstPairComparator -- each iteration is one diff-guided local
# repair (relocate one disagreeing cell, re-solve, check again).
MAX_REPAIR_STEPS = 400


def random_star_placement(n, stars_per_unit=1):
    """
    Finds one random valid star placement (stars_per_unit stars per row/col,
    no two stars 8-adjacent) via CP-SAT with a random linear objective to
    ensure genuine variety across calls.

    Returns a list of n*stars_per_unit cell indices, or None if infeasible.
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
    status = solver.solve(model)
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return None
    return [i for i in range(n * n) if solver.value(x[i])]


def stars_to_solution_string(star_cells_set, n):
    return "".join('x' if i in star_cells_set else '.' for i in range(n * n))


def seed_and_grow(star_cells, n, stars_per_unit=1, size_variation=0.0):
    """
    Grows an n×n board from `star_cells` (a flat list of n*stars_per_unit
    cell indices) into n contiguous regions, each containing exactly
    stars_per_unit star cells.

    size_variation is forwarded to voronoi_flood_fill to control how
    unequal region sizes are. 0.0 (default) gives roughly equal sizes;
    larger values (e.g. 1.0–3.0) produce a wider spread. See
    voronoi_flood_fill in board_utils for details.

    For stars_per_unit=1: each star seeds its own region directly.

    For stars_per_unit>1: each star seeds its own temporary single-star
    region (giving n*stars_per_unit small regions after the fill), then
    adjacent temporary regions are grouped into connected sets of
    stars_per_unit and merged.

    Returns (grid, star_groups) or None on failure.
    """
    n_tmp = len(star_cells)  # = n * stars_per_unit

    grid = [None] * (n * n)
    for tmp_id, cell in enumerate(star_cells):
        grid[cell] = tmp_id
    grid = voronoi_flood_fill(grid, n, size_variation=size_variation)
    if grid is None:
        return None

    if stars_per_unit == 1:
        return grid, [[cell] for cell in star_cells]

    groups = _find_adjacent_groups(grid, n, n_tmp, stars_per_unit)
    if groups is None:
        return None

    tmp_to_final = {
        tmp_id: final_id
        for final_id, group in enumerate(groups)
        for tmp_id in group
    }
    for i in range(n * n):
        grid[i] = tmp_to_final[grid[i]]

    star_groups = [[star_cells[tmp_id] for tmp_id in group] for group in groups]
    return grid, star_groups


def _find_adjacent_groups(grid, n, n_tmp, stars_per_unit):
    """
    Groups n_tmp single-star Voronoi regions into n_tmp//stars_per_unit
    final groups of stars_per_unit each. Every region added to a group must
    be adjacent to at least one existing group member (guaranteeing the
    merged region is contiguous). Retries up to 200 times with fresh random
    orderings. Returns a list of groups (each a list of tmp_ids), or None.
    """
    n_groups = n_tmp // stars_per_unit

    adjacent = defaultdict(set)
    for i in range(n * n):
        for nb in get_neighbors_4(i, n):
            a, b = grid[i], grid[nb]
            if a != b:
                adjacent[a].add(b)
                adjacent[b].add(a)

    for _ in range(200):
        unmatched = set(range(n_tmp))
        order = list(range(n_tmp))
        random.shuffle(order)
        groups = []
        failed = False

        for start in order:
            if start not in unmatched:
                continue
            group = [start]
            unmatched.remove(start)
            frontier = adjacent[start] & unmatched

            while len(group) < stars_per_unit:
                if not frontier:
                    failed = True
                    break
                nxt = random.choice(list(frontier))
                group.append(nxt)
                unmatched.remove(nxt)
                frontier |= adjacent[nxt] & unmatched
                frontier.discard(nxt)

            if failed:
                break
            groups.append(group)

        if not failed and len(groups) == n_groups:
            return groups

    return None


def _is_contiguous(cells, n):
    """True if all cells in `cells` form a single 4-connected region."""
    cells_set = set(cells)
    if len(cells_set) <= 1:
        return True
    start = next(iter(cells_set))
    seen = {start}
    queue = deque([start])
    while queue:
        cur = queue.popleft()
        for nb in get_neighbors_4(cur, n):
            if nb in cells_set and nb not in seen:
                seen.add(nb)
                queue.append(nb)
    return seen == cells_set


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
    return _is_contiguous(new_src, n) and _is_contiguous(new_dst, n)


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
