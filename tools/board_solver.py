"""
board_solver.py

OR-Tools CP-SAT solver for Star Battle boards.
Finds all valid placements (stars_per_unit stars per row/col/region) for a
flat integer grid. stars_per_unit defaults to 1 (the classic puzzle);
larger values produce denser puzzles.

Void cells (marked with VOID_CHAR in the grid string) belong to no region and
can never hold a star.  They are transparent to all constraints.

Also supports JOINT multi-board solving: given several boards (region
partitions) over the same physical n x n cells, get_all_solutions_multi /
get_solutions_capped_multi find placements valid under EVERY board's region
constraints simultaneously -- i.e. exactly the intersection of each board's
individual solution set. This is how SolutionFirstPairComparator checks
"do these two boards, together, pin down a single placement" without
enumerating each board's solutions separately and intersecting in Python
(which would be far slower for boards with many solutions each).
"""

from collections import defaultdict
from ortools.sat.python import cp_model

from board_utils import VOID_CHAR, get_neighbors_8


def _build_star_model_multi(grids, n, stars_per_unit=2):
    """
    Joint CP-SAT model across one or more board region-partitions of the
    same physical n x n cell grid. Row, column, and adjacency constraints
    are shared (same physical cells, checked once); each board in `grids`
    contributes its own independent "exactly stars_per_unit stars per
    region" constraint set. A solution to this model is valid under every
    board in `grids` simultaneously.

    All boards must share the same void mask (grids[0] is used to
    determine it); this matches the rest of the codebase's convention for
    multiverse boards.

    Returns (model, x) where x is the list of n*n BoolVars, one per cell.
    """
    model = cp_model.CpModel()
    x = [model.new_bool_var(f'x_{i}') for i in range(n * n)]

    # Force void cells to zero; they can never hold a star.
    void_set = {i for i, v in enumerate(grids[0]) if v == VOID_CHAR}
    for i in void_set:
        model.add(x[i] == 0)

    # Each row and column must contain exactly stars_per_unit stars among
    # its non-void cells.
    for r in range(n):
        row_vars = [x[r * n + c] for c in range(n) if (r * n + c) not in void_set]
        model.add(sum(row_vars) == stars_per_unit)
    for c in range(n):
        col_vars = [x[r * n + c] for r in range(n) if (r * n + c) not in void_set]
        model.add(sum(col_vars) == stars_per_unit)

    for i in range(n * n):
        if i in void_set:
            continue
        for nb in get_neighbors_8(i, n):
            # nb > i: "x[i] implies not x[nb]" and "x[nb] implies not x[i]"
            # are the same constraint, so only add each adjacent pair once
            # (matches random_star_placement's model in this same module).
            if nb > i and nb not in void_set:
                model.add_implication(x[i], x[nb].negated())

    # One independent "exactly stars_per_unit stars per region" constraint
    # set per board.
    for grid in grids:
        region_map = defaultdict(list)
        for i, reg_id in enumerate(grid):
            if reg_id != VOID_CHAR:
                region_map[reg_id].append(x[i])
        for cells in region_map.values():
            model.add(sum(cells) == stars_per_unit)

    return model, x


def _build_star_model(grid, n, stars_per_unit=1):
    """Single-board convenience wrapper around _build_star_model_multi."""
    return _build_star_model_multi([grid], n, stars_per_unit)


def get_all_solutions(grid, n, stars_per_unit=1):
    """
    Finds all valid placements (stars_per_unit stars per row/col/region)
    for a flat integer grid. Returns a set of solution strings.

    Void cells (grid value == VOID_CHAR) are forced to 0 and excluded from
    all row, column, and region constraints.
    """
    return get_all_solutions_multi([grid], n, stars_per_unit)


def get_solutions_capped(grid, n, cap=2, stars_per_unit=1):
    """
    Like get_all_solutions, but stops searching as soon as `cap` distinct
    solutions have been found.

    Enumerating every solution is wasteful when the caller only needs to
    know "is this board ambiguous, and if so give me one alternate
    solution to diff against" -- a board that's badly ambiguous can have
    thousands of solutions, and get_all_solutions would enumerate every
    single one before returning. This is the oracle used by
    SolutionFirstGenerator's repair loop, where it's called every
    iteration and only ever needs at most 2 solutions.
    """
    return get_solutions_capped_multi([grid], n, cap, stars_per_unit)


def get_all_solutions_multi(grids, n, stars_per_unit=1):
    """
    Finds every star placement valid under ALL boards in `grids`
    simultaneously -- i.e. the intersection of each board's individual
    solution set. See _build_star_model_multi for the constraint model.
    """
    model, x = _build_star_model_multi(grids, n, stars_per_unit)
    solver = cp_model.CpSolver()
    solver.parameters.enumerate_all_solutions = True
    collector = _SolutionCollector(x)
    solver.solve(model, collector)
    return collector.solutions


def get_solutions_capped_multi(grids, n, cap=2, stars_per_unit=1):
    """
    Like get_all_solutions_multi, but stops as soon as `cap` distinct
    joint solutions have been found. This is the oracle used by
    SolutionFirstPairComparator's repair loop: it only ever needs to know
    whether the intersection has more than one member, and if so, one
    alternate to diff against -- never the full (potentially large)
    intersection.
    """
    model, x = _build_star_model_multi(grids, n, stars_per_unit)
    solver = cp_model.CpSolver()
    solver.parameters.enumerate_all_solutions = True
    collector = _CappedSolutionCollector(x, cap)
    solver.solve(model, collector)
    return collector.solutions


class _SolutionCollector(cp_model.CpSolverSolutionCallback):
    def __init__(self, variables):
        super().__init__()
        self.variables = variables
        self.solutions = set()

    def on_solution_callback(self):
        self.solutions.add("".join('x' if self.value(v) else '.' for v in self.variables))


class _CappedSolutionCollector(cp_model.CpSolverSolutionCallback):
    def __init__(self, variables, cap):
        super().__init__()
        self.variables = variables
        self.cap = cap
        self.solutions = set()

    def on_solution_callback(self):
        self.solutions.add("".join('x' if self.value(v) else '.' for v in self.variables))
        if len(self.solutions) >= self.cap:
            self.stop_search()
