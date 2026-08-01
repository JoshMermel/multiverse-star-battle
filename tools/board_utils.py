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
import string
from collections import Counter, deque
from functools import lru_cache


ALPHABET = string.ascii_uppercase + string.ascii_lowercase

# Sentinel character for void cells: cells that belong to no region and can
# never hold a star.  Must not appear in ALPHABET.
VOID_CHAR = "*"

# The 8 (forward, inverse) index-map pairs for all rotations/reflections,
# keyed by board size n.  Precomputed on first use and cached.
# Intentionally mutable module-level state: n is always small and the
# process is single-threaded, so this is safe.
_INDEX_MAP_CACHE: dict = {}

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


def _get_index_maps(n):
    """
    Returns the 8 precomputed (forward, inverse) index-map pairs for an n×n
    board, building and caching them on first call for this n.
    """
    if n not in _INDEX_MAP_CACHE:
        pairs = []
        for transform in _TRANSFORMATIONS:
            fwd = {}
            inv = {}
            for r in range(n):
                for c in range(n):
                    old_idx = r * n + c
                    new_r, new_c = transform(r, c, n)
                    new_idx = new_r * n + new_c
                    fwd[old_idx] = new_idx
                    inv[new_idx] = old_idx
            pairs.append((fwd, inv))
        _INDEX_MAP_CACHE[n] = pairs
    return _INDEX_MAP_CACHE[n]


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


def voronoi_flood_fill(grid, n, size_variation=0.0):
    """
    Fills an n×n grid by flood-fill from the seeded cells (non-None values).

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
    if size_variation > 0.0:
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
