from board_utils import get_board_variants
from comparator import Comparator

class AsymmetricPoolComparator(Comparator):
    """
    Two-generator pool comparator. Generates from generator_a and matches
    against pooled boards from generator_b.
    Suitable for letter_pair mode and other asymmetric pairings.

    Pooling is intentionally asymmetric: generator_b boards that don't
    immediately match are retained in a pool for future generator_a boards
    to match against. generator_a boards that don't match are discarded.
    If match rates are very low, the pool may grow large; consider monitoring
    pool size in production use.

    match_variants controls whether all 8 rotations/reflections of generator_a
    boards are tried when matching against the pool. Set to False for letter
    boards and other cases where orientation must be preserved.
    """

    def __init__(self, generator_a, generator_b, n, output_rows,
                 randomize_orientation_for_output=True, match_variants=True):
        super().__init__(n, output_rows, randomize_orientation_for_output=randomize_orientation_for_output)
        self.generator_a = generator_a
        self.generator_b = generator_b
        self.match_variants = match_variants
        # Pool of (flat_board, solution_set) from generator_b awaiting a match.
        self.pool = []

    def _next_pair(self):
        result_a = self._generate_safe(self.generator_a)
        if result_a is None:
            return
        flat_a, sols_a = result_a

        # When match_variants is on, try all 8 orientations of the incoming
        # board against each pool entry. When off, only try the identity.
        candidates = (get_board_variants(flat_a, sols_a, self.n)
                      if self.match_variants else [(flat_a, sols_a)])

        # Linear scan — acceptable for small pools; consider indexing by
        # solution if pool size becomes a performance concern.
        for i, (pool_flat, pool_sols) in enumerate(self.pool):
            for variant_board, variant_sols in candidates:
                common = variant_sols & pool_sols
                if len(common) == 1:
                    # pop(i) is safe here because we return immediately after.
                    self.pool.pop(i)
                    self._emit(self._next_puzzle_name(), variant_board, pool_flat, next(iter(common)))
                    return

        result_b = self._generate_safe(self.generator_b)
        if result_b is None:
            return
        flat_b, sols_b = result_b

        for variant_board, variant_sols in candidates:
            common = variant_sols & sols_b
            if len(common) == 1:
                self._emit(self._next_puzzle_name(), variant_board, flat_b, next(iter(common)))
                return

        self.pool.append((flat_b, sols_b))
