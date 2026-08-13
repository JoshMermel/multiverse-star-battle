"""
solution_first_pair_comparator.py

Solution-first construction of MULTIVERSE board groups: board_count boards
that are each individually ambiguous on their own, but whose solution sets
intersect to exactly one placement when taken together, with every proper
subset of boards remaining ambiguous (so every board is necessary).

Strategy
--------
1. Generate one shared valid star placement S via CP-SAT.
2. For each board independently: grow contiguous regions from S's stars
   via seed_and_grow (flood + adjacent-group merge for stars_per_unit>1),
   using a fresh random pattern per board.
3. Diff-guided joint repair loop: find an alternate joint solution T and
   repair just ONE board against it (sufficient to remove T from the
   intersection). Repeat until the joint intersection is {S}.
4. Verify every proper subset of boards is still ambiguous.
"""

import random
from itertools import combinations

from board_solver import get_solutions_capped, get_solutions_capped_multi
from board_utils import ALPHABET
from comparator import Comparator
from filter import board_contains_swastika
from solution_first_core import (
    MAX_REPAIR_STEPS,
    random_star_placement,
    stars_to_solution_string,
    seed_and_grow,
    attempt_local_repair,
)


class SolutionFirstPairComparator(Comparator):
    """Solution-first constructor for individually-ambiguous, jointly-unique board groups."""

    def __init__(self, n, output_rows, board_count=2, stars_per_unit=1,
                 size_variation=0.0, randomize_orientation_for_output=True):
        super().__init__(n, output_rows, randomize_orientation_for_output)
        if board_count < 2:
            raise ValueError(
                "SolutionFirstPairComparator needs board_count >= 2; "
                "use SolutionFirstGenerator for board_count == 1"
            )
        self.board_count = board_count
        self.stars_per_unit = stars_per_unit
        self.size_variation = size_variation

    def _next_pair(self):
        result = self._try_generate_group()
        if result is None:
            return
        boards, solution = result
        self._emit(self._next_puzzle_name(), boards, solution)

    def _try_generate_group(self):
        n = self.n
        stars_per_unit = self.stars_per_unit

        star_cells = random_star_placement(n, stars_per_unit)
        if star_cells is None:
            return None

        star_cells_set = set(star_cells)
        intended_solution = stars_to_solution_string(star_cells_set, n)

        grids = []
        all_star_groups = []
        for _ in range(self.board_count):
            result = seed_and_grow(star_cells, n, stars_per_unit, self.size_variation)
            if result is None:
                return None
            grid, star_groups = result
            grids.append(grid)
            all_star_groups.append(star_groups)

        # All boards share the same star grouping structure (same region count
        # and star assignments), only the Voronoi growth pattern differs.
        # Use the first board's grouping to build region_stars.
        region_stars = {
            reg_id: frozenset(cells)
            for reg_id, cells in enumerate(all_star_groups[0])
        }

        for _ in range(MAX_REPAIR_STEPS):
            joint_solutions = get_solutions_capped_multi(
                grids, n, cap=2, stars_per_unit=stars_per_unit
            )
            if joint_solutions is None:
                # Inconclusive timeout -- see get_solutions_capped_multi's
                # docstring. Treat as a failed attempt, not a confirmed unique
                # intersection.
                return None

            if len(joint_solutions) <= 1:
                # Gracefully handle invariant violations rather than crashing.
                if joint_solutions != {intended_solution}:
                    return None
                if not self._all_proper_subsets_ambiguous(grids, n, stars_per_unit):
                    return None
                board_strs = ["".join(ALPHABET[v] for v in grid) for grid in grids]
                # Cheap structural check, no solving involved -- reject and
                # let the outer retry loop try a fresh group rather than
                # ship a board whose region boundaries form a
                # swastika/pinwheel glyph (see filter.py).
                if any(board_contains_swastika(b, n) for b in board_strs):
                    return None
                return board_strs, intended_solution

            other = next(s for s in joint_solutions if s != intended_solution)
            if not self._attempt_joint_repair(
                grids, n, star_cells_set, region_stars, other
            ):
                return None

        return None

    @staticmethod
    def _attempt_joint_repair(grids, n, star_cells_set, region_stars, other_solution):
        other_star_cells = {i for i, ch in enumerate(other_solution) if ch == 'x'}
        disagreement_cells = list(other_star_cells - star_cells_set)
        candidates = [
            (board_idx, cell)
            for board_idx in range(len(grids))
            for cell in disagreement_cells
        ]
        random.shuffle(candidates)
        for board_idx, cell in candidates:
            if attempt_local_repair(grids[board_idx], n, star_cells_set, region_stars, cell):
                return True
        return False

    @classmethod
    def _all_proper_subsets_ambiguous(cls, grids, n, stars_per_unit):
        for size in range(1, len(grids)):
            for subset in combinations(range(len(grids)), size):
                subset_grids = [grids[i] for i in subset]
                if size == 1:
                    sols = get_solutions_capped(
                        subset_grids[0], n, cap=2, stars_per_unit=stars_per_unit
                    )
                else:
                    sols = get_solutions_capped_multi(
                        subset_grids, n, cap=2, stars_per_unit=stars_per_unit
                    )
                # None means the search couldn't confirm this subset is
                # ambiguous within budget -- can't verify the "requires all
                # boards" property either way, so treat it the same as
                # "found <=1 solutions": we can't stand behind this puzzle.
                if sols is None or len(sols) <= 1:
                    return False
        return True


if __name__ == "__main__":
    from board_utils import pretty_print

    for spu, n, sv in [(1, 8, 0.0), (1, 8, 2.0), (2, 10, 1.5)]:
        print(f"\n--- SolutionFirstPairComparator (N={n}, board_count=2, stars_per_unit={spu}, size_variation={sv}) ---")
        rows = []
        comp = SolutionFirstPairComparator(n, rows, board_count=2, stars_per_unit=spu,
                                           size_variation=sv,
                                           randomize_orientation_for_output=False)
        comp.run(1)
        if rows:
            row = rows[0]
            for i in range(1, comp.board_count + 1):
                print(f"\nBoard {i}:")
                pretty_print(row[f'board_{i}'], n)
            print(f"\nSolution: {row['solution']}")
        else:
            print("Failed to find a matching pair.")
