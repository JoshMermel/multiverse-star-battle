from board_utils import get_board_variants
from comparator import Comparator


class SymmetricPoolComparator(Comparator):
    """
    Single-generator pool comparator. Checks all 8 rotations/reflections of
    each new board against previously unpaired boards in the pool.
    Suitable for random_pair and symmetric_pair modes.

    All generated boards that don't immediately match a pool entry are retained
    in the pool for future boards to match against. If match rates are very
    low, the pool may grow large; consider monitoring pool size in production.

    board_1 in emitted pairs is always the (possibly transformed) incoming
    board; board_2 is the matched pool entry in its original orientation.
    """

    def __init__(self, generator, n, output_rows):
        super().__init__(n, output_rows)
        self.generator = generator
        # Pool of (flat_board, solution_set) awaiting a match.
        self.pool = []

    def _next_pair(self):
        result = self._generate_safe(self.generator)
        if result is None:
            return
        flat, solutions = result

        # Check all 8 transforms of the new board against each pool entry.
        # Linear scan — acceptable for small pools; consider indexing by
        # solution if pool size becomes a performance concern.
        variants = get_board_variants(flat, solutions, self.n)

        for i, (pool_flat, pool_sols) in enumerate(self.pool):
            for variant_board, variant_sols in variants:
                common = variant_sols & pool_sols
                if len(common) == 1:
                    # pop(i) is safe here because we return immediately after.
                    self.pool.pop(i)
                    self._emit(self._next_puzzle_name(), variant_board, pool_flat, next(iter(common)))
                    return

        self.pool.append((flat, solutions))
