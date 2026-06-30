import random
from board_solver import get_all_solutions
from board_utils import flood_fill, pretty_print
from generator import Generator


class RandomGenerator(Generator):
    """Generates a random contiguous-region board."""

    def _try_generate(self):
        n = self.n
        grid = [None] * (n * n)
        for reg_id, cell in enumerate(self._random_seeds(n)):
            grid[cell] = reg_id

        grid = flood_fill(grid, n)
        if grid is None:
            return None

        return self._make_result(grid)


if __name__ == "__main__":
    print("\n--- Random Generator (N=8) ---")
    RandomGenerator.demo(8)
