from comparator import Comparator

class AsymmetricPoolComparator(Comparator):
    """
    Two-generator pool comparator. Generates from generator_a and matches
    against pooled boards from generator_b. No variant transforms are applied,
    preserving orientation (required for letter boards).
    Suitable for letter_pair mode.

    Pooling is intentionally asymmetric: generator_b boards that don't
    immediately match are retained in a pool for future generator_a boards
    to match against. generator_a boards that don't match are discarded.
    If match rates are very low, the pool may grow large; consider monitoring
    pool size in production use.
    """

    def __init__(self, generator_a, generator_b, n, output_rows, randomize_orientation_for_output=True):
        super().__init__(n, output_rows, randomize_orientation_for_output=randomize_orientation_for_output)
        self.generator_a = generator_a
        self.generator_b = generator_b
        # Pool of (flat_board, solution_set) from generator_b awaiting a match.
        self.pool = []

    def _next_pair(self):
        result_a = self._generate_safe(self.generator_a)
        if result_a is None:
            return
        flat_a, sols_a = result_a

        # Linear scan — acceptable for small pools; consider indexing by
        # solution if pool size becomes a performance concern.
        for i, (pool_flat, pool_sols) in enumerate(self.pool):
            common = sols_a & pool_sols
            if len(common) == 1:
                # pop(i) is safe here because we return immediately after.
                self.pool.pop(i)
                self._emit(self._next_puzzle_name(), flat_a, pool_flat, next(iter(common)))
                return

        result_b = self._generate_safe(self.generator_b)
        if result_b is None:
            return
        flat_b, sols_b = result_b

        common = sols_a & sols_b
        if len(common) == 1:
            self._emit(self._next_puzzle_name(), flat_a, flat_b, next(iter(common)))
        else:
            self.pool.append((flat_b, sols_b))
