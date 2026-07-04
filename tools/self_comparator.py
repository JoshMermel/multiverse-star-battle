from comparator import Comparator
from board_utils import TRANSFORM_NAMES, get_board_variants


class SelfComparator(Comparator):
    """
    Compares each generated board against its own rotations and reflections.
    Suitable for self_entangled and super_symmetric modes.
    At most one pair is emitted per generated board (the first matching transform).
    """

    def __init__(self, generator, n, output_rows):
        super().__init__(n, output_rows)
        self.generator = generator

    def _next_pair(self):
        result = self._generate_safe(self.generator)
        if result is None:
            return
        flat, solutions = result

        variants = get_board_variants(flat, solutions, self.n)

        # Skip index 0 (identity — same board as original).
        # Emit at most one pair per board (the first matching transform).
        for transform_name, (variant_board, variant_sols) in zip(TRANSFORM_NAMES[1:], variants[1:]):
            common = solutions & variant_sols
            if len(common) == 1:
                self._emit(self._next_puzzle_name(transform_name), [flat, variant_board], next(iter(common)))
                break
