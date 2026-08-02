import random
from board_utils import flood_fill, get_neighbors_4, pretty_print
from font_data import FONT_7x5
from generator import Generator

_LETTER_REGION_ID = 0  # Region 0 is always reserved for the letter shape.


def _render_letter(char, n, row_offset=None, col_offset=None):
    """
    Returns a partial flat grid (list of int|None) with the letter pixels
    set to _LETTER_REGION_ID.

    The font is 7 rows x 5 cols (0-indexed). row_offset and col_offset
    control placement on the board; if not provided they are chosen
    uniformly at random from all positions where the letter fits entirely
    within the n x n grid.

    Raises ValueError if the letter cannot fit on a board of size n.
    """
    if n < 7:
        raise ValueError(f"Board size {n} is too small for the 7x5 font")

    key = char.upper()
    if key not in FONT_7x5:
        raise ValueError(f"Character '{char}' has no pixels in FONT_7x5")
    pixels = FONT_7x5[key]

    if row_offset is None:
        row_offset = random.randint(0, n - 7)
    if col_offset is None:
        col_offset = random.randint(0, n - 5)

    partial = [None] * (n * n)
    for pr, pc in pixels:
        r, c = pr + row_offset, pc + col_offset
        if 0 <= r < n and 0 <= c < n:
            partial[r * n + c] = _LETTER_REGION_ID
    return partial


def _free_components(partial, n):
    """
    Returns a list of free-cell connected components (each a list of indices),
    found by DFS over cells where partial[i] is None using 4-connectivity.
    Letters like 'B' or 'O' enclose interior pockets that are completely
    surrounded by letter pixels and unreachable from the outside — each such
    pocket is its own component.
    """
    visited = set()
    components = []
    for start in range(n * n):
        if partial[start] is not None or start in visited:
            continue
        component = []
        stack = [start]
        visited.add(start)
        while stack:
            idx = stack.pop()
            component.append(idx)
            for nb in get_neighbors_4(idx, n):
                if nb not in visited and partial[nb] is None:
                    visited.add(nb)
                    stack.append(nb)
        components.append(component)
    return components


class LetterGenerator(Generator):
    """
    Generates a board where region 0 is shaped like the given character.
    Other regions flood-fill the remaining space, never overwriting the letter.

    Letters like 'B', 'D', 'O', 'P' enclose interior pockets of free cells
    that are completely surrounded by letter pixels. The seeding step
    guarantees at least one seed lands in every such component, so flood_fill
    can always reach every free cell.

    Placement (row/col offset) is randomized per attempt rather than fixed at
    construction time, giving more chances to escape bad configurations.
    """

    def __init__(self, n, char, stars_per_unit=1):
        super().__init__(n, stars_per_unit=stars_per_unit)
        self.char = char.upper()
        # Validate that the character exists in the font. A falsy check
        # here would also reject FONT_7x5's intentional blank glyph (' ':
        # []), which is present but legitimately empty -- not missing.
        if self.char not in FONT_7x5:
            raise ValueError(f"Character '{self.char}' has no pixels for n={n}")

    @classmethod
    def demo(cls, n=8, **constructor_kwargs):
        """
        Overrides Generator.demo() to handle the required char argument.
        Iterates over all letters if char is not specified.
        """
        char = constructor_kwargs.pop('char', None)
        if char is not None:
            gen = cls(n, char)
            board, solutions = gen.generate()
            pretty_print(board, n)
            print(f"Solutions: {len(solutions)}")
        else:
            for letter in 'ABCDEFGHIJKLMNOPQRSTUVWXYZ':
                print(f"\n--- Letter Generator: {letter} (N={n}) ---")
                gen = cls(n, letter)
                board, solutions = gen.generate()
                pretty_print(board, n)
                print(f"Solutions: {len(solutions)}")

    def _try_generate(self):
        n = self.n
        # Randomize placement each attempt — different offsets may produce
        # fewer or smaller isolated pockets for tricky letters.
        partial = _render_letter(self.char, n)
        grid = list(partial)

        # Find connected components of free cells. Letters with enclosed
        # regions (B, D, O, P, Q, R...) produce multiple components.
        components = _free_components(partial, n)
        n_components = len(components)

        # We need n-1 seeds total (one per non-letter region). If there are
        # more isolated pockets than seeds, this placement is unsolvable.
        n_seeds = n - 1
        if n_components > n_seeds:
            return None

        # Place exactly one seed in each component first to guarantee
        # flood_fill can reach every free cell.
        seeds = set()
        for component in components:
            seed = random.choice(component)
            seeds.add(seed)

        # Distribute remaining seeds randomly across all free cells.
        all_free = [i for i, v in enumerate(partial) if v is None]
        remaining_free = [i for i in all_free if i not in seeds]
        extra_count = n_seeds - n_components
        if extra_count > len(remaining_free):
            return None
        seeds.update(random.sample(remaining_free, extra_count))

        # Region IDs are assigned in arbitrary set-iteration order; the labels
        # just need to be distinct integers in [1, n-1], which this guarantees.
        for reg_id, cell in enumerate(seeds, start=1):
            grid[cell] = reg_id

        # excluded_region=0 preserves the letter shape (region 0) during fill.
        grid = flood_fill(grid, n, excluded_region=_LETTER_REGION_ID)
        if grid is None:
            return None

        return self._make_result(grid)


if __name__ == "__main__":
    LetterGenerator.demo(8)
