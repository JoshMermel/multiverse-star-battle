import random
from board_solver import get_all_solutions
from board_utils import ALPHABET, VOID_CHAR, flood_fill, pretty_print
from generator import Generator


class RandomGenerator(Generator):
    """
    Generates a random contiguous-region board.

    Parameters
    ----------
    n : int
        Board side length.  The board will have n regions, one star each.
    n_voids : int, optional
        Number of void cells to place (default 0, preserving existing
        behaviour).  Void positions are chosen once at construction time
        and remain fixed for every generation attempt, so repeated calls
        to generate() always produce boards with the same void mask.
        Void cells are excluded from region assignment and are represented
        by VOID_CHAR ('*') in the returned board string.
    """

    def __init__(self, n, n_voids=0):
        super().__init__(n)
        if n_voids < 0:
            raise ValueError(f"n_voids must be >= 0, got {n_voids}")
        # n seeds + n_voids must fit in the grid; also leave room for n
        # non-void cells to seed the flood-fill (one per region).
        if n_voids > n * n - n:
            raise ValueError(
                f"n_voids={n_voids} leaves too few cells to seed {n} regions "
                f"on a {n}x{n} board"
            )
        self.n_voids = n_voids
        # Pick void positions once; they are fixed for all generation attempts.
        self.void_cells = (
            frozenset(random.sample(range(n * n), n_voids))
            if n_voids > 0
            else frozenset()
        )

    def _try_generate(self):
        n = self.n

        # Initialise the grid: void cells are pre-filled with VOID_CHAR so
        # flood_fill treats them as occupied and never overwrites them.
        grid = [None] * (n * n)
        for i in self.void_cells:
            grid[i] = VOID_CHAR

        # Seeds must land on non-void cells; sample from the live pool only.
        live_cells = [i for i in range(n * n) if i not in self.void_cells]
        if len(live_cells) < n:
            return None  # shouldn't happen given __init__ validation, but safe
        seeds = random.sample(live_cells, n)
        for reg_id, cell in enumerate(seeds):
            grid[cell] = reg_id

        # flood_fill is told to treat VOID_CHAR as the excluded region so it
        # never attempts to expand into or out of void cells.
        grid = flood_fill(grid, n, excluded_region=VOID_CHAR)
        if grid is None:
            return None

        return self._make_result_with_voids(grid)

    def _make_result_with_voids(self, grid):
        """
        Variant of Generator._make_result that handles VOID_CHAR entries.

        Non-void cells hold integer region IDs and are mapped through ALPHABET.
        Void cells hold VOID_CHAR and are passed through unchanged.
        """
        from generator import MIN_SOLUTIONS
        n = self.n
        solutions = get_all_solutions(grid, n)
        if len(solutions) < MIN_SOLUTIONS:
            return None
        board_str = "".join(
            VOID_CHAR if v == VOID_CHAR else ALPHABET[v]
            for v in grid
        )
        return board_str, solutions

    @classmethod
    def demo(cls, n=8, n_voids=0, max_attempts=1000):
        gen = cls(n, n_voids=n_voids)
        board, solutions = gen.generate(max_attempts=max_attempts)
        pretty_print(board, n)
        print(f"Solutions: {len(solutions)}")
        if gen.void_cells:
            print(f"Void cells: {sorted(gen.void_cells)}")


if __name__ == "__main__":
    print("\n--- Random Generator (N=8, no voids) ---")
    RandomGenerator.demo(8)

    print("\n--- Random Generator (N=8, 4 voids) ---")
    RandomGenerator.demo(8, n_voids=4)
