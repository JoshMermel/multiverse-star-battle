import random
from board_utils import VOID_CHAR, flood_fill, pretty_print
from generator import Generator


class VoidGenerator(Generator):
    """
    Generates a random contiguous-region board with 8-way symmetric voids.
    Ensures the selected void layout can produce valid puzzles with >= 2 solutions
    and avoids layout profiles explicitly flagged on the blocklist.
    """

    # Void layouts (on 9x9) known to starve region generation down to too
    # few valid boards, causing _attempt_fill's solver to churn without
    # finding a workable layout. Skip any candidate that contains one of
    # these as a subset rather than pay for a doomed trial run.
    _BAD_SETS = [{65, 2, 69, 6, 74, 11, 78, 15, 18, 19, 54, 55, 25, 26, 61, 62},
                 {64, 2, 6, 70, 74, 10, 78, 16, 18, 54, 26, 62}]
    _CENTER_FENCE = {31, 39, 41, 49}

    # Purely structural filtering (no solving), so even a generous bound
    # here is cheap -- exists only to prevent a genuinely-impossible
    # n/n_voids combination from looping forever.
    _MASK_PICK_ATTEMPTS = 10000

    # After this many consecutive failed _try_generate() calls with the
    # current void mask, assume the mask itself (not just bad luck with
    # seeding) is the problem and swap in a fresh candidate. This is what
    # makes mask selection just another kind of retry inside the caller's
    # own generate(max_attempts=...) budget, instead of a separate, hidden,
    # CP-SAT-heavy search that used to run inside __init__ to completion
    # before generate() even started -- for large n_voids that search could
    # take minutes and still fail outright (see the class docstring's
    # sibling commit message for measurements).
    MASK_RETRY_THRESHOLD = 40

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

        # Pick a first candidate void mask. This is purely structural (no
        # solving), so it's cheap; whether it actually produces an
        # ambiguous board is discovered lazily by _try_generate() below,
        # which swaps in a new candidate if this one isn't panning out.
        self.void_cells = self._pick_void_mask()
        if self.void_cells is None:
            raise ValueError(
                f"Could not find any structurally-valid void mask for "
                f"n_voids={n_voids} (n={n}) within {self._MASK_PICK_ATTEMPTS} tries."
            )
        self._failures_with_current_mask = 0

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

    def _pick_void_mask(self):
        """
        Picks a random 8-way symmetric void mask of size >= n_voids,
        skipping any candidate that matches a known-bad structural profile.
        Purely structural -- no solving involved. Returns None if no
        acceptable candidate is found within _MASK_PICK_ATTEMPTS (an
        extremely degenerate n/n_voids combination).
        """
        for _ in range(self._MASK_PICK_ATTEMPTS):
            current_voids = set()
            available_orbits = list(self.orbits)
            random.shuffle(available_orbits)

            for orbit in available_orbits:
                if len(current_voids) >= self.n_voids:
                    break
                current_voids.update(orbit)

            # --- Skip known bad structural configurations ---
            if any(bad_set.issubset(current_voids) for bad_set in self._BAD_SETS):
                continue
            if self._CENTER_FENCE.issubset(current_voids) and 40 not in current_voids:
                continue

            return current_voids

        return None

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
        """
        Concrete hook for base class Generator.generate processing loop.

        Retries the current void mask's seeding first; if it's been
        unproductive for MASK_RETRY_THRESHOLD consecutive attempts, swaps
        in a fresh mask candidate before the next call -- so a genuinely
        unworkable mask doesn't sit there burning the rest of the caller's
        whole max_attempts budget the way it used to inside __init__.
        """
        result = self._attempt_fill()
        if result is not None:
            self._failures_with_current_mask = 0
            return result

        self._failures_with_current_mask += 1
        if self._failures_with_current_mask >= self.MASK_RETRY_THRESHOLD:
            new_mask = self._pick_void_mask()
            if new_mask is not None:
                self.void_cells = new_mask
            self._failures_with_current_mask = 0

        return None

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
