"""
board_solver.py

OR-Tools CP-SAT solver for Star Battle boards.
Finds all valid 1-star-per-row/col/region placements for a flat integer grid.
"""

from collections import defaultdict
from ortools.sat.python import cp_model

from board_utils import get_neighbors_8


def get_all_solutions(grid, n):
    """
    Finds all valid 1-star-per-row/col/region placements for a flat integer
    grid. Returns a set of solution strings (e.g. 'x...x...').
    """
    model = cp_model.CpModel()
    x = [model.new_bool_var(f'x_{i}') for i in range(n * n)]

    for r in range(n):
        model.add(sum(x[r * n + c] for c in range(n)) == 1)
    for c in range(n):
        model.add(sum(x[r * n + c] for r in range(n)) == 1)

    region_map = defaultdict(list)
    for i, reg_id in enumerate(grid):
        region_map[reg_id].append(x[i])
    for cells in region_map.values():
        model.add(sum(cells) == 1)

    for i in range(n * n):
        for nb in get_neighbors_8(i, n):
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
