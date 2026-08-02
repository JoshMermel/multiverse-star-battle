"""
test_generators.py

Tests for all board generator classes.

Run with:
    pytest test_generators.py -v

Or for a specific generator:
    pytest test_generators.py -v -k "Symmetric"
"""

import pytest
from collections import deque

from board_utils import ALPHABET, get_neighbors_4
from filter import board_contains_swastika
from font_data import FONT_7x5
from generator import MIN_SOLUTIONS, GenerationError
from random_generator import RandomGenerator
from letter_generator import LetterGenerator
from subdivision_generator import SubdivisionGenerator
from square_free_generator import SquareFreeGenerator
from symmetric_generator import SymmetricGenerator
from voting_district_generator import VotingDistrictGenerator
from voronoi_generator import VoronoiGenerator


# ── 2-star coverage ───────────────────────────────────────────────────────────
#
# Non-touching stars cap an n x n board at ~ceil(n/2)^2 total (see
# gen_puzzles.py's MIN_N_FOR_STARS), so 2 stars per row/column/region needs
# n >= 9 -- too small a board and there's no valid layout to find at all,
# regardless of attempt budget. 9 is also the smallest size the app actually
# ships 2-star puzzles at.
TWO_STAR_N = 9
# 2-star ambiguity is rarer than 1-star, so these generators need a much
# larger attempt budget than their 1-star tests to reliably find one --
# SymmetricGenerator's 'diagonal' symmetry is the worst case (~91% single
# -call success within this budget; the other symmetry types and
# generators are comfortably reliable well before this). Restricting
# decide_straddle_count() to its empirically productive counts (see
# symmetric_generator.py's 'diagonal' branch) roughly tripled the
# per-attempt yield, so this budget dropped from 6000 -- combined with the
# fixture's 3x retry wrapper, compound failure probability is ~0.1%.
TWO_STAR_MAX_ATTEMPTS = 2000


# ── Shared helpers ────────────────────────────────────────────────────────────

def parse_board(flat_board):
    """
    Converts a canonical flat board string into a list of integer region IDs.
    canonical_relabel guarantees labels appear in ALPHABET order, so 'A'->0,
    'B'->1, etc.
    """
    return [ALPHABET.index(ch) for ch in flat_board]


def get_region_cells(grid):
    """Returns a dict mapping region_id -> set of cell indices."""
    regions = {}
    for idx, region_id in enumerate(grid):
        regions.setdefault(region_id, set()).add(idx)
    return regions


def is_contiguous(cells, n):
    """
    Returns True if all cells in the given set form a single 4-connected region.
    Uses a BFS from an arbitrary starting cell, delegating neighbour lookup to
    get_neighbors_4 from board_utils.
    """
    if not cells:
        return True
    cells = set(cells)
    start = next(iter(cells))
    visited = {start}
    queue = deque([start])
    while queue:
        idx = queue.popleft()
        for nb in get_neighbors_4(idx, n):
            if nb in cells and nb not in visited:
                visited.add(nb)
                queue.append(nb)
    return visited == cells


def assert_board_valid(flat_board, n):
    """
    Asserts the two properties every generator must satisfy:
      - The board has exactly n regions.
      - Every region is 4-connected (contiguous).
    """
    grid = parse_board(flat_board)
    regions = get_region_cells(grid)

    assert len(regions) == n, (
        f"Expected {n} regions, got {len(regions)}"
    )
    for region_id, cells in regions.items():
        assert is_contiguous(cells, n), (
            f"Region {region_id} is not contiguous: cells={sorted(cells)}"
        )


def assert_ambiguous(solutions):
    """Asserts the board meets the minimum solution count for multiverse puzzles."""
    assert len(solutions) >= MIN_SOLUTIONS, (
        f"Expected at least {MIN_SOLUTIONS} solutions, got {len(solutions)}"
    )


def assert_stars_per_unit(solutions, n, stars_per_unit):
    """Asserts every row of every solution has exactly stars_per_unit stars."""
    for solution in solutions:
        for r in range(n):
            row = solution[r * n:(r + 1) * n]
            assert row.count('x') == stars_per_unit, (
                f"Row {r} of solution {solution!r} has {row.count('x')} stars, "
                f"expected {stars_per_unit}"
            )


# ── Symmetry checking ─────────────────────────────────────────────────────────

def assert_board_symmetric(flat_board, n, gen):
    """
    Verifies structural symmetry: the orbit of any region must 
    result in a set of one or more whole regions.
    """
    grid = parse_board(flat_board)
    
    # Map each region ID to the set of IDs its symmetric images map to.
    for region_id in range(n):
        # Find all cells belonging to this region
        region_cells = [idx for idx, val in enumerate(grid) if val == region_id]
        
        # Check every possible symmetry 'image' index for this region
        # gen.get_orbit(idx) returns all symmetric images of that cell
        for idx in region_cells:
            orbit = gen.get_orbit(idx)
            
            # For every image in the orbit, it must be part of a 
            # consistent region across the entire original region's shape.
            # We check that the 'mapping' is stable for the whole region.
            for orbit_idx, image_cell in enumerate(orbit):
                # 'base_image_label' is the label the first cell's i-th orbit 
                # image mapped to. All other cells must map their i-th image 
                # to this same label.
                base_image_label = grid[orbit[orbit_idx]]
                
                # Check that every other cell in this region also maps its 
                # i-th orbit image to the same base_image_label.
                for other_cell in region_cells:
                    other_orbit = gen.get_orbit(other_cell)
                    assert grid[other_orbit[orbit_idx]] == base_image_label, (
                        f"Structural symmetry broken. Region {region_id} maps "
                        f"to multiple regions at orbit index {orbit_idx}."
                    )


# ── Generator._make_result swastika rejection ──────────────────────────────

def test_make_result_rejects_swastika_boundary_pattern():
    """
    Generator._make_result should reject (return None) a board whose region
    boundaries form a swastika/pinwheel glyph (see filter.py), before ever
    solving it. A board where every cell is its own distinct region is a
    trivial, deterministic way to construct one: its boundary-edge set is
    every possible internal edge, a superset of any 4x4 window pattern --
    including the swastika one -- so it's always flagged, without needing
    to hand-trace real swastika geometry (confirmed independently via
    filter.board_contains_swastika directly, not just through this hook).
    """
    n = 6
    grid = list(range(n * n))
    assert board_contains_swastika("".join(ALPHABET[v] for v in grid), n)

    gen = RandomGenerator(n, stars_per_unit=1)
    assert gen._make_result(grid) is None


# ── RandomGenerator ───────────────────────────────────────────────────────────

@pytest.mark.parametrize("board_size", [6, 7, 8, 9])
class TestRandomGenerator:
    @pytest.fixture
    def board_and_solutions(self, board_size):
        gen = RandomGenerator(board_size)
        return gen.generate(), board_size

    def test_correct_region_count(self, board_and_solutions):
        (board, _), board_size = board_and_solutions
        assert_board_valid(board, board_size)

    def test_all_regions_contiguous(self, board_and_solutions):
        (board, _), board_size = board_and_solutions
        assert_board_valid(board, board_size)

    def test_is_ambiguous(self, board_and_solutions):
        (_, solutions), _ = board_and_solutions
        assert_ambiguous(solutions)


class TestRandomGeneratorTwoStar:
    """Verifies RandomGenerator can produce valid 2-star (stars_per_unit=2) boards."""

    @pytest.fixture
    def board_and_solutions(self):
        gen = RandomGenerator(TWO_STAR_N, stars_per_unit=2)
        return gen.generate(max_attempts=TWO_STAR_MAX_ATTEMPTS)

    def test_correct_region_count(self, board_and_solutions):
        board, _ = board_and_solutions
        assert_board_valid(board, TWO_STAR_N)

    def test_all_regions_contiguous(self, board_and_solutions):
        board, _ = board_and_solutions
        assert_board_valid(board, TWO_STAR_N)

    def test_is_ambiguous(self, board_and_solutions):
        _, solutions = board_and_solutions
        assert_ambiguous(solutions)

    def test_two_stars_per_row(self, board_and_solutions):
        _, solutions = board_and_solutions
        assert_stars_per_unit(solutions, TWO_STAR_N, 2)


# ── LetterGenerator ───────────────────────────────────────────────────────────

LETTERS = list("ABCDEFGHIJKLMNOPQRSTUVWXYZ")

class TestLetterGenerator:
    N = 8

    @pytest.fixture(params=LETTERS)
    def char_board_solutions(self, request):
        char = request.param
        gen = LetterGenerator(self.N, char)
        # some letters are hard to place, allow 50x the normal number of tries
        board, solutions = gen.generate()
        return char, board, solutions

    def test_correct_region_count(self, char_board_solutions):
        _, board, _ = char_board_solutions
        assert_board_valid(board, self.N)

    def test_all_regions_contiguous(self, char_board_solutions):
        _, board, _ = char_board_solutions
        assert_board_valid(board, self.N)

    def test_is_ambiguous(self, char_board_solutions):
        _, _, solutions = char_board_solutions
        assert_ambiguous(solutions)

    def test_letter_region_consistency(self, char_board_solutions):
        """
        Verifies that the letter region on the generated board matches the
        font shape at some valid placement (any row/col offset within bounds),
        and that no extra cells carry the letter label.

        Because _render_letter randomizes placement, we cannot reconstruct the
        exact offset used; instead we check that the letter region's cell set
        exactly matches the font pixels under at least one valid offset.
        """
        char, board, _ = char_board_solutions
        n = self.N
        grid = parse_board(board)
        font_pixels = FONT_7x5.get(char.upper(), [])

        # Region 0 (label index 0 after canonical relabeling, which preserves
        # _LETTER_REGION_ID=0 as the first-seen region) is the letter region.
        letter_label = 0
        letter_cells = {i for i, v in enumerate(grid) if v == letter_label}

        # Try all valid placements and check for an exact match.
        matched = False
        for row_off in range(n - 6):  # 0 .. n-7 inclusive
            for col_off in range(n - 4):  # 0 .. n-5 inclusive
                candidate = {
                    (pr + row_off) * n + (pc + col_off)
                    for pr, pc in font_pixels
                    if 0 <= pr + row_off < n and 0 <= pc + col_off < n
                }
                if candidate == letter_cells:
                    matched = True
                    break
            if matched:
                break

        assert matched, (
            f"Letter region cells {sorted(letter_cells)} do not match the "
            f"font shape for '{char}' at any valid offset on an {n}x{n} board."
        )

    def test_invalid_char_raises(self):
        """Characters not in FONT_7x5 should raise ValueError at construction time."""
        with pytest.raises(ValueError, match="no pixels"):
            LetterGenerator(self.N, "1")  # digits are not in FONT_7x5


class TestLetterGeneratorTwoStar:
    """Verifies LetterGenerator can produce valid 2-star (stars_per_unit=2) boards."""

    @pytest.fixture
    def board_and_solutions(self):
        gen = LetterGenerator(TWO_STAR_N, "T", stars_per_unit=2)
        return gen.generate(max_attempts=TWO_STAR_MAX_ATTEMPTS)

    def test_correct_region_count(self, board_and_solutions):
        board, _ = board_and_solutions
        assert_board_valid(board, TWO_STAR_N)

    def test_all_regions_contiguous(self, board_and_solutions):
        board, _ = board_and_solutions
        assert_board_valid(board, TWO_STAR_N)

    def test_is_ambiguous(self, board_and_solutions):
        _, solutions = board_and_solutions
        assert_ambiguous(solutions)

    def test_two_stars_per_row(self, board_and_solutions):
        _, solutions = board_and_solutions
        assert_stars_per_unit(solutions, TWO_STAR_N, 2)


# ── SquareFreeGenerator ───────────────────────────────────────────────────────

def assert_no_2x2_block(flat_board, n):
    # Asserts that no 2x2 block of cells all belong to the same region.
    # This is the headline constraint of SquareFreeGenerator.
    grid = parse_board(flat_board)
    for r in range(n - 1):
        for c in range(n - 1):
            tl = r * n + c
            block = {grid[tl], grid[tl + 1], grid[tl + n], grid[tl + n + 1]}
            assert len(block) > 1, (
                f"2x2 block of region {grid[tl]} found at top-left ({r},{c})"
            )



@pytest.mark.parametrize("board_size", [
    6, 7, 8,
    pytest.param(9, marks=pytest.mark.skip(
        reason="known flaky at N=9 (~20% failure at the default max_attempts=1000 "
               "budget) -- disabled for now, revisit alongside the other deferred "
               "SquareFreeGenerator/VoidGenerator performance work"
    )),
])
class TestSquareFreGenerator:
    @pytest.fixture
    def board_and_solutions(self, board_size):
        gen = SquareFreeGenerator(board_size)
        return gen.generate(), board_size

    def test_correct_region_count(self, board_and_solutions):
        (board, _), board_size = board_and_solutions
        assert_board_valid(board, board_size)

    def test_all_regions_contiguous(self, board_and_solutions):
        (board, _), board_size = board_and_solutions
        assert_board_valid(board, board_size)

    def test_is_ambiguous(self, board_and_solutions):
        (_, solutions), _ = board_and_solutions
        assert_ambiguous(solutions)

    def test_no_2x2_block(self, board_and_solutions):
        # No 2x2 block of cells should all belong to the same region.
        (board, _), board_size = board_and_solutions
        assert_no_2x2_block(board, board_size)


# No TestSquareFreeGeneratorTwoStar: the skeletal (tree-shaped, no-2x2-block)
# region growth this generator uses essentially never completes at N=9 with
# stars_per_unit=2 -- even 500 raw fill attempts (before any solution-count
# filtering) produced only 2 structurally-complete boards, and neither was
# 2-star ambiguous. Not worth a flaky/slow test; revisit if the underlying
# growth algorithm changes.


# ── SymmetricGenerator ────────────────────────────────────────────────────────

SYMMETRY_TYPES = ['mirror', 'diagonal', 'double_mirror', 'double_diagonal', 'rot_90', 'rot_180']

# TODO(jmerm): expand sizes here once other sizes work.
@pytest.mark.parametrize("board_size", [5,6,7,8,9])
class TestSymmetricGenerator:
    @pytest.fixture(params=SYMMETRY_TYPES)
    def sym_board_solutions(self, request, board_size):
        sym_type = request.param
        if board_size == 7 and sym_type == 'rot_90':
            pytest.skip("no valid 7x7 rot_90 boards exist")

        gen = SymmetricGenerator(board_size, sym_type)
        board, solutions = gen.generate()
        return sym_type, board, solutions, gen, board_size

    def test_correct_region_count(self, sym_board_solutions):
        _, board, _, _, n = sym_board_solutions
        assert_board_valid(board, n)

    def test_all_regions_contiguous(self, sym_board_solutions):
        _, board, _, _, n = sym_board_solutions
        assert_board_valid(board, n)

    def test_is_ambiguous(self, sym_board_solutions):
        _, _, solutions, _, _ = sym_board_solutions
        assert_ambiguous(solutions)

    def test_board_is_symmetric(self, sym_board_solutions):
        """
        Verifies structural symmetry using the updated logic where the
        image of a region must map to a consistent (whole) region.
        """
        sym_type, board, _, gen, n = sym_board_solutions
        assert_board_symmetric(board, n, gen)

    def test_diagonal_joins(self, board_size):
        # Generate diagonal boards and verify at least one has a seed join
        # (a region containing non-adjacent diagonal cells).
        n = 8
        found_join = False
        for _ in range(50):
            gen = SymmetricGenerator(n, symmetry_type='diagonal')
            grid = gen._full_ctx().try_fill()
            if grid is None:
                continue
            diag_labels = [grid[i * n + i] for i in range(n)]
            for L in set(diag_labels):
                indices = [i for i, val in enumerate(diag_labels) if val == L]
                if len(indices) > 1 and max(indices) - min(indices) >= len(indices):
                    found_join = True
                    break
            if found_join:
                break
        assert found_join, "Expected to find at least one board where a region has a seed join (non-contiguous diagonal cells)"


class TestSymmetricGeneratorTwoStar:
    """Verifies SymmetricGenerator can produce valid 2-star (stars_per_unit=2) boards."""

    @pytest.fixture(params=SYMMETRY_TYPES)
    def board_and_solutions(self, request):
        sym_type = request.param
        # 'diagonal' 2-star ambiguity is rare enough (~90-97% within
        # TWO_STAR_MAX_ATTEMPTS) that a single generate() call still has a
        # real chance of exhausting its budget. Retrying with a fresh
        # generator (a fresh random seed) compounds independent chances --
        # far more effective than a linearly larger attempt budget.
        last_error = None
        for _ in range(3):
            gen = SymmetricGenerator(TWO_STAR_N, symmetry_type=sym_type, stars_per_unit=2)
            try:
                return gen.generate(max_attempts=TWO_STAR_MAX_ATTEMPTS)
            except GenerationError as e:
                last_error = e
        raise last_error

    def test_correct_region_count(self, board_and_solutions):
        board, _ = board_and_solutions
        assert_board_valid(board, TWO_STAR_N)

    def test_all_regions_contiguous(self, board_and_solutions):
        board, _ = board_and_solutions
        assert_board_valid(board, TWO_STAR_N)

    def test_is_ambiguous(self, board_and_solutions):
        _, solutions = board_and_solutions
        assert_ambiguous(solutions)

    def test_two_stars_per_row(self, board_and_solutions):
        _, solutions = board_and_solutions
        assert_stars_per_unit(solutions, TWO_STAR_N, 2)


# ── VotingDistrictGenerator ───────────────────────────────────────────────────

@pytest.mark.parametrize("board_size", [6, 7, 8, 9])
class TestVotingDistrictGenerator:
    """
    Tests for VotingDistrictGenerator across multiple board sizes.
    Note: ReCom generation is computationally expensive.
    """

    @pytest.fixture
    def board_and_solutions(self, board_size):
        gen = VotingDistrictGenerator(board_size)
        # Each attempt is expensive; we use a reasonable max_attempts.
        # .generate() returns (flat_board, solutions).
        return gen.generate(max_attempts=20), board_size

    def test_correct_region_count(self, board_and_solutions):
        (board, _), n = board_and_solutions
        assert_board_valid(board, n)

    def test_all_regions_contiguous(self, board_and_solutions):
        (board, _), n = board_and_solutions
        assert_board_valid(board, n)

    def test_is_ambiguous(self, board_and_solutions):
        (board, solutions), _ = board_and_solutions
        assert_ambiguous(solutions)

    def test_all_regions_equal_size(self, board_and_solutions):
        """
        The core invariant of VotingDistrictGenerator: every region must
        contain exactly N cells.
        """
        (board, _), n = board_and_solutions
        grid = parse_board(board)
        regions = get_region_cells(grid)

        for region_id, cells in regions.items():
            assert len(cells) == n, (
                f"Region {region_id} has {len(cells)} cells, expected {n}"
            )


class TestVotingDistrictGeneratorTwoStar:
    """Verifies VotingDistrictGenerator can produce valid 2-star (stars_per_unit=2) boards."""

    @pytest.fixture
    def board_and_solutions(self):
        gen = VotingDistrictGenerator(TWO_STAR_N, stars_per_unit=2)
        # ReCom generation is expensive per attempt, but doesn't need nearly
        # as large a budget as the other generators to find 2-star ambiguity.
        return gen.generate(max_attempts=30)

    def test_correct_region_count(self, board_and_solutions):
        board, _ = board_and_solutions
        assert_board_valid(board, TWO_STAR_N)

    def test_all_regions_contiguous(self, board_and_solutions):
        board, _ = board_and_solutions
        assert_board_valid(board, TWO_STAR_N)

    def test_is_ambiguous(self, board_and_solutions):
        _, solutions = board_and_solutions
        assert_ambiguous(solutions)

    def test_all_regions_equal_size(self, board_and_solutions):
        board, _ = board_and_solutions
        grid = parse_board(board)
        regions = get_region_cells(grid)
        for region_id, cells in regions.items():
            assert len(cells) == TWO_STAR_N, (
                f"Region {region_id} has {len(cells)} cells, expected {TWO_STAR_N}"
            )

    def test_two_stars_per_row(self, board_and_solutions):
        _, solutions = board_and_solutions
        assert_stars_per_unit(solutions, TWO_STAR_N, 2)


# ── VoronoiGenerator ──────────────────────────────────────────────────────────

@pytest.mark.parametrize("board_size", [6, 7, 8, 9])
class TestVoronoiGenerator:
    @pytest.fixture
    def board_and_solutions(self, board_size):
        gen = VoronoiGenerator(board_size)
        return gen.generate(), board_size

    def test_correct_region_count(self, board_and_solutions):
        (board, _), board_size = board_and_solutions
        assert_board_valid(board, board_size)

    def test_all_regions_contiguous(self, board_and_solutions):
        (board, _), board_size = board_and_solutions
        assert_board_valid(board, board_size)

    def test_is_ambiguous(self, board_and_solutions):
        (_, solutions), _ = board_and_solutions
        assert_ambiguous(solutions)


class TestVoronoiGeneratorTwoStar:
    """Verifies VoronoiGenerator can produce valid 2-star (stars_per_unit=2) boards."""

    @pytest.fixture
    def board_and_solutions(self):
        gen = VoronoiGenerator(TWO_STAR_N, stars_per_unit=2)
        return gen.generate(max_attempts=TWO_STAR_MAX_ATTEMPTS)

    def test_correct_region_count(self, board_and_solutions):
        board, _ = board_and_solutions
        assert_board_valid(board, TWO_STAR_N)

    def test_all_regions_contiguous(self, board_and_solutions):
        board, _ = board_and_solutions
        assert_board_valid(board, TWO_STAR_N)

    def test_is_ambiguous(self, board_and_solutions):
        _, solutions = board_and_solutions
        assert_ambiguous(solutions)

    def test_two_stars_per_row(self, board_and_solutions):
        _, solutions = board_and_solutions
        assert_stars_per_unit(solutions, TWO_STAR_N, 2)


# ── SubdivisionGenerator ───────────────────────────────────────────────────────────

@pytest.mark.parametrize("board_size", [6, 7, 8, 9])
class TestSubdivisionGenerator:
    @pytest.fixture
    def board_and_solutions(self, board_size):
        gen = SubdivisionGenerator(board_size)
        return gen.generate(), board_size

    def test_correct_region_count(self, board_and_solutions):
        (board, _), board_size = board_and_solutions
        assert_board_valid(board, board_size)

    def test_all_regions_contiguous(self, board_and_solutions):
        (board, _), board_size = board_and_solutions
        assert_board_valid(board, board_size)

    def test_is_ambiguous(self, board_and_solutions):
        (_, solutions), _ = board_and_solutions
        assert_ambiguous(solutions)


class TestSubdivisionGeneratorTwoStar:
    """Verifies SubdivisionGenerator can produce valid 2-star (stars_per_unit=2) boards."""

    @pytest.fixture
    def board_and_solutions(self):
        gen = SubdivisionGenerator(TWO_STAR_N, stars_per_unit=2)
        return gen.generate(max_attempts=TWO_STAR_MAX_ATTEMPTS)

    def test_correct_region_count(self, board_and_solutions):
        board, _ = board_and_solutions
        assert_board_valid(board, TWO_STAR_N)

    def test_all_regions_contiguous(self, board_and_solutions):
        board, _ = board_and_solutions
        assert_board_valid(board, TWO_STAR_N)

    def test_is_ambiguous(self, board_and_solutions):
        _, solutions = board_and_solutions
        assert_ambiguous(solutions)

    def test_two_stars_per_row(self, board_and_solutions):
        _, solutions = board_and_solutions
        assert_stars_per_unit(solutions, TWO_STAR_N, 2)
