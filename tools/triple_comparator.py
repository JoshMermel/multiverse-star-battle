from itertools import combinations

from board_utils import get_board_variants
from comparator import Comparator


class TripleComparator(Comparator):
    """
    Single-generator pool comparator that finds GROUPS OF THREE boards with
    the following property:
      - each board is individually ambiguous (more than one valid star
        placement on its own),
      - each pair of the three boards is still ambiguous (more than one
        star placement satisfies both boards at once),
      - but all three boards together pin down exactly one valid star
        placement.

    This is the 3-board analogue of SymmetricPoolComparator, which finds
    ambiguous pairs that become unique together. Here, no pair alone is
    enough — only the full trio resolves the puzzle.

    Parameters
    ----------
    generator : Generator
        Board generator instance.
    n : int
        Board side length.
    output_rows : list
        Accumulator for emitted puzzle rows.
    match_variants : bool, optional
        When True (default), all 8 rotations/reflections of each incoming
        board are checked against pool entries, maximising match
        opportunities. Set to False for boards with fixed void masks:
        rotating a void board produces a different void layout, so only the
        identity orientation should be compared.
    diagonal_alignment : {'any', 'aligned', 'misaligned'}, optional
        Restricts which of the 8 variants of the incoming board are tried,
        same semantics as in SymmetricPoolComparator.

    Pool note
    ---------
    Only individually-ambiguous boards are kept in the pool — a board with a
    unique solution on its own can never participate in a "pair still
    ambiguous, trio unique" group, so it's discarded immediately rather than
    accumulating in the pool.

    Matching is checked pairwise across the whole pool (O(pool^2) per
    incoming board), since the third board's compatibility depends on both
    of the others simultaneously. If match rates are very low, the pool may
    grow large; consider monitoring pool size in production.

    board_1 in emitted triples is always the (possibly transformed) incoming
    board; board_2 and board_3 are the two matched pool entries in their
    original orientation. (This ordering may then be shuffled by
    Comparator._emit if randomize_orientation_for_output is enabled.)
    """

    board_count = 3

    def __init__(self, generator, n, output_rows, match_variants=True, diagonal_alignment='any'):
        super().__init__(n, output_rows)
        self.generator = generator
        self.match_variants = match_variants
        self.diagonal_alignment = diagonal_alignment
        # Pool of (flat_board, solution_set) awaiting two more matches.
        # Only individually-ambiguous boards are ever added.
        self.pool = []

    def _next_pair(self):
        result = self._generate_safe(self.generator)
        if result is None:
            return
        flat, solutions = result

        # A board with a unique solution on its own can never be part of a
        # "pairwise still ambiguous" trio, so skip it entirely.
        if len(solutions) <= 1:
            return

        # Build the list of (board, solution_set) candidates to test against
        # pool entries. With match_variants=True we check all 8
        # rotations/reflections; with False we only check the board as
        # generated (identity transform only).
        if self.match_variants:
            all_variants = get_board_variants(flat, solutions, self.n)
            if self.diagonal_alignment == 'aligned':
                # Preserve the main diagonal: identity (0), rot180 (2), flip_diag (6), flip_antidiag (7)
                candidates = [all_variants[0], all_variants[2], all_variants[6], all_variants[7]]
            elif self.diagonal_alignment == 'misaligned':
                # Map main diagonal to anti-diagonal: rot90 (1), rot270 (3), flip_h (4), flip_v (5)
                candidates = [all_variants[1], all_variants[3], all_variants[4], all_variants[5]]
            else:
                candidates = all_variants
        else:
            candidates = [(flat, solutions)]

        for variant_board, variant_sols in candidates:
            for i, j in combinations(range(len(self.pool)), 2):
                pool_i_flat, pool_i_sols = self.pool[i]
                pool_j_flat, pool_j_sols = self.pool[j]

                # All three pairs must still be ambiguous on their own...
                if len(variant_sols & pool_i_sols) <= 1:
                    continue
                if len(variant_sols & pool_j_sols) <= 1:
                    continue
                if len(pool_i_sols & pool_j_sols) <= 1:
                    continue

                # ...but the trio together must pin down exactly one.
                triple_common = variant_sols & pool_i_sols & pool_j_sols
                if len(triple_common) == 1:
                    # Pop higher index first so the lower index stays valid.
                    self.pool.pop(j)
                    self.pool.pop(i)
                    self._emit(
                        self._next_puzzle_name(),
                        [variant_board, pool_i_flat, pool_j_flat],
                        next(iter(triple_common)),
                    )
                    return

        self.pool.append((flat, solutions))
