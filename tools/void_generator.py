import random
from board_utils import VOID_CHAR, flood_fill, pretty_print
from generator import Generator


class VoidGenerator(Generator):
    """
    Generates a random contiguous-region board with 8-way symmetric voids.
    Ensures the selected void layout can produce valid puzzles with >= 2 solutions
    and avoids layout profiles explicitly flagged on the blocklist.
    """

    def __init__(self, n, n_voids=0):
        super().__init__(n)
        if n_voids < 0:
            raise ValueError(f"n_voids must be >= 0, got {n_voids}")
        if n_voids > n * n - n:
            raise ValueError(
                f"n_voids={n_voids} leaves too few cells to seed {n} regions "
                f"on a {n}x{n} board"
            )
        self.n_voids = n_voids

        # Compute all unique 8-way symmetry orbits for the grid
        self.orbits = self._compute_symmetry_orbits()

        # Find a valid 8-way symmetric void mask that passes trial generation
        self.void_cells = self._generate_and_verify_void_mask()

    def _compute_symmetry_orbits(self):
        """Groups all grid coordinate indices into their unique 8-way symmetry orbits."""
        n = self.n
        visited = set()
        orbits = []

        for r in range(n):
            for c in range(n):
                idx = r * n + c
                if idx in visited:
                    continue

                transformations = {
                    r * n + c,                      # Identity
                    c * n + r,                      # Reflection across main diagonal
                    (n - 1 - r) * n + c,            # Horizontal reflection
                    r * n + (n - 1 - c),            # Vertical reflection
                    (n - 1 - c) * n + r,            # Rotations and other reflections
                    c * n + (n - 1 - r),
                    (n - 1 - r) * n + (n - 1 - c),
                    (n - 1 - c) * n + (n - 1 - r)
                }

                orbits.append(list(transformations))
                visited.update(transformations)

        return orbits

    def _generate_and_verify_void_mask(self):
        """
        Generates 8-way symmetric void profiles until one is proven to 
        successfully produce a puzzle with MIN_SOLUTIONS (>= 2) ambiguity
        and doesn't match layouts registered on the structure blocklist.
        """
        n = self.n
        trial_attempts = 1000 

        # Void layouts (on 9x9) known to starve region generation down to too
        # few valid boards, causing _attempt_fill's solver to churn without
        # finding a workable layout. Skip any candidate that contains one of
        # these as a subset rather than pay for a doomed trial run.
        bad_sets = [{65, 2, 69, 6, 74, 11, 78, 15, 18, 19, 54, 55, 25, 26, 61, 62},
                    {64, 2, 6, 70, 74, 10, 78, 16, 18, 54, 26, 62}]
        center_fence = {31, 39, 41, 49}

        while True:
            current_voids = set()
            available_orbits = list(self.orbits)
            random.shuffle(available_orbits)

            for orbit in available_orbits:
                if len(current_voids) >= self.n_voids:
                    break
                current_voids.update(orbit)

            # --- FILTER GATE 1: Check Known Bad Structural Configurations ---
            if any(bad_set.issubset(current_voids) for bad_set in bad_sets):
                continue

            if center_fence.issubset(current_voids) and 40 not in current_voids:
                continue

            # _attempt_fill reads self.void_cells, so it must be set before calling it.
            self.void_cells = current_voids

            # --- FILTER GATE 2: Solution and Continuity Verification ---
            passed_trial = False
            for _ in range(trial_attempts):
                result = self._attempt_fill()
                if result is not None:
                    passed_trial = True
                    break

            if passed_trial:
                return current_voids

    def _attempt_fill(self):
        """Single puzzle generation pass using the assigned void mask."""
        n = self.n
        grid = [None] * (n * n)
        for cell in self.void_cells:
            if cell < n * n: # Safety bounds check for indices beyond grid space
                grid[cell] = VOID_CHAR

        non_void_indices = [i for i in range(n * n) if i not in self.void_cells]
        if len(non_void_indices) < n:
            return None

        seeds = random.sample(non_void_indices, n)
        for reg_id, cell in enumerate(seeds):
            grid[cell] = reg_id

        grid = flood_fill(grid, n, excluded_region=VOID_CHAR)
        if grid is None:
            return None

        return self._make_result(grid)

    def _try_generate(self):
        """Concrete hook for base class Generator.generate processing loop."""
        return self._attempt_fill()

    @classmethod
    def demo(cls, n=8, n_voids=0, max_attempts=1000):
        gen = cls(n, n_voids=n_voids)
        board, solutions = gen.generate(max_attempts=max_attempts)
        pretty_print(board, n)
        print(f"Solutions: {len(solutions)}")
        if gen.void_cells:
            print(f"Void cells ({len(gen.void_cells)}): {sorted(gen.void_cells)}")


if __name__ == "__main__":
    VoidGenerator.demo(n=8, n_voids=12)
