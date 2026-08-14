"""
solution_first_generator.py

Generates single-board Star Battle puzzles with EXACTLY ONE solution.

Strategy
--------
1. Generate a valid star placement FIRST (stars_per_unit stars per row/col,
   no two 8-adjacent), via CP-SAT.
2. Grow contiguous regions from those stars via seed_and_grow (see
   solution_first_core for details of the flood+merge approach).
3. Diff-guided repair loop: check how many solutions the board has (capped
   at 2). If there's an unwanted alternate, find a disagreeing cell and
   relocate it into a neighbouring region. Repeat until unique.

See solution_first_core.py for the shared construction/repair primitives.
"""

import random

from board_solver import get_solutions_capped
from generator import Generator, GenerationError
from solution_first_core import (
    MAX_REPAIR_STEPS,
    random_star_placement,
    stars_to_solution_string,
    seed_and_grow,
    attempt_local_repair,
)


class SolutionFirstGenerator(Generator):
    """Solution-first generator for unique-solution single-board puzzles."""

    def __init__(self, n, stars_per_unit=1, size_variation=0.0,
                 small_region_frac=0.0, small_region_weight=0.02,
                 small_region_weight_max=None):
        super().__init__(n)
        self.stars_per_unit = stars_per_unit
        self.size_variation = size_variation
        self.small_region_frac = small_region_frac
        self.small_region_weight = small_region_weight
        self.small_region_weight_max = small_region_weight_max

    def _try_generate(self):
        n = self.n
        stars_per_unit = self.stars_per_unit

        star_cells = random_star_placement(n, stars_per_unit)
        if star_cells is None:
            return None

        result = seed_and_grow(star_cells, n, stars_per_unit, self.size_variation,
                                small_region_frac=self.small_region_frac,
                                small_region_weight=self.small_region_weight,
                                small_region_weight_max=self.small_region_weight_max)
        if result is None:
            return None
        grid, star_groups = result

        star_cells_set = set(star_cells)
        intended_solution = stars_to_solution_string(star_cells_set, n)
        region_stars = {reg_id: frozenset(cells) for reg_id, cells in enumerate(star_groups)}

        for _ in range(MAX_REPAIR_STEPS):
            solutions = get_solutions_capped(grid, n, cap=2, stars_per_unit=stars_per_unit)
            if solutions is None:
                # Search timed out inconclusively -- see get_solutions_capped's
                # docstring. NOT the same as "confirmed unique"; treat this
                # attempt as a loss and let the outer retry loop start fresh.
                return None

            if len(solutions) <= 1:
                # Invariant: the intended solution must always remain valid
                # (regions are seeded at the intended star cells, and
                # attempt_local_repair never displaces protected cells).
                # If it's somehow violated, discard and retry rather than crash.
                if solutions != {intended_solution}:
                    return None
                # min_solutions=1 overrides _make_result's default "must be
                # ambiguous" gate: this generator's whole point is a UNIQUE
                # solution, and `solutions` is already known (from the
                # capped repair-loop solve above) -- passing it through
                # avoids redoing a full uncapped get_all_solutions just to
                # reformat the grid.
                return self._make_result(grid, solutions=solutions, min_solutions=1)

            other = next(s for s in solutions if s != intended_solution)
            if not self._attempt_repair_swap(grid, n, star_cells_set, region_stars, other):
                return None

        return None

    @staticmethod
    def _attempt_repair_swap(grid, n, star_cells_set, region_stars, other_solution):
        other_star_cells = {i for i, ch in enumerate(other_solution) if ch == 'x'}
        disagreement = list(other_star_cells - star_cells_set)
        random.shuffle(disagreement)
        for c in disagreement:
            if attempt_local_repair(grid, n, star_cells_set, region_stars, c):
                return True
        return False


if __name__ == "__main__":
    from board_utils import pretty_print

    print("\n--- Solution-First Generator (N=8, stars_per_unit=1, size_variation=0.0) ---")
    SolutionFirstGenerator.demo(8)

    print("\n--- Solution-First Generator (N=8, stars_per_unit=1, size_variation=2.0) ---")
    gen = SolutionFirstGenerator(8, stars_per_unit=1, size_variation=2.0)
    result = gen.generate()
    if result:
        board_str, solutions = result
        pretty_print(board_str, 8)
        print(f"Solution: {next(iter(solutions))}")

    print("\n--- Solution-First Generator (N=10, stars_per_unit=2, size_variation=1.5) ---")
    gen = SolutionFirstGenerator(10, stars_per_unit=2, size_variation=1.5)
    result = gen.generate()
    if result:
        board_str, solutions = result
        pretty_print(board_str, 10)
        print(f"Solution: {next(iter(solutions))}")
