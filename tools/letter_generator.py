import random
from board_solver import get_all_solutions
from board_utils import flood_fill, pretty_print
from font_data import FONT_7x5
from generator import Generator

_LETTER_REGION_ID = 0  # Region 0 is always reserved for the letter shape.


def _render_letter(char, n):
    """
    Returns a partial flat grid (list of int|None) with the letter pixels
    set to _LETTER_REGION_ID. Pixels outside the grid bounds are ignored.
    """
    pixels = FONT_7x5.get(char.upper(), [])
    row_offset = (n - 7) // 2
    col_offset = (n - 5) // 2
    partial = [None] * (n * n)
    for pr, pc in pixels:
        r, c = pr + row_offset, pc + col_offset
        if 0 <= r < n and 0 <= c < n:
            partial[r * n + c] = _LETTER_REGION_ID
    return partial


class LetterGenerator(Generator):
    """
    Generates a board where region 0 is shaped like the given character.
    Other regions flood-fill the remaining space, never overwriting the letter.
    The partial grid is precomputed in __init__ since it is constant for a
    given (char, n).
    """

    def __init__(self, n, char):
        super().__init__(n)
        self.char = char.upper()
        self.partial = _render_letter(self.char, n)
        if not any(v == _LETTER_REGION_ID for v in self.partial):
            raise ValueError(f"Character '{self.char}' has no pixels for n={n}")

    def _try_generate(self):
        n = self.n
        grid = list(self.partial)
        free_cells = [i for i, v in enumerate(grid) if v is None]

        # Need exactly n-1 seeds: one for each non-letter region.
        if len(free_cells) < n - 1:
            return None

        seeds = random.sample(free_cells, n - 1)
        for reg_id, cell in enumerate(seeds, start=1):
            grid[cell] = reg_id

        # excluded_region=0 preserves the letter shape (region 0) during fill.
        grid = flood_fill(grid, n, excluded_region=_LETTER_REGION_ID)
        if grid is None:
            return None

        solutions = get_all_solutions(grid, n)
        return self._make_result(grid, solutions)


if __name__ == "__main__":
    for letter in 'ABCDEFGHIJKLMNOPQRSTUVWXYZ':
        print(f"\n--- Letter Generator: {letter} (N=8) ---")
        gen = LetterGenerator(8, letter)
        board, solutions = gen.generate()
        pretty_print(board, 8)
        print(f"Solutions: {len(solutions)}")
