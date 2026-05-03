import random
from board_solver import get_all_solutions
from board_utils import flood_fill, pretty_print
from generator import Generator


class RandomGenerator(Generator):
    """Generates a random contiguous-region board."""

    def _try_generate(self):
        n = self.n
        grid = [None] * (n * n)
        seeds = random.sample(range(n * n), n)
        for reg_id, cell in enumerate(seeds):
            grid[cell] = reg_id

        grid = flood_fill(grid, n)
        if grid is None:
            return None

        solutions = get_all_solutions(grid, n)
        return self._make_result(grid, solutions)


if __name__ == "__main__":
    print("\n--- Random Generator (N=8) ---")
    gen = RandomGenerator(8)
    board, solutions = gen.generate()
    pretty_print(board, 8)
    print(f"Solutions: {len(solutions)}")
