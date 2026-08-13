"""
board_utils.py

Shared board geometry utilities for Multiverse Star Battle:
  - ALPHABET for encoding region IDs as characters
  - get_neighbors_4 / get_neighbors_8: orthogonal and king-move neighbor indices
  - Precomputed rotation/reflection index maps
  - get_board_variants: all 8 transforms of a board and its solution set
  - flood_fill: random contiguous region growth
  - pretty_print: debug display for flat boards
"""

import random
import re
import string
from collections import Counter, deque
from functools import lru_cache


ALPHABET = string.ascii_uppercase + string.ascii_lowercase

# Sentinel character for void cells: cells that belong to no region and can
# never hold a star.  Must not appear in ALPHABET.
VOID_CHAR = "*"

TRANSFORM_NAMES = [
    "identity", "rot90", "rot180", "rot270",
    "flip_h", "flip_v", "flip_diag", "flip_antidiag",
]

_TRANSFORMATIONS = [
    lambda r, c, n: (r, c),
    lambda r, c, n: (c, n - 1 - r),
    lambda r, c, n: (n - 1 - r, n - 1 - c),
    lambda r, c, n: (n - 1 - c, r),
    lambda r, c, n: (r, n - 1 - c),
    lambda r, c, n: (n - 1 - r, c),
    lambda r, c, n: (c, r),
    lambda r, c, n: (n - 1 - c, n - 1 - r),
]

@lru_cache(maxsize=32)
def get_transformation_maps(n):
    """
    Returns the 8 (forward, inverse) index-map pairs for an n x n board.
    Cached automatically by size n.
    """
    maps = []
    for transform_fn in _TRANSFORMATIONS:
        forward = []
        for i in range(n * n):
            r, c = divmod(i, n)
            tr, tc = transform_fn(r, c, n)
            forward.append(tr * n + tc)
        
        # Create the inverse map
        inverse = [0] * (n * n)
        for i, target in enumerate(forward):
            inverse[target] = i
            
        maps.append((forward, inverse))
    return maps

# Orthogonal (4-directional) offsets.
_OFFSETS_4 = [(0, 1), (0, -1), (1, 0), (-1, 0)]

# King-move (8-directional) offsets.
_OFFSETS_8 = [
    (dr, dc)
    for dr in (-1, 0, 1)
    for dc in (-1, 0, 1)
    if (dr, dc) != (0, 0)
]


def get_neighbors_4(idx, n):
    """
    Returns the indices of the orthogonal (up/down/left/right) neighbours of
    cell idx on an n×n board.  Out-of-bounds cells are excluded.
    """
    r, c = divmod(idx, n)
    result = []
    for dr, dc in _OFFSETS_4:
        nr, nc = r + dr, c + dc
        if 0 <= nr < n and 0 <= nc < n:
            result.append(nr * n + nc)
    return result


def get_neighbors_8(idx, n):
    """
    Returns the indices of all 8 king-move neighbours of cell idx on an n×n
    board.  Out-of-bounds cells are excluded.
    """
    r, c = divmod(idx, n)
    result = []
    for dr, dc in _OFFSETS_8:
        nr, nc = r + dr, c + dc
        if 0 <= nr < n and 0 <= nc < n:
            result.append(nr * n + nc)
    return result


def connected_components(cells, n, get_neighbors=get_neighbors_4):
    """
    Groups `cells` (an iterable of flat cell indices) into connected
    components under `get_neighbors`'s adjacency (4-connected by default;
    pass get_neighbors_8 for 8-connected). Returns a list of components,
    each a list of indices, in arbitrary order.
    """
    remaining = set(cells)
    visited = set()
    components = []
    for start in remaining:
        if start in visited:
            continue
        component = []
        stack = [start]
        visited.add(start)
        while stack:
            idx = stack.pop()
            component.append(idx)
            for nb in get_neighbors(idx, n):
                if nb in remaining and nb not in visited:
                    visited.add(nb)
                    stack.append(nb)
        components.append(component)
    return components


def is_contiguous(cells, n, get_neighbors=get_neighbors_4):
    """
    True if `cells` (an iterable of flat cell indices) forms a single
    connected component under `get_neighbors`'s adjacency (including the
    trivial cases of 0 or 1 cells).
    """
    return len(connected_components(cells, n, get_neighbors)) <= 1


def get_board_variants(flat_board, solutions, n):
    """
    Returns a list of 8 (variant_board_string, variant_solution_set) tuples.
    """
    variants = []
    all_maps = get_transformation_maps(n)
    
    for forward_map, inverse_map in all_maps:
        # Transform the board string
        v_board = [""] * (n * n)
        for i, char in enumerate(flat_board):
            v_board[forward_map[i]] = char
        v_board_str = "".join(v_board)

        # Transform the solutions
        v_sols = set()
        for sol in solutions:
            # sol is a string like 'x...x...', transform indices of 'x'
            v_sol_chars = ["."] * (n * n)
            for i, char in enumerate(sol):
                if char == 'x':
                    v_sol_chars[forward_map[i]] = 'x'
            v_sols.add("".join(v_sol_chars))
            
        variants.append((v_board_str, v_sols))

    return variants


# Indices into get_board_variants()'s 8-entry result (same order as
# TRANSFORM_NAMES) that preserve vs. swap the main/anti-diagonal axis.
# 'aligned': identity, rot180, flip_diag, flip_antidiag -- transforms that
# map the main diagonal back onto itself.
# 'misaligned': rot90, rot270, flip_h, flip_v -- transforms that map the
# main diagonal onto the anti-diagonal instead.
_DIAGONAL_ALIGNED_INDICES = [0, 2, 6, 7]
_DIAGONAL_MISALIGNED_INDICES = [1, 3, 4, 5]

# Same idea, but for the row/column axes rather than the diagonals --
# relevant whenever a board's own symmetry is itself row/column-based
# (mirror or a translation split, as opposed to diagonal). 'aligned':
# identity, rot180, flip_h, flip_v -- transforms that keep "row" mapping
# to "row" and "column" mapping to "column" (even if flipped/negated).
# 'misaligned': rot90, rot270, flip_diag, flip_antidiag -- transforms that
# swap the row and column axes with each other. This is a DIFFERENT
# partition of the same 8 transforms than the diagonal one above (they
# agree on identity/rot180, disagree on the other 6) -- e.g. a plain
# left/right mirror (flip_h) keeps rows-as-rows, so it's row/column
# "aligned", but it swaps which diagonal is which, so it's diagonal
# "misaligned".
_AXIS_ALIGNED_INDICES = [0, 2, 4, 5]
_AXIS_MISALIGNED_INDICES = [1, 3, 6, 7]


def _select_variants_by_indices(all_variants, alignment, aligned_indices, misaligned_indices):
    if alignment == 'aligned':
        indices = aligned_indices
    elif alignment == 'misaligned':
        indices = misaligned_indices
    else:
        return all_variants
    return [all_variants[i] for i in indices]


def select_diagonal_variants(all_variants, diagonal_alignment):
    """
    Filters get_board_variants()'s 8 (board, solutions) variants down to
    the 4 matching `diagonal_alignment` ('aligned' or 'misaligned') with
    respect to which diagonal (main vs. anti) a transform preserves, or
    returns all 8 unfiltered for any other value (e.g. 'any').
    """
    return _select_variants_by_indices(all_variants, diagonal_alignment,
                                        _DIAGONAL_ALIGNED_INDICES, _DIAGONAL_MISALIGNED_INDICES)


def select_axis_variants(all_variants, axis_alignment):
    """
    Filters get_board_variants()'s 8 (board, solutions) variants down to
    the 4 matching `axis_alignment` ('aligned' or 'misaligned') with
    respect to whether a transform keeps the row axis mapped to the row
    axis (and column to column), or swaps the two -- the row/column
    analogue of select_diagonal_variants, for pairing mirror- or
    translation-symmetric boards where what matters is whether the two
    boards' mirror/translation axes end up the same or different. Returns
    all 8 unfiltered for any other value (e.g. 'any').
    """
    return _select_variants_by_indices(all_variants, axis_alignment,
                                        _AXIS_ALIGNED_INDICES, _AXIS_MISALIGNED_INDICES)


def flood_fill(grid, n, excluded_region=None, reject_singletons=False):
    unfilled_count = sum(1 for cell in grid if cell is None)

    frontier = set()
    for i in range(n * n):
        if grid[i] is not None and grid[i] != excluded_region:
            for nb in get_neighbors_4(i, n):
                if grid[nb] is None:
                    frontier.add(nb)

    while frontier:
        idx = random.choice(list(frontier))
        frontier.remove(idx)

        neighbors = [
            grid[nb] for nb in get_neighbors_4(idx, n)
            if grid[nb] is not None and grid[nb] != excluded_region
        ]

        if neighbors:
            grid[idx] = random.choice(neighbors)
            for nb in get_neighbors_4(idx, n):
                if grid[nb] is None:
                    frontier.add(nb)

    if any(v is None for v in grid):
        return None

    if reject_singletons:
        counts = Counter(grid)
        if any(count == 1 for count in counts.values()):
            return None

    return grid


def pretty_print(flat_board, n):
    """
    Prints an n×n flat board string as a grid, one row per line.
    Useful for quick debugging in generator __main__ blocks.
    """
    for r in range(n):
        print(" ".join(flat_board[r * n:(r + 1) * n]))


def canonical_relabel(board_str):
    """
    Relabels regions so the first unique region character found in the
    string is mapped to 'A', the second to 'B', and so on.

    VOID_CHAR ('*') is not a region identifier and is passed through
    unchanged without consuming a label slot.
    """
    mapping = {}
    next_label_idx = 0
    new_chars = []
    for char in board_str:
        if char == VOID_CHAR:
            new_chars.append(VOID_CHAR)
            continue
        if char not in mapping:
            mapping[char] = ALPHABET[next_label_idx]
            next_label_idx += 1
        new_chars.append(mapping[char])
    return "".join(new_chars)


def voronoi_flood_fill(grid, n, size_variation=0.0, weights=None):
    """
    Fills an n×n grid by flood-fill from the seeded cells (non-None values).
    A seed's region can already span several disconnected cells (e.g. a
    pre-bridged multi-star seed group) -- the fill just treats every
    same-valued cell as one shared frontier, growing them all together.

    size_variation=0.0 (default): all seeds grow at equal rate, producing
    roughly equal-sized regions.

    size_variation > 0: each seed is assigned a random growth weight drawn
    from Gamma(1/size_variation, 1), which is equivalent to one component
    of a symmetric Dirichlet distribution with concentration 1/size_variation.
    High-weight seeds grow faster and end up with more cells; low-weight
    seeds get fewer. The coefficient of variation of region sizes scales
    roughly as sqrt(size_variation), so:
      0.5 → mild variation   (CV ≈ 0.7)
      1.0 → moderate         (CV ≈ 1.0)
      2.0 → strong           (CV ≈ 1.4)
      4.0 → dramatic         (CV ≈ 2.0)

    weights: optional explicit {region_id: weight} override, for callers
    that want deliberate (not randomized) control over which regions grow
    fast vs. stay small -- e.g. forcing a chosen subset of regions to stay
    near-minimal by giving them a tiny weight, while the rest split the
    board normally. Takes precedence over size_variation; any region id
    missing from the dict defaults to weight 1.0.

    Implementation: at each step, a region is chosen proportional to its
    weight (weighted random selection), then a random cell from that
    region's frontier is claimed. This ensures high-weight regions get
    more turns and therefore grow larger. A reverse map (cell → claiming
    regions) avoids redundant frontier scans when a cell is claimed.

    Returns the filled grid, or None if any cell couldn't be reached.
    """
    region_ids = [v for v in set(grid) if v is not None]
    if not region_ids:
        return grid

    from collections import defaultdict

    # Assign growth weights.
    if weights is not None:
        weights = {rid: weights.get(rid, 1.0) for rid in region_ids}
    elif size_variation > 0.0:
        alpha = 1.0 / size_variation
        weights = {rid: random.gammavariate(alpha, 1.0) for rid in region_ids}
    else:
        weights = {rid: 1.0 for rid in region_ids}

    # Per-region frontier and reverse map: unfilled cell → set of adjacent regions.
    region_frontier = {rid: set() for rid in region_ids}
    cell_claimants = defaultdict(set)

    for i in range(n * n):
        if grid[i] is not None:
            for nb in get_neighbors_4(i, n):
                if grid[nb] is None:
                    region_frontier[grid[i]].add(nb)
                    cell_claimants[nb].add(grid[i])

    while True:
        active = [(rid, weights[rid]) for rid in region_ids if region_frontier[rid]]
        if not active:
            break

        # Weighted random selection of which region grows next.
        total_w = sum(w for _, w in active)
        r = random.uniform(0.0, total_w)
        chosen = active[-1][0]
        for rid, w in active:
            r -= w
            if r <= 0.0:
                chosen = rid
                break

        # Claim a random frontier cell for the chosen region.
        cell = random.choice(list(region_frontier[chosen]))

        # Remove from all frontiers (it's no longer unfilled).
        for rid in cell_claimants[cell]:
            region_frontier[rid].discard(cell)
        del cell_claimants[cell]
        grid[cell] = chosen

        # Expand: newly exposed unfilled neighbours join this region's frontier.
        for nb in get_neighbors_4(cell, n):
            if grid[nb] is None and chosen not in cell_claimants[nb]:
                region_frontier[chosen].add(nb)
                cell_claimants[nb].add(chosen)

    return grid if all(v is not None for v in grid) else None


def board_columns(fieldnames):
    """
    Returns the board_N column names present in `fieldnames` (a row dict's
    keys or a CSV fieldnames list), sorted numerically by N.
    """
    cols = [f for f in fieldnames if re.fullmatch(r'board_\d+', f)]
    cols.sort(key=lambda f: int(f.split('_')[1]))
    return cols
