"""
board_solver.py

OR-Tools CP-SAT solver for Star Battle boards.
Finds all valid 1-star-per-row/col/region placements for a flat integer grid.

Void cells (marked with VOID_CHAR in the grid string) belong to no region and
can never hold a star.  They are transparent to all constraints.
"""

from collections import defaultdict
from ortools.sat.python import cp_model

from board_utils import VOID_CHAR, get_neighbors_8


def get_all_solutions(grid, n):
    """
    Finds all valid 1-star-per-row/col/region placements for a flat integer
    grid. Returns a set of solution strings (e.g. 'x...x...').

    Void cells (grid value == VOID_CHAR) are forced to 0 and excluded from
    all row, column, and region constraints.
    """
    model = cp_model.CpModel()
    x = [model.new_bool_var(f'x_{i}') for i in range(n * n)]

    # Force void cells to zero; they can never hold a star.
    void_set = {i for i, v in enumerate(grid) if v == VOID_CHAR}
    for i in void_set:
        model.add(x[i] == 0)

    # Each row and column must contain exactly one star among its non-void cells.
    for r in range(n):
        row_vars = [x[r * n + c] for c in range(n) if (r * n + c) not in void_set]
        model.add(sum(row_vars) == 1)
    for c in range(n):
        col_vars = [x[r * n + c] for r in range(n) if (r * n + c) not in void_set]
        model.add(sum(col_vars) == 1)

    region_map = defaultdict(list)
    for i, reg_id in enumerate(grid):
        if reg_id != VOID_CHAR:
            region_map[reg_id].append(x[i])
    for cells in region_map.values():
        model.add(sum(cells) == 1)

    for i in range(n * n):
        if i in void_set:
            continue
        for nb in get_neighbors_8(i, n):
            if nb not in void_set:
                model.add_implication(x[i], x[nb].negated())

    solver = cp_model.CpSolver()
    solver.parameters.enumerate_all_solutions = True
    collector = _SolutionCollector(x)
    solver.solve(model, collector)
    return collector.solutions


class _SolutionCollector(cp_model.CpSolverSolutionCallback):
    def __init__(self, variables):
        super().__init__()
        self.variables = variables
        self.solutions = set()

    def on_solution_callback(self):
        self.solutions.add("".join('x' if self.value(v) else '.' for v in self.variables))
