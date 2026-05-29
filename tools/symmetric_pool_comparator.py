from board_utils import get_board_variants
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

    def __init__(self, generator, n, output_rows, match_variants=True):
        super().__init__(n, output_rows)
        self.generator = generator
        self.match_variants = match_variants
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
            candidates = get_board_variants(flat, solutions, self.n)
        else:
            candidates = [(flat, solutions)]

        for i, (pool_flat, pool_sols) in enumerate(self.pool):
            for variant_board, variant_sols in candidates:
                common = variant_sols & pool_sols
                if len(common) == 1:
                    # pop(i) is safe here because we return immediately after.
                    self.pool.pop(i)
                    self._emit(self._next_puzzle_name(), variant_board, pool_flat, next(iter(common)))
                    return

        self.pool.append((flat, solutions))
