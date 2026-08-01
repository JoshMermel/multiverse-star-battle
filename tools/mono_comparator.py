from comparator import Comparator


class MonoComparator(Comparator):
    """
    Single-generator comparator for classic (non-multiverse) puzzles: takes
    a generator, keeps only the boards it produces with EXACTLY ONE valid
    star placement, and emits each as a standalone single-board puzzle row.

    This is the 1-board counterpart to TripleComparator (and the implicit
    2-board pairwise comparators) -- no pooling or cross-board matching is
    needed, since a board's own uniqueness is the entire acceptance
    criterion.

    Generator note
    ---------------
    Most generators in this codebase (via Generator._make_result) reject
    boards with fewer than MIN_SOLUTIONS solutions, since the rest of the
    pipeline targets multiverse puzzles where per-board ambiguity is the
    point -- such generators will therefore never produce a board this
    comparator accepts. MonoComparator is intended for generators like
    SolutionFirstGenerator that bypass that filter and specifically target
    uniqueness instead. The len(solutions) == 1 check below is still
    performed defensively rather than assumed, so pairing MonoComparator
    with an incompatible generator fails closed (nothing gets emitted,
    rather than emitting an ambiguous board) instead of raising.
    """

    board_count = 1

    def __init__(self, generator, n, output_rows):
        super().__init__(n, output_rows)
        self.generator = generator

    def _next_pair(self):
        result = self._generate_safe(self.generator)
        if result is None:
            return
        flat, solutions = result

        if len(solutions) != 1:
            return

        self._emit(
            self._next_puzzle_name(),
            [flat],
            next(iter(solutions)),
        )
