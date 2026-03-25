"""
gen_puzzles.py

Unified puzzle generator and scorer for Multiverse Star Battle.

Generation usage:
    python3 gen_puzzles.py --mode random_pair --n 8 --count 100
    python3 gen_puzzles.py --mode symmetric_pair --n 8 --count 100
    python3 gen_puzzles.py --mode self_entangled --n 8 --count 100
    python3 gen_puzzles.py --mode super_symmetric --n 8 --count 100
    python3 gen_puzzles.py --mode letter_pair --char1 T --char2 H --n 8 --count 10
    python3 gen_puzzles.py --mode random_pair --n 8 --count 100 --score-after


Scoring usage:
    python3 gen_puzzles.py --score --input puzzles.csv
    python3 gen_puzzles.py --score --input puzzles.csv --output scored.csv
    python3 gen_puzzles.py --score --input puzzles.csv --puzzle puzzle_42 --verbose

Generation output: CSV to stdout and to --output file.
Columns: name, N, board_1, board_2, solution

Scoring output: CSV to --output file (default: puzzles_scored.csv).
Columns: name, N, board_1, board_2, solution, score, tier, is_solved
"""

import argparse
import copy
import csv
import os
import random
import statistics
import string
from abc import ABC, abstractmethod
from collections import defaultdict, Counter, deque
from itertools import combinations
from ortools.sat.python import cp_model


# ─────────────────────────────────────────────────────────────────────────────
# Shared utilities (generation)
# ─────────────────────────────────────────────────────────────────────────────

ALPHABET = string.ascii_uppercase + string.ascii_lowercase

# The 8 index maps for all rotations/reflections, keyed by board size n.
# Precomputed on first use and cached to avoid recomputing per board.
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


def _get_index_maps(n):
    """
    Returns the 8 precomputed index maps for an n×n board, building and
    caching them on first call for this n.
    """
    if n not in _INDEX_MAP_CACHE:
        maps = []
        for transform in _TRANSFORMATIONS:
            index_map = {}
            for r in range(n):
                for c in range(n):
                    old_idx = r * n + c
                    new_r, new_c = transform(r, c, n)
                    index_map[old_idx] = new_r * n + new_c
            maps.append(index_map)
        _INDEX_MAP_CACHE[n] = maps
    return _INDEX_MAP_CACHE[n]


def get_all_solutions(grid, n):
    """
    Finds all valid 1-star-per-row/col/region placements for a flat integer
    grid. Returns a set of solution strings (e.g. 'x...x...').
    """
    model = cp_model.CpModel()
    x = [model.NewBoolVar(f'x_{i}') for i in range(n * n)]

    for r in range(n):
        model.Add(sum(x[r * n + c] for c in range(n)) == 1)
    for c in range(n):
        model.Add(sum(x[r * n + c] for r in range(n)) == 1)

    region_map = defaultdict(list)
    for i, reg_id in enumerate(grid):
        region_map[reg_id].append(x[i])
    for cells in region_map.values():
        model.Add(sum(cells) == 1)

    for r in range(n):
        for c in range(n):
            i = r * n + c
            for dr in [-1, 0, 1]:
                for dc in [-1, 0, 1]:
                    if dr == 0 and dc == 0:
                        continue
                    nr, nc = r + dr, c + dc
                    if 0 <= nr < n and 0 <= nc < n:
                        model.AddImplication(x[i], x[nr * n + nc].Not())

    solver = cp_model.CpSolver()
    collector = _SolutionCollector(x)
    solver.SearchForAllSolutions(model, collector)
    return collector.solutions


class _SolutionCollector(cp_model.CpSolverSolutionCallback):
    def __init__(self, variables):
        super().__init__()
        self.variables = variables
        self.solutions = set()

    def on_solution_callback(self):
        self.solutions.add("".join('x' if self.Value(v) else '.' for v in self.variables))


def get_board_variants(flat_board, solutions, n):
    """
    Returns all 8 rotations/reflections of a board and its solution set as a
    list of (transformed_flat_board, transformed_solution_set) tuples.
    Uses precomputed index maps for efficiency.
    """
    variants = []
    for index_map in _get_index_maps(n):
        board_chars = [''] * (n * n)
        for old_idx, new_idx in index_map.items():
            board_chars[new_idx] = flat_board[old_idx]

        transformed_solutions = set()
        for sol_str in solutions:
            new_grid = ['.'] * (n * n)
            for old_idx, char in enumerate(sol_str):
                if char == 'x':
                    new_grid[index_map[old_idx]] = 'x'
            transformed_solutions.add("".join(new_grid))

        variants.append(("".join(board_chars), transformed_solutions))

    return variants


def flood_fill(grid, n, excluded_region=None):
    """
    Fills None cells via flood-fill expansion from already-assigned neighbors.
    If excluded_region is set, cells of that region ID are never used as
    expansion sources (used by LetterGenerator to preserve the letter shape).
    Returns the filled grid or None if fill fails or produces singletons.
    """
    unfilled = [i for i in range(n * n) if grid[i] is None]
    random.shuffle(unfilled)

    max_iters = len(unfilled) * 4
    iters = 0
    while unfilled:
        iters += 1
        if iters > max_iters:
            return None

        idx = unfilled.pop(0)
        if grid[idx] is not None:
            continue

        r, c = divmod(idx, n)
        filled_neighbors = []
        for dr, dc in [(0, 1), (0, -1), (1, 0), (-1, 0)]:
            nr, nc = r + dr, c + dc
            if 0 <= nr < n and 0 <= nc < n:
                nidx = nr * n + nc
                if grid[nidx] is not None and grid[nidx] != excluded_region:
                    filled_neighbors.append(grid[nidx])

        if filled_neighbors:
            grid[idx] = random.choice(filled_neighbors)
        else:
            unfilled.append(idx)

    if any(v is None for v in grid):
        return None

    counts = Counter(grid)
    if any(c <= 1 for c in counts.values()):
        return None

    return grid


# ─────────────────────────────────────────────────────────────────────────────
# Generators
# ─────────────────────────────────────────────────────────────────────────────

class BoardGenerator(ABC):
    """
    Base class for board generators. Each generator produces a flat board
    string and its set of valid solutions.
    """
    def __init__(self, n, reject_singletons=False, min_solutions=2, max_solutions=None):
        self.n = n
        # When True, boards where any region has only 1 cell are rejected.
        self.reject_singletons = reject_singletons
        self.min_solutions = min_solutions
        self.max_solutions = max_solutions

    def _has_singleton_region(self, grid):
        counts = Counter(grid)
        return any(c == 1 for c in counts.values())

    def _solutions_in_range(self, solutions):
        """Returns True if the solution count satisfies min/max_solutions."""
        n = len(solutions)
        if n < self.min_solutions:
            return False
        if self.max_solutions is not None and n > self.max_solutions:
            return False
        return True

    @abstractmethod
    def generate(self):
        """Returns (flat_board_string, solution_set) or raises RuntimeError."""
        pass


class RandomGenerator(BoardGenerator):
    """Generates a random contiguous-region board."""

    def generate(self, max_attempts=50):
        n = self.n
        for _ in range(max_attempts):
            grid = [None] * (n * n)
            seeds = random.sample(range(n * n), n)
            for reg_id, cell in enumerate(seeds):
                grid[cell] = reg_id

            grid = flood_fill(grid, n)
            if grid is None:
                continue

            if self.reject_singletons and self._has_singleton_region(grid):
                continue

            flat = "".join(ALPHABET[v] for v in grid)
            solutions = get_all_solutions(grid, n)
            if self._solutions_in_range(solutions):
                return flat, solutions

        raise RuntimeError(f"RandomGenerator failed after {max_attempts} attempts")


class SymmetricGenerator(BoardGenerator):
    """Generates a board with random rotational or reflective symmetry."""

    def generate(self, max_attempts=50):
        n = self.n
        for _ in range(max_attempts):
            try:
                return self._attempt(n)
            except RuntimeError:
                continue
        raise RuntimeError(f"SymmetricGenerator failed after {max_attempts} attempts")

    def _attempt(self, n):
        """Makes one attempt to generate a valid symmetric board."""
        modes = {
            'horizontal': 2,
            'vertical': 2,
            'rotational_180': 2,
            'rotational_90': 4,
        }
        sym = random.choice(list(modes.keys()))
        order = modes[sym]
        if n % order != 0:
            sym, order = 'none', 1

        grid_2d = [[-1] * n for _ in range(n)]
        num_masters = n // order

        def get_orbit(r, c):
            if sym == 'horizontal':
                return [(r, c), (r, n - 1 - c)]
            if sym == 'vertical':
                return [(r, c), (n - 1 - r, c)]
            if sym == 'rotational_180':
                return [(r, c), (n - 1 - r, n - 1 - c)]
            if sym == 'rotational_90':
                return [(r, c), (c, n - 1 - r), (n - 1 - r, n - 1 - c), (n - 1 - c, r)]
            return [(r, c)]

        def in_control_zone(r, c):
            return (r, c) == min(get_orbit(r, c))

        control_cells = [(r, c) for r in range(n) for c in range(n) if in_control_zone(r, c)]
        random.shuffle(control_cells)

        reg_id_count = 0
        for r, c in control_cells:
            orbit = get_orbit(r, c)
            if grid_2d[r][c] == -1 and len(set(orbit)) == order:
                for i, (or_r, or_c) in enumerate(orbit):
                    grid_2d[or_r][or_c] = reg_id_count + (i * num_masters)
                reg_id_count += 1
                if reg_id_count >= num_masters:
                    break

        unfilled_control = [idx for idx in control_cells if grid_2d[idx[0]][idx[1]] == -1]
        random.shuffle(unfilled_control)

        while unfilled_control:
            r, c = unfilled_control.pop(0)
            if grid_2d[r][c] != -1:
                continue
            potential_parents = []
            for dr, dc in [(0, 1), (0, -1), (1, 0), (-1, 0)]:
                nr, nc = r + dr, c + dc
                if 0 <= nr < n and 0 <= nc < n and in_control_zone(nr, nc):
                    if grid_2d[nr][nc] != -1:
                        potential_parents.append(grid_2d[nr][nc])
            if potential_parents:
                chosen_master_reg = random.choice(potential_parents) % num_masters
                orbit = get_orbit(r, c)
                for i, (or_r, or_c) in enumerate(orbit):
                    grid_2d[or_r][or_c] = chosen_master_reg + (i * num_masters)
            else:
                unfilled_control.append((r, c))

        # Final sweep for axis/fixed-point cells
        for r in range(n):
            for c in range(n):
                if grid_2d[r][c] == -1:
                    for dr, dc in [(0, 1), (0, -1), (1, 0), (-1, 0)]:
                        nr, nc = r + dr, c + dc
                        if 0 <= nr < n and 0 <= nc < n and grid_2d[nr][nc] != -1:
                            grid_2d[r][c] = grid_2d[nr][nc]
                            break

        flat_grid = [grid_2d[r][c] for r in range(n) for c in range(n)]
        if any(v == -1 for v in flat_grid):
            raise RuntimeError("Unfilled cells remain after symmetric generation")

        if self.reject_singletons and self._has_singleton_region(flat_grid):
            raise RuntimeError("Board rejected: singleton region found")

        flat = "".join(ALPHABET[v] for v in flat_grid)
        solutions = get_all_solutions(flat_grid, n)
        if not self._solutions_in_range(solutions):
            raise RuntimeError("Board rejected: solution count outside allowed range")

        return flat, solutions


# ─── Letter font & generator ─────────────────────────────────────────────────

FONT_7x5 = {
    'A': [(0,2),(1,1),(1,2),(1,3),(2,0),(2,1),(2,3),(2,4),(3,0),(3,1),(3,2),(3,3),(3,4),
          (4,0),(4,4),(5,0),(5,4),(6,0),(6,4)],

    'B': [(0,0),(0,1),(0,2),(0,3),
          (1,0),(1,3),(1,4),
          (2,0),(2,3),(2,4),
          (3,0),(3,1),(3,2),(3,3),
          (4,0),(4,3),(4,4),
          (5,0),(5,3),(5,4),
          (6,0),(6,1),(6,2),(6,3)],

    'C': [(0,1),(0,2),(0,3),(0,4),
          (1,0),(1,1),
          (2,0),
          (3,0),
          (4,0),
          (5,0),(5,1),
          (6,1),(6,2),(6,3),(6,4)],

    'D': [(0,0),(0,1),(0,2),(0,3),
          (1,0),(1,3),(1,4),
          (2,0),(2,4),
          (3,0),(3,4),
          (4,0),(4,4),
          (5,0),(5,3),(5,4),
          (6,0),(6,1),(6,2),(6,3)],

    'E': [(0,0),(0,1),(0,2),(0,3),(0,4),
          (1,0),
          (2,0),
          (3,0),(3,1),(3,2),(3,3),
          (4,0),
          (5,0),
          (6,0),(6,1),(6,2),(6,3),(6,4)],

    'F': [(0,0),(0,1),(0,2),(0,3),(0,4),(1,0),(2,0),(3,0),(3,1),(3,2),(3,3),(4,0),(5,0),(6,0)],

    'G': [(0,1),(0,2),(0,3),(0,4),(1,0),(1,1),(2,0),(3,0),(3,3),(3,4),
          (4,0),(4,4),(5,0),(5,1),(5,4),(6,1),(6,2),(6,3),(6,4)],

    'H': [(0,0),(0,4),(1,0),(1,4),(2,0),(2,4),(3,0),(3,1),(3,2),(3,3),(3,4),
          (4,0),(4,4),(5,0),(5,4),(6,0),(6,4)],

    'I': [(0,0),(0,1),(0,2),(0,3),(0,4),(1,2),(2,2),(3,2),(4,2),(5,2),
          (6,0),(6,1),(6,2),(6,3),(6,4)],

    'J': [(0,2),(0,3),(0,4),
          (1,4),(2,4),(3,4),(4,4),
          (5,0),(5,1),(5,2),(5,3),(5,4),
          (6,1),(6,2),(6,3)],

    'K': [(0,0),(0,4),(1,0),(1,3),(1,4),(2,0),(2,2),(2,3),(3,0),(3,1),(3,2),
          (4,0),(4,1),(4,2),(4,3),(5,0),(5,3),(5,4),(6,0),(6,4)],

    'L': [(0,0),(1,0),(2,0),(3,0),(4,0),(5,0),(6,0),(6,1),(6,2),(6,3),(6,4)],

    'M': [(0,0),(0,4),
          (1,0),(1,1),(1,3),(1,4),
          (2,0),(2,1),(2,2),(2,3),(2,4),
          (3,0),(3,2),(3,4),
          (4,0),(4,4),
          (5,0),(5,4),
          (6,0),(6,4)],

    'N': [(0,0),(0,4),(1,0),(1,1),(1,4),(2,0),(2,1),(2,2),(2,4),(3,0),(3,2),(3,3),(3,4),
          (4,0),(4,3),(4,4),(5,0),(5,4),(6,0),(6,4)],

    'O': [(0,1),(0,2),(0,3),(1,0),(1,1),(1,3),(1,4),(2,0),(2,4),(3,0),(3,4),
          (4,0),(4,4),(5,0),(5,1),(5,3),(5,4),(6,1),(6,2),(6,3)],

    'P': [(0,0),(0,1),(0,2),(0,3),(1,0),(1,3),(1,4),(2,0),(2,3),(2,4),(3,0),(3,1),(3,2),(3,3),
          (4,0),(5,0),(6,0)],

    'Q': [(0,1),(0,2),(0,3),
          (1,0),(1,1),(1,3),(1,4),
          (2,0),(2,4),
          (3,0),(3,4),
          (4,0),(4,3),(4,4),
          (5,0),(5,1),(5,3),(5,4),
          (6,1),(6,2),(6,3),(6,4)],

    'R': [(0,0),(0,1),(0,2),(0,3),(1,0),(1,3),(1,4),(2,0),(2,3),(2,4),(3,0),(3,1),(3,2),(3,3),
          (4,0),(4,1),(4,2),(5,0),(5,2),(5,3),(6,0),(6,3),(6,4)],

    'S': [(0,1),(0,2),(0,3),(0,4),(1,0),(1,1),(2,0),(2,1),(3,1),(3,2),(3,3),
          (4,3),(4,4),(5,3),(5,4),(6,0),(6,1),(6,2),(6,3)],

    'T': [(0,0),(0,1),(0,2),(0,3),(0,4),(1,2),(2,2),(3,2),(4,2),(5,2),(6,2)],

    'U': [(0,0),(0,4),(1,0),(1,4),(2,0),(2,4),(3,0),(3,4),(4,0),(4,4),
          (5,0),(5,1),(5,3),(5,4),
          (6,1),(6,2),(6,3)],

    'V': [(0,0),(0,4),(1,0),(1,4),(2,0),(2,4),
          (3,0),(3,1),(3,3),(3,4),
          (4,1),(4,2),(4,3),
          (5,1),(5,2),(5,3),
          (6,2)],

    'W': [(0,0),(0,4),(1,0),(1,4),(2,0),(2,4),
          (3,0),(3,2),(3,4),
          (4,0),(4,1),(4,2),(4,3),(4,4),
          (5,0),(5,1),(5,3),(5,4),
          (6,0),(6,4)],

    'X': [(0,0),(0,4),
          (1,0),(1,1),(1,3),(1,4),
          (2,1),(2,2),(2,3),
          (3,1),(3,2),(3,3),
          (4,1),(4,2),(4,3),
          (5,0),(5,1),(5,3),(5,4),
          (6,0),(6,4)],

    'Y': [(0,0),(0,4),(1,0),(1,4),(2,0),(2,1),(2,3),(2,4),(3,1),(3,2),(3,3),(4,2),(5,2),(6,2)],

    'Z': [(0,0),(0,1),(0,2),(0,3),(0,4),
          (1,3),(1,4),
          (2,2),(2,3),
          (3,2),(3,3),
          (4,1),(4,2),
          (5,0),(5,1),
          (6,0),(6,1),(6,2),(6,3),(6,4)],

    ' ': [],
}


def render_letter(char, n, letter_region_id=0):
    """Returns a partial flat grid with the letter pixels set to letter_region_id."""
    pixels = FONT_7x5.get(char.upper(), [])
    row_offset = (n - 7) // 2
    col_offset = (n - 5) // 2
    partial = [None] * (n * n)
    for pr, pc in pixels:
        r, c = pr + row_offset, pc + col_offset
        if 0 <= r < n and 0 <= c < n:
            partial[r * n + c] = letter_region_id
    return partial


class LetterGenerator(BoardGenerator):
    """
    Generates a board where region 0 is shaped like the given character.
    Other regions flood-fill the remaining space, never overwriting the letter.
    The partial grid and letter cell list are precomputed in __init__ since
    they are constant for a given (char, n).
    """

    def __init__(self, n, char, reject_singletons=False):
        super().__init__(n, reject_singletons)
        self.char = char.upper()
        self.partial = render_letter(self.char, n, letter_region_id=0)
        self.letter_cells = [i for i, v in enumerate(self.partial) if v == 0]
        if not self.letter_cells:
            raise ValueError(f"Character '{self.char}' has no pixels for n={n}")

    def generate(self, max_attempts=1000):
        n = self.n
        for _ in range(max_attempts):
            grid = list(self.partial)
            free_cells = [i for i, v in enumerate(grid) if v is None]
            if len(free_cells) < n - 1:
                continue

            seeds = random.sample(free_cells, n - 1)
            for reg_id, cell in enumerate(seeds, start=1):
                grid[cell] = reg_id

            # excluded_region=0 prevents expansion from the letter region,
            # preserving the letter shape.
            grid = flood_fill(grid, n, excluded_region=0)
            if grid is None:
                continue

            if self.reject_singletons and self._has_singleton_region(grid):
                continue

            solutions = get_all_solutions(grid, n)
            if self._solutions_in_range(solutions):
                return "".join(ALPHABET[v] for v in grid), solutions

        raise RuntimeError(
            f"LetterGenerator failed for '{self.char}' after {max_attempts} attempts"
        )




class VotingDistrictGenerator(BoardGenerator):
    """
    Generates a board where every region contains exactly N cells.

    Method (ReCom-inspired):
      1. Seed with a striped partition: region k gets all cells in row k,
         giving N contiguous regions of exactly N cells each.
      2. Repeatedly pick two adjacent regions, merge them into a 2N-cell
         blob, build a random spanning tree of that blob, and cut a
         "balance edge" — one whose removal yields two subtrees of size N.
         If no balance edge exists for this spanning tree, retry with a
         fresh tree (up to a small limit).
      3. After enough accepted moves the board is well-shuffled; solve and
         return if the solution count passes the range check.

    Because every region always has exactly N cells, the reject_singletons
    flag has no effect (regions can never be size 1 for N >= 2).
    """

    # How many ReCom moves to attempt per generation attempt.
    # 4*n^2 gives enough shuffling without being slow.
    _MOVES_PER_ATTEMPT = None  # set to 4*n*n in __init__

    def __init__(self, n, reject_singletons=False, min_solutions=2, max_solutions=None):
        super().__init__(n, reject_singletons=reject_singletons,
                         min_solutions=min_solutions, max_solutions=max_solutions)
        self._MOVES_PER_ATTEMPT = 4 * n * n

    # ── grid helpers ──────────────────────────────────────────────────────────

    def _orthogonal_neighbors(self, idx):
        """Returns the (up to 4) orthogonal neighbours of cell idx."""
        n = self.n
        r, c = divmod(idx, n)
        neighbors = []
        if r > 0:     neighbors.append((r - 1) * n + c)
        if r < n - 1: neighbors.append((r + 1) * n + c)
        if c > 0:     neighbors.append(r * n + c - 1)
        if c < n - 1: neighbors.append(r * n + c + 1)
        return neighbors

    def _region_adjacency(self, grid):
        """
        Returns a set of frozensets {a, b} for every pair of distinct
        neighbouring regions in grid.
        """
        n = self.n
        adj = set()
        for idx in range(n * n):
            for nb in self._orthogonal_neighbors(idx):
                a, b = grid[idx], grid[nb]
                if a != b:
                    adj.add(frozenset((a, b)))
        return adj

    # ── spanning-tree helpers ─────────────────────────────────────────────────

    def _random_spanning_tree(self, cells, adj_in_blob):
        """
        Builds a random spanning tree of the induced subgraph on `cells`
        using Wilson's loop-erased random walk algorithm.
        Returns the tree as an adjacency dict {cell: [neighbour, ...]}.
        """
        cells_set = set(cells)
        in_tree = set()
        tree_adj = {c: [] for c in cells}

        # Pick root
        root = random.choice(cells)
        in_tree.add(root)

        for start in cells:
            if start in in_tree:
                continue
            # Loop-erased random walk from start to the tree
            path = [start]
            visited_in_walk = {start: 0}
            cur = start
            while cur not in in_tree:
                # Neighbours of cur that are in the blob
                nbrs = [nb for nb in adj_in_blob.get(cur, []) if nb in cells_set]
                if not nbrs:
                    break
                nxt = random.choice(nbrs)
                if nxt in visited_in_walk:
                    # Erase the loop
                    loop_start = visited_in_walk[nxt]
                    path = path[:loop_start + 1]
                    visited_in_walk = {c: i for i, c in enumerate(path)}
                else:
                    visited_in_walk[nxt] = len(path)
                    path.append(nxt)
                cur = nxt

            # Add path to tree
            for i in range(len(path) - 1):
                a, b = path[i], path[i + 1]
                tree_adj[a].append(b)
                tree_adj[b].append(a)
                in_tree.add(a)
            in_tree.add(cur)

        return tree_adj

    def _find_balance_edges(self, tree_adj, cells):
        """
        Returns a list of (u, v) edges in the spanning tree whose removal
        produces two subtrees of equal size (len(cells) // 2 each).
        Uses a single DFS to compute subtree sizes.
        """
        n_half = len(cells) // 2
        root = next(iter(cells))
        parent = {root: None}
        order = []
        stack = [root]
        visited = {root}
        while stack:
            node = stack.pop()
            order.append(node)
            for nb in tree_adj.get(node, []):
                if nb not in visited:
                    visited.add(nb)
                    parent[nb] = node
                    stack.append(nb)

        subtree_size = {c: 1 for c in cells}
        for node in reversed(order):
            p = parent[node]
            if p is not None:
                subtree_size[p] += subtree_size[node]

        balance_edges = []
        for node in cells:
            p = parent[node]
            if p is not None and subtree_size[node] == n_half:
                balance_edges.append((node, p))

        return balance_edges

    # ── ReCom move ────────────────────────────────────────────────────────────

    def _recom_move(self, grid, region_cells):
        """
        Attempts one ReCom move on grid in-place.
        Picks a random adjacent region pair, merges them, builds a random
        spanning tree, and cuts a balance edge. Returns True on success.
        """
        adj_pairs = list(self._region_adjacency(grid))
        random.shuffle(adj_pairs)

        n = self.n
        # Build the full adjacency list once for the grid (orthogonal only)
        grid_adj = {}
        for idx in range(n * n):
            grid_adj[idx] = self._orthogonal_neighbors(idx)

        for pair in adj_pairs:
            ra, rb = tuple(pair)
            blob = region_cells[ra] | region_cells[rb]
            blob_list = list(blob)

            # Restrict adjacency to within the blob
            blob_adj = {c: [nb for nb in grid_adj[c] if nb in blob]
                        for c in blob_list}

            # Try a few spanning trees to find one with a balance edge
            for _ in range(10):
                tree = self._random_spanning_tree(blob_list, blob_adj)
                balance_edges = self._find_balance_edges(tree, blob)
                if balance_edges:
                    break
            else:
                continue  # no luck with this pair; try another

            # Cut a random balance edge and reassign regions
            cut_u, cut_v = random.choice(balance_edges)

            # BFS from cut_u (without crossing cut_u<->cut_v) to find new ra
            new_ra = set()
            q = deque([cut_u])
            while q:
                node = q.popleft()
                if node in new_ra:
                    continue
                new_ra.add(node)
                for nb in tree.get(node, []):
                    if nb not in new_ra and not (node == cut_u and nb == cut_v)                                         and not (node == cut_v and nb == cut_u):
                        q.append(nb)

            new_rb = blob - new_ra

            # Update grid and region_cells
            for cell in new_ra:
                grid[cell] = ra
            for cell in new_rb:
                grid[cell] = rb
            region_cells[ra] = new_ra
            region_cells[rb] = new_rb
            return True

        return False  # no adjacent pair had a usable spanning tree

    # ── main generate ─────────────────────────────────────────────────────────

    def generate(self, max_attempts=50):
        n = self.n
        for _ in range(max_attempts):
            # Seed: row-striped partition (region k = row k)
            grid = [r for r in range(n) for _ in range(n)]
            region_cells = {r: set(range(r * n, (r + 1) * n)) for r in range(n)}

            # Shuffle via ReCom moves
            moves_done = 0
            for _ in range(self._MOVES_PER_ATTEMPT):
                if self._recom_move(grid, region_cells):
                    moves_done += 1

            if moves_done == 0:
                continue  # pathological; shouldn't happen for n >= 2

            flat = "".join(ALPHABET[v] for v in grid)
            solutions = get_all_solutions(grid, n)
            if self._solutions_in_range(solutions):
                return flat, solutions

        raise RuntimeError(
            f"VotingDistrictGenerator failed after {max_attempts} attempts"
        )

# ─────────────────────────────────────────────────────────────────────────────
# Comparators
# ─────────────────────────────────────────────────────────────────────────────

class Comparator(ABC):
    """
    Base class for comparators. A comparator generates boards and prints
    matched puzzle pairs when found.
    """

    def __init__(self, n, output_rows):
        self.n = n
        self.output_rows = output_rows
        self.pairs_found = 0

    @abstractmethod
    def run(self, count):
        """Generates and compares boards until `count` pairs are found."""
        pass

    def _emit(self, name, board_1, board_2, solution):
        row = {'name': name, 'N': self.n, 'board_1': board_1,
               'board_2': board_2, 'solution': solution}
        self.output_rows.append(row)
        print(f"{name},{self.n},{board_1},{board_2},{solution}", flush=True)
        self.pairs_found += 1


class SymmetricPoolComparator(Comparator):
    """
    Single-generator pool comparator. Checks all 8 rotations/reflections of
    each new board against previously unpaired boards in the pool.
    Suitable for random_pair and symmetric_pair modes.
    """

    def __init__(self, generator, n, output_rows):
        super().__init__(n, output_rows)
        self.generator = generator
        self.pool = []  # list of (flat_board, solution_set)

    def run(self, count):
        attempts = 0
        max_attempts = count * 500

        while self.pairs_found < count and attempts < max_attempts:
            attempts += 1

            try:
                flat, solutions = self.generator.generate()
            except RuntimeError:
                continue

            variants = get_board_variants(flat, solutions, self.n)

            match_idx = -1
            for i, (pool_flat, pool_sols) in enumerate(self.pool):
                for variant_board, variant_sols in variants:
                    common = variant_sols & pool_sols
                    if len(common) == 1:
                        name = f"puzzle_{self.pairs_found + 1}"
                        self._emit(name, variant_board, pool_flat, next(iter(common)))
                        match_idx = i
                        break
                if match_idx != -1:
                    break

            if match_idx != -1:
                self.pool.pop(match_idx)
            else:
                self.pool.append((flat, solutions))


class AsymmetricPoolComparator(Comparator):
    """
    Two-generator pool comparator. Generates from generator_a and matches
    against pooled boards from generator_b. No variant transforms are applied,
    preserving orientation (required for letter boards).
    Suitable for letter_pair mode.
    """

    def __init__(self, generator_a, generator_b, n, output_rows):
        super().__init__(n, output_rows)
        self.generator_a = generator_a
        self.generator_b = generator_b
        self.pool = []  # list of (flat_board, solution_set) from generator_b

    def run(self, count):
        attempts = 0
        max_attempts = count * 500

        while self.pairs_found < count and attempts < max_attempts:
            attempts += 1

            try:
                flat_a, sols_a = self.generator_a.generate()
            except RuntimeError:
                continue

            # Try to match against pool of generator_b boards
            match_idx = -1
            for i, (pool_flat, pool_sols) in enumerate(self.pool):
                common = sols_a & pool_sols
                if len(common) == 1:
                    name = f"puzzle_{self.pairs_found + 1}"
                    self._emit(name, flat_a, pool_flat, next(iter(common)))
                    match_idx = i
                    break

            if match_idx != -1:
                self.pool.pop(match_idx)
                continue

            # No pool match — generate a fresh generator_b board
            try:
                flat_b, sols_b = self.generator_b.generate()
            except RuntimeError:
                continue

            common = sols_a & sols_b
            if len(common) == 1:
                name = f"puzzle_{self.pairs_found + 1}"
                self._emit(name, flat_a, flat_b, next(iter(common)))
            else:
                self.pool.append((flat_b, sols_b))


class SelfComparator(Comparator):
    """
    Compares each generated board against its own rotations and reflections.
    Suitable for self_entangled and super_symmetric modes.
    """

    def __init__(self, generator, n, output_rows):
        super().__init__(n, output_rows)
        self.generator = generator

    def run(self, count):
        attempts = 0
        max_attempts = count * 500

        while self.pairs_found < count and attempts < max_attempts:
            attempts += 1

            try:
                flat, solutions = self.generator.generate()
            except RuntimeError:
                continue

            variants = get_board_variants(flat, solutions, self.n)

            # Skip index 0 (identity — same board as original)
            for i, (variant_board, variant_sols) in enumerate(variants[1:], start=1):
                common = solutions & variant_sols
                if len(common) == 1:
                    name = f"puzzle_{self.pairs_found + 1}_{TRANSFORM_NAMES[i]}"
                    self._emit(name, flat, variant_board, next(iter(common)))
                    break


# ─────────────────────────────────────────────────────────────────────────────
# Scorer
# ─────────────────────────────────────────────────────────────────────────────

# Tier ordering for display and sorting. UNSOLVED sorts last.
TIER_ORDER = ["Beginner", "Medium", "Hard", "Expert", "Grandmaster", "UNSOLVED"]


class StarBattlePuzzle:
    """Holds the mutable solving state for one puzzle during scoring."""

    def __init__(self, n, board_1, board_2, solution_str, name):
        self.name = name
        self.n = n
        self.grid = [None] * (n * n)
        self.canonical_solution = solution_str
        self.regions = [self._map_regions(board_1), self._map_regions(board_2)]
        self.row_indices = [list(range(r * n, (r + 1) * n)) for r in range(n)]
        self.col_indices = [list(range(c, n * n, n)) for c in range(n)]
        self.cell_to_region = [list(board_1), list(board_2)]
        self._neighbor_map = self._build_neighbor_map()

    def _map_regions(self, board_str):
        mapping = {}
        for idx, char in enumerate(board_str):
            mapping.setdefault(char, []).append(idx)
        return mapping

    def get_rc(self, idx):
        return divmod(idx, self.n)

    def get_row_indices(self, r):
        return [r * self.n + c for c in range(self.n)]

    def get_col_indices(self, c):
        return [r * self.n + c for r in range(self.n)]

    def _build_neighbor_map(self):
        neighbor_map = {}
        for r in range(self.n):
            for c in range(self.n):
                idx = r * self.n + c
                neighbors = []
                for dr in [-1, 0, 1]:
                    for dc in [-1, 0, 1]:
                        if dr == 0 and dc == 0:
                            continue
                        nr, nc = r + dr, c + dc
                        if 0 <= nr < self.n and 0 <= nc < self.n:
                            neighbors.append(nr * self.n + nc)
                neighbor_map[idx] = neighbors
        return neighbor_map

    def validate_and_set(self, idx, value, rule_name, verbose=False):
        """Sets a cell, validating against the canonical solution. Returns 1 if newly set."""
        expected = self.canonical_solution[idx]
        if expected != value:
            r, c = self.get_rc(idx)
            coord = f"{string.ascii_uppercase[c]}{r+1}"
            raise ValueError(
                f"Logic error in {rule_name}: inferred {value} at {coord}, expected {expected}"
            )
        if self.grid[idx] is None:
            self.grid[idx] = value
            if verbose:
                r, c = self.get_rc(idx)
                coord = f"{string.ascii_uppercase[c]}{r+1}"
                print(f"  [{rule_name}] {value} -> {coord}")
            return 1
        return 0


class CompositeScorer:
    """
    Scores Star Battle puzzles by simulating rule-based solving.
    Each rule has a weight (cost to apply) and a tier (difficulty level).
    The scorer tracks both total score and the highest tier rule used.
    """

    def __init__(self, verbose=False):
        self.verbose = verbose
        # Each entry: (rule_func, weight, tier)
        self.rules = [
            # ── Beginner ──────────────────────────────────────────────────────
            (self.rule_only_empty,                          1,  "Beginner"),
            (self.rule_sees_star,                           1,  "Beginner"),
            (self.rule_domino,                              5,  "Beginner"),
            (self.rule_triomino,                            7,  "Beginner"),
            (self.rule_1_row,                               10, "Beginner"),
            (self.rule_1_col,                               10, "Beginner"),

            # ── Medium ────────────────────────────────────────────────────────
            (self.rule_sees_too_much_pair,                  12, "Medium"),
            (self.rule_sees_too_much_trio,                  15, "Medium"),
            (self.rule_sees_too_much,                       18, "Medium"),
            (self.rule_2_adjacent_rows,                     20, "Medium"),
            (self.rule_2_adjacent_cols,                     20, "Medium"),

            # ── Hard ──────────────────────────────────────────────────────────
            (self.rule_3_adjacent_rows,                     25, "Hard"),
            (self.rule_3_adjacent_cols,                     25, "Hard"),
            (self.rule_2_disjoint_rows,                     30, "Hard"),
            (self.rule_2_disjoint_cols,                     30, "Hard"),
            (self.rule_many_adjacent_rows,                  35, "Hard"),
            (self.rule_many_adjacent_cols,                  35, "Hard"),
            (self.rule_region_contains_region,              40, "Hard"),

            # ── Expert ────────────────────────────────────────────────────────
            (self.rule_3_disjoint_rows,                     45, "Expert"),
            (self.rule_3_disjoint_cols,                     45, "Expert"),
            (self.rule_2_region_pinned_crossboard_rows,     50, "Expert"),
            (self.rule_2_region_pinned_crossboard_cols,     50, "Expert"),
            (self.rule_3_region_pinned_crossboard_rows,     60, "Expert"),
            (self.rule_3_region_pinned_crossboard_cols,     60, "Expert"),
            (self.rule_crossboard_partial_overlap,          75, "Expert"),
            (self.rule_lookahead_half_stage,                80, "Expert"),

            # ── Grandmaster ───────────────────────────────────────────────────
            (self.rule_lookahead_1_stage,                   120, "Grandmaster"),
            (self.rule_lookahead_2_stages,                  250, "Grandmaster"),
            (self.rule_lookahead_3_stages,                  550, "Grandmaster"),
        ]

    # ── Core solver ───────────────────────────────────────────────────────────

    def solve(self, puzzle):
        """
        Attempts to solve the puzzle using the rule list in order.
        Returns (is_solved, total_score, max_tier).
        """
        if self.verbose:
            print(f"\n--- Solving: {puzzle.name} ---")

        total_score = 0
        max_tier = "Beginner"

        try:
            while True:
                round_changes = 0
                for rule_func, weight, tier in self.rules:
                    changes = rule_func(puzzle)
                    if changes > 0:
                        round_changes += changes
                        total_score += weight
                        # Advance max_tier if this rule's tier is harder
                        if TIER_ORDER.index(tier) > TIER_ORDER.index(max_tier):
                            max_tier = tier
                        break
                if round_changes == 0:
                    break
        except ValueError as e:
            if self.verbose:
                print(f"  ERROR: {e}")
            return False, -999, "UNSOLVED"

        solved = all(val is not None for val in puzzle.grid)
        if not solved:
            max_tier = "UNSOLVED"
        return solved, total_score, max_tier

    # ── Internal helpers ──────────────────────────────────────────────────────

    def _internal_set(self, p, idx, val, reason, silent):
        """Sets a cell in either validation mode or silent sandbox mode."""
        if p.grid[idx] is not None:
            return 0
        if silent:
            p.grid[idx] = val
            return 1
        return p.validate_and_set(idx, val, reason, self.verbose)

    def is_board_broken(self, p):
        for unit in p.row_indices + p.col_indices + \
                    [idxs for b in p.regions for idxs in b.values()]:
            stars = sum(1 for i in unit if p.grid[i] == 'x')
            has_empty = any(p.grid[i] is None for i in unit)
            # Contradiction: unit has more than one star
            if stars > 1:
                return True
            # Contradiction: unit needs a star but has nowhere to put one
            if stars == 0 and not has_empty:
                return True

        for i, val in enumerate(p.grid):
            if val == 'x':
                if any(p.grid[nb] == 'x' for nb in p._neighbor_map[i]):
                    return True

        return False

    # ── Rules ─────────────────────────────────────────────────────────────────

    def rule_sees_star(self, p, silent=False):
        """Propagates row/col/region/adjacency exclusions from each placed star."""
        changes = 0
        for s_idx, val in enumerate(p.grid):
            if val != 'x':
                continue
            sr, sc = p.get_rc(s_idx)
            star_changes = 0

            for dr in [-1, 0, 1]:
                for dc in [-1, 0, 1]:
                    if dr == 0 and dc == 0:
                        continue
                    nr, nc = sr + dr, sc + dc
                    if 0 <= nr < p.n and 0 <= nc < p.n:
                        star_changes += self._internal_set(p, nr * p.n + nc, '.', "Adjacency", silent)

            for i in p.row_indices[sr] + p.col_indices[sc]:
                star_changes += self._internal_set(p, i, '.', "Row/Col Limit", silent)

            for b_idx in range(2):
                reg_char = p.cell_to_region[b_idx][s_idx]
                for i in p.regions[b_idx][reg_char]:
                    star_changes += self._internal_set(p, i, '.', f"Reg {reg_char} full", silent)

            changes += star_changes
            if not silent and star_changes > 0:
                return star_changes

        return changes

    def rule_only_empty(self, p, silent=False):
        """Places a star if only one valid cell remains in a unit or region."""
        all_units = (p.row_indices + p.col_indices +
                     [idxs for b in p.regions for idxs in b.values()])
        for unit in all_units:
            if any(p.grid[i] == 'x' for i in unit):
                continue
            empty = [i for i in unit if p.grid[i] is None]
            if len(empty) == 1:
                res = self._internal_set(p, empty[0], 'x', "Only empty cell", silent)
                if not silent and res > 0:
                    return res
        return 0

    def rule_domino(self, p):
        """
        MATCH: A unit/region with no star and exactly two orthogonally adjacent empty cells.
        ACTION: Marks cells that see both domino cells as dots.
        """
        containers = (
            [(p.get_row_indices(r), f"Row {r+1}") for r in range(p.n)] +
            [(p.get_col_indices(c), f"Col {string.ascii_uppercase[c]}") for c in range(p.n)] +
            [(idxs, f"B{b+1} Reg {rc}") for b in range(2) for rc, idxs in p.regions[b].items()]
        )
        for idxs, label in containers:
            if any(p.grid[i] == 'x' for i in idxs):
                continue
            empty = [i for i in idxs if p.grid[i] is None]
            if len(empty) != 2:
                continue
            i1, i2 = empty
            r1, c1 = p.get_rc(i1)
            r2, c2 = p.get_rc(i2)
            if not ((abs(r1-r2) == 1 and c1 == c2) or (abs(c1-c2) == 1 and r1 == r2)):
                continue

            def can_see(r, c, tr, tc):
                return r == tr or c == tc or (abs(r-tr) <= 1 and abs(c-tc) <= 1)

            local_changes = 0
            for i in range(p.n * p.n):
                if p.grid[i] is not None or i == i1 or i == i2:
                    continue
                ir, ic = p.get_rc(i)
                if can_see(ir, ic, r1, c1) and can_see(ir, ic, r2, c2):
                    local_changes += p.validate_and_set(i, '.', f"{label} domino shadow", self.verbose)
            if local_changes > 0:
                return local_changes
        return 0

    def rule_triomino(self, p):
        """
        MATCH: An unsolved row or column with any number of empty cells.
        ACTION: Any external cell that sees ALL empty cells in the unit must be a dot.
        """
        all_units = (
            [(p.get_row_indices(r), f"Row {r+1}") for r in range(p.n)] +
            [(p.get_col_indices(c), f"Col {string.ascii_uppercase[c]}") for c in range(p.n)]
        )
        for idxs, label in all_units:
            if any(p.grid[i] == 'x' for i in idxs):
                continue
            candidates = [i for i in idxs if p.grid[i] is None]
            if not candidates:
                continue
            cand_coords = [p.get_rc(i) for i in candidates]
            local_changes = 0
            for i in range(p.n * p.n):
                if p.grid[i] is not None or i in idxs:
                    continue
                ir, ic = p.get_rc(i)
                if all(ir == tr or ic == tc or (abs(ir-tr) <= 1 and abs(ic-tc) <= 1)
                       for tr, tc in cand_coords):
                    local_changes += p.validate_and_set(i, '.', f"{label} unit_sees_too_much", self.verbose)
            if local_changes > 0:
                return local_changes
        return 0

    def rule_sees_too_much_pair(self, p):
        """MATCH: Region with exactly 2 empty cells. ACTION: External cells seeing both are dots."""
        return self._sees_too_much_n(p, n_target=2, label_suffix="pair")

    def rule_sees_too_much_trio(self, p):
        """MATCH: Region with exactly 3 empty cells. ACTION: External cells seeing all three are dots."""
        return self._sees_too_much_n(p, n_target=3, label_suffix="trio")

    def rule_sees_too_much(self, p):
        """MATCH: Region with 4+ empty cells. ACTION: External cells seeing all are dots."""
        return self._sees_too_much_n(p, n_min=4, label_suffix="general")

    def _sees_too_much_n(self, p, n_target=None, n_min=None, label_suffix=""):
        changes = 0
        for b_idx in range(2):
            for r_char, r_indices in p.regions[b_idx].items():
                if any(p.grid[i] == 'x' for i in r_indices):
                    continue
                candidates = [i for i in r_indices if p.grid[i] is None]
                if n_target is not None and len(candidates) != n_target:
                    continue
                if n_min is not None and len(candidates) < n_min:
                    continue
                if not candidates:
                    continue
                for i in range(p.n * p.n):
                    if p.grid[i] is not None or i in r_indices:
                        continue
                    ir, ic = p.get_rc(i)
                    if all(ir == tr or ic == tc or (abs(ir-tr) <= 1 and abs(ic-tc) <= 1)
                           for tr, tc in (p.get_rc(c) for c in candidates)):
                        changes += p.validate_and_set(
                            i, '.', f"sees_too_much_{label_suffix} (B{b_idx+1} Reg {r_char})",
                            self.verbose
                        )
        return changes

    def rule_region_contains_region(self, p):
        return self._rule_region_combo_contains_region_combo(p, 1)

    def rule_region_pair_contains_pair(self, p):
        return self._rule_region_combo_contains_region_combo(p, 2)

    def _rule_region_combo_contains_region_combo(self, p, n):
        combo_sets = []
        for b_idx in range(2):
            regions = p.regions[b_idx]
            for chars in combinations(list(regions.keys()), n):
                # Skip if any region in this combo already has its star
                if any(any(p.grid[i] == 'x' for i in regions[c]) for c in chars):
                    continue
                available_idxs = {
                    i for c in chars for i in regions[c] if p.grid[i] is None
                }
                if not available_idxs:
                    continue
                combo_sets.append({
                    'label': f"B{b_idx+1} Combo({','.join(chars)})",
                    'available_idxs': available_idxs,
                    'board': b_idx,
                })

        for i, set_a in enumerate(combo_sets):
            for j, set_b in enumerate(combo_sets):
                if i == j:
                    continue
                if set_a['board'] == set_b['board']:
                    continue
                if set_a['available_idxs'].issubset(set_b['available_idxs']):
                    extra = set_b['available_idxs'] - set_a['available_idxs']
                    local_changes = sum(
                        p.validate_and_set(
                            idx, '.', f"{set_b['label']} contains {set_a['label']}",
                            self.verbose
                        )
                        for idx in extra if p.grid[idx] is None
                    )
                    if local_changes > 0:
                        return local_changes
        return 0

    def rule_1_row(self, p):
        return self._rule_n_unit_region_sync(p, n=1, axis='row')

    def rule_1_col(self, p):
        return self._rule_n_unit_region_sync(p, n=1, axis='col')

    def rule_2_adjacent_rows(self, p):
        return self._rule_n_unit_region_sync(p, n=2, axis='row')

    def rule_2_adjacent_cols(self, p):
        return self._rule_n_unit_region_sync(p, n=2, axis='col')

    def rule_3_adjacent_rows(self, p):
        return self._rule_n_unit_region_sync(p, n=3, axis='row')

    def rule_3_adjacent_cols(self, p):
        return self._rule_n_unit_region_sync(p, n=3, axis='col')

    def rule_many_adjacent_rows(self, p):
        for n in range(4, p.n):
            changes = self._rule_n_unit_region_sync(p, n, axis='row')
            if changes > 0:
                return changes
        return 0

    def rule_many_adjacent_cols(self, p):
        for n in range(4, p.n):
            changes = self._rule_n_unit_region_sync(p, n, axis='col')
            if changes > 0:
                return changes
        return 0

    def _rule_n_unit_region_sync(self, p, n, axis):
        units = p.row_indices if axis == 'row' else p.col_indices
        for b_idx in range(2):
            regions = p.regions[b_idx]
            unsolved_regs = [c for c, idxs in regions.items()
                             if not any(p.grid[i] == 'x' for i in idxs)]
            for start_u in range(p.n - n + 1):
                u_range = range(start_u, start_u + n)
                unit_idxs = set().union(*(units[u] for u in u_range))
                stars_in_window = sum(1 for idx in unit_idxs if p.grid[idx] == 'x')
                required_count = n - stars_in_window
                if required_count <= 0:
                    continue
                avail_in_units = [i for i in unit_idxs if p.grid[i] is None]
                if not avail_in_units:
                    continue

                # Standard: N unsolved regions trapped inside the window
                pinned_regs = [
                    c for c in unsolved_regs
                    if (avail := [i for i in regions[c] if p.grid[i] is None])
                    and all(i in unit_idxs for i in avail)
                ]
                if len(pinned_regs) == required_count:
                    reg_union = set().union(*(regions[c] for c in pinned_regs))
                    local_changes = sum(
                        p.validate_and_set(idx, '.', f"{n}-Reg Pin", self.verbose)
                        for idx in unit_idxs if idx not in reg_union and p.grid[idx] is None
                    )
                    if local_changes > 0:
                        return local_changes

                # Inverse: window units trapped inside N unsolved regions
                covering_regs = {p.cell_to_region[b_idx][i] for i in avail_in_units}
                covering_unsolved = [r for r in covering_regs if r in unsolved_regs]
                if len(covering_unsolved) == required_count:
                    reg_union = set().union(*(regions[c] for c in covering_unsolved))
                    local_changes = sum(
                        p.validate_and_set(idx, '.', f"{n}-Unit Pin", self.verbose)
                        for idx in (reg_union - unit_idxs) if p.grid[idx] is None
                    )
                    if local_changes > 0:
                        return local_changes
        return 0

    def rule_2_disjoint_rows(self, p):
        return self._rule_disjoint_unit_region_sync(p, n=2, axis='row')

    def rule_2_disjoint_cols(self, p):
        return self._rule_disjoint_unit_region_sync(p, n=2, axis='col')

    def rule_3_disjoint_rows(self, p):
        return self._rule_disjoint_unit_region_sync(p, n=3, axis='row')

    def rule_3_disjoint_cols(self, p):
        return self._rule_disjoint_unit_region_sync(p, n=3, axis='col')

    def _rule_disjoint_unit_region_sync(self, p, n, axis):
        """
        MATCH: N disjoint (not necessarily adjacent) units whose available
        cells are covered by exactly N unsolved regions, or vice versa.
        ACTION: Marks cells outside the intersection as dots.
        """
        units = p.row_indices if axis == 'row' else p.col_indices
        for b_idx in range(2):
            regions = p.regions[b_idx]
            unsolved_regs = [c for c, idxs in regions.items()
                             if not any(p.grid[i] == 'x' for i in idxs)]
            for combo in combinations(range(p.n), n):
                unit_idxs = set().union(*(units[u] for u in combo))
                stars_in_window = sum(1 for idx in unit_idxs if p.grid[idx] == 'x')
                required_count = n - stars_in_window
                if required_count <= 0:
                    continue
                avail_in_units = [i for i in unit_idxs if p.grid[i] is None]
                if not avail_in_units:
                    continue

                # Standard: N regions trapped inside these units
                pinned_regs = [
                    c for c in unsolved_regs
                    if (avail := [i for i in regions[c] if p.grid[i] is None])
                    and all(i in unit_idxs for i in avail)
                ]
                if len(pinned_regs) == required_count:
                    reg_union = set().union(*(regions[c] for c in pinned_regs))
                    local_changes = sum(
                        p.validate_and_set(idx, '.', f"Disjoint {n}-Reg Pin ({axis}s {combo})", self.verbose)
                        for idx in unit_idxs if idx not in reg_union and p.grid[idx] is None
                    )
                    if local_changes > 0:
                        return local_changes

                # Inverse: these units trapped inside N regions
                covering_regs = {p.cell_to_region[b_idx][i] for i in avail_in_units}
                covering_unsolved = [r for r in covering_regs if r in unsolved_regs]
                if len(covering_unsolved) == required_count:
                    reg_union = set().union(*(regions[c] for c in covering_unsolved))
                    local_changes = sum(
                        p.validate_and_set(idx, '.', f"Disjoint {n}-Unit Pin (Regs {covering_unsolved})", self.verbose)
                        for idx in (reg_union - unit_idxs) if p.grid[idx] is None
                    )
                    if local_changes > 0:
                        return local_changes
        return 0

    def rule_2_region_pinned_crossboard_rows(self, p):
        return self._rule_crossboard_n_region_pinned(p, n=2, axis='row')

    def rule_2_region_pinned_crossboard_cols(self, p):
        return self._rule_crossboard_n_region_pinned(p, n=2, axis='col')

    def rule_3_region_pinned_crossboard_rows(self, p):
        return self._rule_crossboard_n_region_pinned(p, n=3, axis='row')

    def rule_3_region_pinned_crossboard_cols(self, p):
        return self._rule_crossboard_n_region_pinned(p, n=3, axis='col')

    def _rule_crossboard_n_region_pinned(self, p, n, axis):
        """
        MATCH: N disjoint regions (from any board) whose available cells all
        fall in the same N adjacent rows/cols.
        ACTION: All other cells in those rows/cols are dots.
        """
        unsolved_regions = []
        for b_idx in range(2):
            for r_char, idxs in p.regions[b_idx].items():
                available = [i for i in idxs if p.grid[i] is None]
                if available and not any(p.grid[i] == 'x' for i in idxs):
                    unsolved_regions.append({
                        'label': f"B{b_idx+1}-Reg{r_char}",
                        'all_idxs': set(idxs),
                        'available_idxs': available,
                    })

        if len(unsolved_regions) < n:
            return 0

        for combo in combinations(unsolved_regions, n):
            if not self._are_disjoint([r['all_idxs'] for r in combo]):
                continue
            all_available = [i for r in combo for i in r['available_idxs']]
            occupied_units = {
                p.get_rc(idx)[0] if axis == 'row' else p.get_rc(idx)[1]
                for idx in all_available
            }
            if len(occupied_units) != n:
                continue
            u_list = sorted(occupied_units)
            if u_list[-1] - u_list[0] != n - 1:
                continue

            unit_indices = [
                i for u in u_list
                for i in (p.get_row_indices(u) if axis == 'row' else p.get_col_indices(u))
            ]
            region_union = set().union(*(r['all_idxs'] for r in combo))
            labels = ", ".join(r['label'] for r in combo)
            changes = sum(
                p.validate_and_set(idx, '.', f"Cross-Board {axis.capitalize()} Pin ({labels})", self.verbose)
                for idx in unit_indices if idx not in region_union and p.grid[idx] is None
            )
            if changes > 0:
                return changes
        return 0

    def _are_disjoint(self, set_list):
        seen = set()
        for s in set_list:
            if not s.isdisjoint(seen):
                return False
            seen.update(s)
        return True

    def rule_crossboard_partial_overlap(self, p):
        """
        MATCH: Two regions (one per board) whose non-shared available cells
        all fall in a single row or column.
        ACTION: Those non-shared cells must be dots.
        """
        unsolved_b1 = [c for c, idxs in p.regions[0].items()
                       if not any(p.grid[i] == 'x' for i in idxs)]
        unsolved_b2 = [c for c, idxs in p.regions[1].items()
                       if not any(p.grid[i] == 'x' for i in idxs)]

        for r1_char in unsolved_b1:
            r1_avail = {i for i in p.regions[0][r1_char] if p.grid[i] is None}
            if not r1_avail:
                continue
            for r2_char in unsolved_b2:
                r2_avail = {i for i in p.regions[1][r2_char] if p.grid[i] is None}
                if not r2_avail:
                    continue
                disjoint = (r1_avail - r2_avail) | (r2_avail - r1_avail)
                if not (r1_avail & r2_avail) or not disjoint:
                    continue
                rows = {p.get_rc(idx)[0] for idx in disjoint}
                cols = {p.get_rc(idx)[1] for idx in disjoint}
                if len(rows) != 1 and len(cols) != 1:
                    continue
                changes = sum(
                    p.validate_and_set(idx, '.', f"Cross-board partial overlap R1:{r1_char}/R2:{r2_char}", self.verbose)
                    for idx in disjoint if p.grid[idx] is None
                )
                if changes > 0:
                    return changes
        return 0

    def rule_lookahead_half_stage(self, p):
        """Place star, apply sees_star consequences only, check for contradiction."""
        return self._lookahead_n_stages(p, n_stages=0, extra_half_stage=True)

    def rule_lookahead_1_stage(self, p):
        return self._lookahead_n_stages(p, n_stages=1)

    def rule_lookahead_2_stages(self, p):
        return self._lookahead_n_stages(p, n_stages=2)

    def rule_lookahead_3_stages(self, p):
        return self._lookahead_n_stages(p, n_stages=4)  # note: was 4 in original

    def _lookahead_n_stages(self, p, n_stages, extra_half_stage=False):
        for test_idx in (i for i, val in enumerate(p.grid) if val is None):
            sandbox = copy.deepcopy(p)
            sandbox.grid[test_idx] = 'x'
            broken = False

            for _ in range(n_stages):
                self.rule_sees_star(sandbox, silent=True)
                self.rule_only_empty(sandbox, silent=True)
                if self.is_board_broken(sandbox):
                    broken = True
                    break

            if not broken and extra_half_stage:
                self.rule_sees_star(sandbox, silent=True)
                if self.is_board_broken(sandbox):
                    broken = True

            if broken:
                changes = p.validate_and_set(
                    test_idx, '.', f"{n_stages}-stage Lookahead contradiction", self.verbose
                )
                if changes > 0:
                    return changes
        return 0


# ─────────────────────────────────────────────────────────────────────────────
# Mode wiring & CLI
# ─────────────────────────────────────────────────────────────────────────────

def _build_letter_pair(args, n, output_rows):
    if not args.char1 or not args.char2:
        raise ValueError("--char1 and --char2 are required for letter_pair mode")
    kwargs = dict(reject_singletons=args.reject_singletons,
                  min_solutions=args.min_solutions, max_solutions=args.max_solutions)
    gen_a = LetterGenerator(n, args.char1[0].upper(), **kwargs)
    gen_b = LetterGenerator(n, args.char2[0].upper(), **kwargs)
    return AsymmetricPoolComparator(gen_a, gen_b, n, output_rows)


def _make_gen(cls, args, n):
    """Instantiates a generator class with the shared generation flags."""
    return cls(n, reject_singletons=args.reject_singletons,
               min_solutions=args.min_solutions, max_solutions=args.max_solutions)


# Maps mode names to factory lambdas.
# To add a new mode: add one entry here — argparse choices are derived
# automatically from this dict.
MODES = {
    'random_pair':    lambda a, n, r: SymmetricPoolComparator(_make_gen(RandomGenerator, a, n), n, r),
    'symmetric_pair': lambda a, n, r: SymmetricPoolComparator(_make_gen(SymmetricGenerator, a, n), n, r),
    'self_entangled': lambda a, n, r: SelfComparator(_make_gen(RandomGenerator, a, n), n, r),
    'super_symmetric':lambda a, n, r: SelfComparator(_make_gen(SymmetricGenerator, a, n), n, r),
    'letter_pair':         lambda a, n, r: _build_letter_pair(a, n, r),
    'voting_district_pair': lambda a, n, r: SymmetricPoolComparator(_make_gen(VotingDistrictGenerator, a, n), n, r),
}


def build_comparator(args, output_rows):
    """Constructs the appropriate comparator for the given mode."""
    if args.mode not in MODES:
        raise ValueError(f"Unknown mode: {args.mode}")
    return MODES[args.mode](args, args.n, output_rows)


def run_generation(args):
    output_rows = []
    sol_range = f"{args.min_solutions}..{args.max_solutions if args.max_solutions is not None else '∞'}"
    flags = (f"reject_singletons={'yes' if args.reject_singletons else 'no'}"
             f" | solutions={sol_range}")
    print(f"# Mode: {args.mode} | n={args.n} | count={args.count} | {flags}", flush=True)
    print("name,N,board_1,board_2,solution", flush=True)

    comparator = build_comparator(args, output_rows)
    comparator.run(args.count)

    with open(args.output, 'w', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=['name', 'N', 'board_1', 'board_2', 'solution'])
        writer.writeheader()
        writer.writerows(output_rows)

    if args.score_after:
        score_args = argparse.Namespace(
            input=args.output,
            output="puzzles_scored.csv",
            puzzle=None,
            verbose=False,
        )
        print(f"\n# Scoring {args.output}...", flush=True)
        run_scoring(score_args)

    print(f"\n# Done. {comparator.pairs_found}/{args.count} pairs -> {args.output}", flush=True)


def run_scoring(args):
    input_file = args.input
    output_file = args.output or "puzzles_scored.csv"

    if not os.path.exists(input_file):
        print(f"Error: {input_file} not found.")
        return

    scorer = CompositeScorer(verbose=args.verbose)
    all_results = []
    total, solved_count = 0, 0

    with open(input_file, mode='r') as f:
        reader = csv.DictReader(f)
        original_fieldnames = reader.fieldnames
        for row in reader:
            if args.puzzle and row['name'] != args.puzzle:
                continue
            total += 1
            puzzle = StarBattlePuzzle(
                int(row['N']), row['board_1'], row['board_2'],
                row['solution'], row['name']
            )
            solved, score, tier = scorer.solve(puzzle)
            if solved:
                solved_count += 1
            row['score'] = score
            row['tier'] = tier
            row['is_solved'] = solved
            all_results.append(row)

    # Sort: unsolved last, then by tier order, then by score within tier
    def sort_key(x):
        tier_idx = TIER_ORDER.index(x['tier']) if x['tier'] in TIER_ORDER else len(TIER_ORDER)
        return (tier_idx, x['score'] if x['is_solved'] else float('inf'))

    all_results.sort(key=sort_key)

    # Write CSV
    fieldnames = original_fieldnames + ['score', 'tier', 'is_solved']
    with open(output_file, mode='w', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(all_results)

    # Print grouped table
    current_tier = None
    print(f"\n{'Name':<25} | {'Tier':<12} | {'Score':<8}")
    print("-" * 52)

    for res in all_results:
        tier = res['tier']
        if tier != current_tier:
            current_tier = tier
            print(f"\n  ── {tier} ──")
        score_str = str(res['score']) if res['is_solved'] else "STUCK"
        print(f"  {res['name']:<23} | {tier:<12} | {score_str:<8}")

    # Stats
    solved_scores = [res['score'] for res in all_results if res['is_solved']]
    print("\n" + "=" * 52)
    print("STATISTICS")
    print("=" * 52)
    print(f"Total:   {total}")
    print(f"Solved:  {solved_count} ({(solved_count/total if total > 0 else 0)*100:.1f}%)")
    if solved_scores:
        print(f"Mean score:   {statistics.mean(solved_scores):.1f}")
        print(f"Median score: {statistics.median(solved_scores):.1f}")
        by_tier = {}
        for res in all_results:
            if res['is_solved']:
                by_tier.setdefault(res['tier'], []).append(res['score'])
        print("\nBy tier:")
        for tier in TIER_ORDER:
            if tier in by_tier:
                scores = by_tier[tier]
                print(f"  {tier:<14} {len(scores):>4} puzzles  "
                      f"avg {statistics.mean(scores):.0f}  "
                      f"range [{min(scores)}, {max(scores)}]")
    else:
        print("No puzzles solved.")
    print("=" * 52)
    print(f"Full results written to: {output_file}")


def main():
    parser = argparse.ArgumentParser(
        description="Generate and score Multiverse Star Battle puzzle pairs.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Generation modes:
  random_pair      Two random boards sharing exactly one solution
  symmetric_pair   Two symmetric boards sharing exactly one solution
  self_entangled   One random board paired with its own rotation/reflection
  super_symmetric  One symmetric board paired with its own rotation/reflection
  letter_pair            Two letter-shaped boards (requires --char1 and --char2)
  voting_district_pair   Two boards where every region contains exactly N cells

Examples:
  python3 gen_puzzles.py --mode random_pair --n 8 --count 100
  python3 gen_puzzles.py --mode letter_pair --char1 T --char2 H --n 8 --count 10
  python3 gen_puzzles.py --score --input puzzles.csv
  python3 gen_puzzles.py --score --input puzzles.csv --puzzle puzzle_42 --verbose
        """
    )

    # Score mode flag — if present, runs the scorer instead of the generator
    parser.add_argument("--score", action="store_true",
                        help="Score an existing CSV instead of generating puzzles")

    # Generation args
    parser.add_argument("--mode", choices=list(MODES.keys()),
                        help="Generation mode (required unless --score is set)")
    parser.add_argument("--n", type=int, default=8,
                        help="Board size (default: 8)")
    parser.add_argument("--count", type=int, default=100,
                        help="Number of puzzle pairs to generate (default: 100)")
    parser.add_argument("--char1", type=str, default=None,
                        help="Character for board 1 (letter_pair mode only)")
    parser.add_argument("--char2", type=str, default=None,
                        help="Character for board 2 (letter_pair mode only)")
    parser.add_argument("--reject-singletons", action="store_true",
                        dest="reject_singletons",
                        help="Reject boards where any region contains only one cell")
    parser.add_argument("--min-solutions", type=int, default=2,
                        dest="min_solutions",
                        help="Minimum number of single-board solutions required (default: 2)")
    parser.add_argument("--max-solutions", type=int, default=None,
                        dest="max_solutions",
                        help="Maximum number of single-board solutions allowed (default: unlimited)")
    parser.add_argument("--score-after", action="store_true",
                        dest="score_after",
                        help="Automatically score generated puzzles after generation completes")

    # Shared args
    parser.add_argument("--output", type=str, default=None,
                        help="Output file (default: puzzles.csv for generation, "
                             "puzzles_scored.csv for scoring)")

    # Scoring args
    parser.add_argument("--input", type=str, default="puzzles.csv",
                        help="Input CSV to score (default: puzzles.csv)")
    parser.add_argument("--puzzle", type=str, default=None,
                        help="Score only this named puzzle")
    parser.add_argument("--verbose", action="store_true",
                        help="Print each inference step during scoring")

    args = parser.parse_args()

    if args.score:
        run_scoring(args)
    else:
        if not args.mode:
            parser.error("--mode is required when not using --score")
        if args.output is None:
            args.output = "puzzles.csv"
        run_generation(args)


if __name__ == "__main__":
    main()
