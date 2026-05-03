from abc import ABC, abstractmethod
from board_utils import ALPHABET, canonical_relabel

# Boards with fewer than this many solutions are rejected.
# Ambiguity across multiple boards is the goal for multiverse puzzles.
MIN_SOLUTIONS = 2


class GenerationError(RuntimeError):
    """Raised when a Generator fails to produce a valid board within the attempt budget."""
    pass


class Generator(ABC):
    """
    Base class for all board generators.
    Ensures consistent retry logic and interface for solutions.

    Retry layering
    --------------
    generate() is the outer retry loop: it calls _try_generate() up to
    max_attempts times and handles canonicalisation.  Subclasses may
    implement their own inner retry loops inside _try_generate() for
    cheap mechanical retries (e.g. flood-fill failures), but should return
    None rather than raising when a single attempt fails.

    _try_generate() contract
    ------------------------
    Must return (flat_board: str, solutions) on success, or None on failure.
    Subclasses should use _make_result(grid, solutions) as their final return
    statement, which handles the ambiguity check and string conversion.
    """

    def __init__(self, n):
        self.n = n

    def generate(self, max_attempts=1000):
        """
        Public entry point. Calls _try_generate() up to max_attempts times,
        Raises GenerationError if no valid board is found within the budget.
        """
        for _ in range(max_attempts):
            result = self._try_generate()
            if result is not None:
                return result

        raise GenerationError(
            f"{self.__class__.__name__} failed to produce a valid board "
            f"after {max_attempts} attempts for N={self.n}"
        )

    @abstractmethod
    def _try_generate(self):
        """
        Internal method for subclasses to implement.
        Should return (flat_board: str, solutions) on success, or None on failure.
        """
        pass

    # ── Helpers for subclasses ────────────────────────────────────────────────

    @staticmethod
    def _grid_to_str(grid):
        """Converts a flat integer grid to a region-label string using ALPHABET."""
        return "".join(ALPHABET[v] for v in grid)

    @staticmethod
    def _is_ambiguous(solutions):
        """Returns True if the solution set meets the minimum ambiguity requirement."""
        return len(solutions) >= MIN_SOLUTIONS

    @staticmethod
    def _make_result(grid, solutions):
        """
        Packages a completed grid and its solutions into the _try_generate
        return value, or returns None if the board is not sufficiently ambiguous.
        Use this as the final return statement in every _try_generate implementation.
        """
        if len(solutions) >= MIN_SOLUTIONS:
            return "".join(ALPHABET[v] for v in grid), solutions
        return None
