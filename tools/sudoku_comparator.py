from board_solver import get_all_solutions
from board_utils import ALPHABET
from comparator import Comparator


class SudokuComparator(Comparator):
    """
    Pairs a fixed sudoku-layout board against randomly generated boards.

    Only valid for n=9. On init, a board is built whose 9 regions are the
    nine 3×3 boxes of a standard sudoku grid (regions 0–8, encoded as A–I,
    reading left-to-right, top-to-bottom). All solutions for that fixed
    board are computed once at construction time and reused across all calls.

    _next_pair() repeatedly asks the generator for a new board and checks
    whether it shares exactly one solution with the sudoku board. When a
    match is found the pair is emitted just like every other comparator.
    """

    _SUDOKU_N = 9

    def __init__(self, generator, n, output_rows):
        if n != self._SUDOKU_N:
            raise ValueError(
                f"SudokuComparator only supports n=9, got n={n}"
            )
        super().__init__(n, output_rows)
        self.randomize_orientation_for_output = False
        self.generator = generator

        box = int(n ** 0.5)
        sudoku_grid = [
            (r // box) * box + (c // box)
            for r in range(n) for c in range(n)
        ]
        self.sudoku_flat = "".join(ALPHABET[v] for v in sudoku_grid)
        # Computed once at construction — the sudoku board is fixed.
        self.sudoku_solutions = get_all_solutions(sudoku_grid, n)

    def _next_pair(self):
        result = self._generate_safe(self.generator)
        if result is None:
            return
        flat, solutions = result

        common = solutions & self.sudoku_solutions
        if len(common) == 1:
            self._emit(self._next_puzzle_name(), [flat, self.sudoku_flat], next(iter(common)))
