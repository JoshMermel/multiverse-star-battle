from abc import ABC, abstractmethod
import random
from board_solver import get_all_solutions
from board_utils import ALPHABET, VOID_CHAR, pretty_print
from filter import board_contains_swastika

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
    statement, which handles the ambiguity check, solves the board, and
    converts to a string.
    """

    def __init__(self, n, stars_per_unit=1):
        self.n = n
        self.stars_per_unit = stars_per_unit

    def generate(self, max_attempts=1000):
        """
        Public entry point. Calls _try_generate() up to max_attempts times.
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
    def _random_seeds(n):
        """
        Returns a list of N distinct randomly chosen cell indices, one per
        region.  Used as the starting point for flood-fill based generators.
        """
        return random.sample(range(n * n), n)

    def _make_result(self, grid, solutions=None, stars_per_unit=None, min_solutions=None):
        """
        Packages a completed grid into the _try_generate return value.

        If solutions is not provided it is computed here, using
        self.stars_per_unit (set at construction, default 1) unless a
        caller overrides it explicitly.  Returns (flat_board_string,
        solutions) if the board meets the minimum solution-count
        requirement, or None otherwise.

        min_solutions defaults to MIN_SOLUTIONS (>= 2, i.e. "must be
        ambiguous" -- the goal for multiverse puzzles). Pass
        min_solutions=1 for a generator that deliberately produces a
        UNIQUE-solution board instead (e.g. SolutionFirstGenerator).

        grid entries may be either an int region id or VOID_CHAR; void
        cells are passed through unchanged rather than looked up in
        ALPHABET.

        Rejects boards whose region boundaries form a swastika/pinwheel
        glyph (see filter.py's board_contains_swastika) before doing
        anything else -- it's a cheap structural check with no solving
        involved, so it's worth failing fast on before the (usually far
        more expensive) ambiguity solve below.

        Use this as the final return statement in every _try_generate
        implementation.
        """
        n = int(len(grid) ** 0.5)
        board_str = "".join(
            VOID_CHAR if v == VOID_CHAR else ALPHABET[v] for v in grid
        )
        if board_contains_swastika(board_str, n):
            return None

        if stars_per_unit is None:
            stars_per_unit = self.stars_per_unit
        if solutions is None:
            solutions = get_all_solutions(grid, n, stars_per_unit=stars_per_unit)
        if min_solutions is None:
            min_solutions = MIN_SOLUTIONS
        if len(solutions) >= min_solutions:
            return board_str, solutions
        return None

    @classmethod
    def demo(cls, n=8, max_attempts=1000, **constructor_kwargs):
        """
        Instantiates the generator, runs it, and prints the result.

        constructor_kwargs are forwarded to __init__ (e.g. symmetry_type for
        SymmetricGenerator).  max_attempts is forwarded to generate() and
        defaults to 1000 for most generators; VotingDistrictGenerator overrides
        this default via its own demo() classmethod.
        """
        gen = cls(n, **constructor_kwargs)
        board, solutions = gen.generate(max_attempts=max_attempts)
        pretty_print(board, n)
        print(f"Solutions: {len(solutions)}")
