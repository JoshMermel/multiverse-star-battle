from board_utils import get_board_variants, select_diagonal_variants, select_axis_variants
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
    pool size in production use. Since generator_b's boards are the ones
    that get many looks over time (every future generator_a attempt gets a
    shot at the pool, from up to 8 angles if match_variants is on), pass
    whichever generator produces the rarer/harder-to-match boards as
    generator_b -- generator_a's output is one-shot, so it's cheaper to
    treat the "easy" side as disposable.

    match_variants controls whether all 8 rotations/reflections of generator_a
    boards are tried when matching against the pool. Set to False for letter
    boards and other cases where orientation must be preserved.

    diagonal_alignment / axis_alignment (mutually exclusive -- pass at most
    one) further restrict match_variants' 8 orientations down to the 4
    that keep, respectively, generator_a's board on the same diagonal as
    generator_b's, or on the same row/column axis (see
    board_utils.select_diagonal_variants / select_axis_variants for exactly
    what each partition means). Use diagonal_alignment when the boards'
    own symmetry is diagonal-based; axis_alignment when it's mirror- or
    translation-based. Both default to 'any' (no filtering).
    """

    def __init__(self, generator_a, generator_b, n, output_rows,
                 randomize_orientation_for_output=True, match_variants=True,
                 diagonal_alignment='any', axis_alignment='any'):
        super().__init__(n, output_rows, randomize_orientation_for_output=randomize_orientation_for_output)
        if diagonal_alignment != 'any' and axis_alignment != 'any':
            raise ValueError("Pass at most one of diagonal_alignment/axis_alignment, not both.")
        self.generator_a = generator_a
        self.generator_b = generator_b
        self.match_variants = match_variants
        self.diagonal_alignment = diagonal_alignment
        self.axis_alignment = axis_alignment
        # Pool of (flat_board, solution_set) from generator_b awaiting a match.
        self.pool = []

    def _next_pair(self):
        result_a = self._generate_safe(self.generator_a)
        if result_a is None:
            return
        flat_a, sols_a = result_a

        # When match_variants is on, try all 8 orientations of the incoming
        # board against each pool entry (optionally narrowed to 4 by
        # diagonal_alignment/axis_alignment). When off, only try the identity.
        if self.match_variants:
            all_variants = get_board_variants(flat_a, sols_a, self.n)
            if self.diagonal_alignment != 'any':
                candidates = select_diagonal_variants(all_variants, self.diagonal_alignment)
            elif self.axis_alignment != 'any':
                candidates = select_axis_variants(all_variants, self.axis_alignment)
            else:
                candidates = all_variants
        else:
            candidates = [(flat_a, sols_a)]

        # Linear scan — acceptable for small pools; consider indexing by
        # solution if pool size becomes a performance concern.
        match = self._match_against_pool(self.pool, candidates)
        if match is not None:
            variant_board, pool_flat, common_sol = match
            self._emit(self._next_puzzle_name(), [variant_board, pool_flat], common_sol)
            return

        result_b = self._generate_safe(self.generator_b)
        if result_b is None:
            return
        flat_b, sols_b = result_b

        for variant_board, variant_sols in candidates:
            common = variant_sols & sols_b
            if len(common) == 1:
                self._emit(self._next_puzzle_name(), [variant_board, flat_b], next(iter(common)))
                return

        self.pool.append((flat_b, sols_b))
