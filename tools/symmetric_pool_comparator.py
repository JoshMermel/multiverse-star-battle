from board_utils import get_board_variants, select_diagonal_variants
from comparator import Comparator


class SymmetricPoolComparator(Comparator):
    """
    Single-generator pool comparator. Checks each new board against previously
    unpaired boards in the pool, then retains unmatched boards for future use.
    Suitable for random_pair and symmetric_pair modes.

    Parameters
    ----------
    generator : Generator
        Board generator instance.
    n : int
        Board side length.
    output_rows : list
        Accumulator for emitted puzzle rows.
    match_variants : bool, optional
        When True (default), all 8 rotations/reflections of each incoming board
        are checked against pool entries, maximising match opportunities.
        Set to False for boards with fixed void masks: rotating a void board
        produces a different void layout, so only the identity orientation
        should be compared.

    Pool note
    ---------
    All generated boards that don't immediately match a pool entry are retained
    in the pool for future boards to match against. If match rates are very
    low, the pool may grow large; consider monitoring pool size in production.

    board_1 in emitted pairs is always the (possibly transformed) incoming
    board; board_2 is the matched pool entry in its original orientation.
    """

    def __init__(self, generator, n, output_rows, match_variants=True, diagonal_alignment='any'):
        super().__init__(n, output_rows)
        self.generator = generator
        self.match_variants = match_variants
        self.diagonal_alignment = diagonal_alignment
        # Pool of (flat_board, solution_set) awaiting a match.
        self.pool = []

    def _next_pair(self):
        result = self._generate_safe(self.generator)
        if result is None:
            return
        flat, solutions = result

        # Build the list of (board, solution_set) candidates to test against
        # pool entries. With match_variants=True we check all 8
        # rotations/reflections; with False we only check the board as
        # generated (identity transform only).
        if self.match_variants:
            all_variants = get_board_variants(flat, solutions, self.n)
            candidates = select_diagonal_variants(all_variants, self.diagonal_alignment)
        else:
            candidates = [(flat, solutions)]

        match = self._match_against_pool(self.pool, candidates)
        if match is not None:
            variant_board, pool_flat, common_sol = match
            self._emit(self._next_puzzle_name(), [variant_board, pool_flat], common_sol)
            return

        self.pool.append((flat, solutions))
