from functools import reduce
from itertools import combinations

from comparator import Comparator
from board_utils import TRANSFORM_NAMES, get_board_variants


class SelfComparator(Comparator):
    """
    Compares each generated board against combinations of its own rotations
    and reflections, looking for a collection of `num_boards` boards -- the
    original board plus (num_boards - 1) of its own transformed variants --
    such that:

      * every subset of size (num_boards - 1) of the collection is ambiguous
        on its own: the intersection of that subset's solution sets has more
        than one common solution, and
      * the full collection of `num_boards` boards is non-ambiguous: the
        intersection of all their solution sets has exactly one common
        solution.

    Since there are only 8 total transforms (identity + 7 rotations/
    reflections), num_boards must be between 2 and 8 inclusive. num_boards=2
    reproduces the classic SelfComparator behavior (each board individually
    must be ambiguous, i.e. have more than one solution, and the pair
    together must be non-ambiguous).

    At most one collection is emitted per generated board (the first
    matching combination of transforms, in TRANSFORM_NAMES order).
    """

    def __init__(self, generator, n, output_rows, num_boards=2):
        if not (2 <= num_boards <= 8):
            raise ValueError("num_boards must be between 2 and 8 inclusive")
        super().__init__(n, output_rows)
        self.generator = generator
        self.num_boards = num_boards
        self.board_count = num_boards

    def _next_pair(self):
        result = self._generate_safe(self.generator)
        if result is None:
            return
        flat, solutions = result

        variants = get_board_variants(flat, solutions, self.n)

        # variants[0] is the identity (same board/solutions as the original).
        # The remaining (num_boards - 1) members of the collection are drawn
        # from the genuine transforms.
        others = list(zip(TRANSFORM_NAMES[1:], variants[1:]))

        for combo in combinations(others, self.num_boards - 1):
            names = [name for name, _ in combo]
            boards = [flat] + [board for _, (board, _) in combo]
            sol_sets = [solutions] + [sols for _, (_, sols) in combo]

            # Every (num_boards - 1)-sized subset (leave-one-out) must still
            # be ambiguous (more than one shared solution).
            if not self._all_subsets_ambiguous(sol_sets):
                continue

            # The full collection must be non-ambiguous.
            full_common = reduce(lambda a, b: a & b, sol_sets)
            if len(full_common) == 1:
                self._emit(
                    self._next_puzzle_name("_".join(names)),
                    boards,
                    next(iter(full_common)),
                )
                break

    @staticmethod
    def _all_subsets_ambiguous(sol_sets):
        """
        Checks that every subset formed by leaving out exactly one of the
        given solution sets still has more than one common solution.
        """
        count = len(sol_sets)
        for skip in range(count):
            subset = sol_sets[:skip] + sol_sets[skip + 1:]
            common = reduce(lambda a, b: a & b, subset)
            if len(common) <= 1:
                return False
        return True

