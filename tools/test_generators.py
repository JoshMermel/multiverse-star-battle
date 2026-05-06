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
from font_data import FONT_7x5
from generator import MIN_SOLUTIONS
from random_generator import RandomGenerator
from letter_generator import LetterGenerator, _render_letter
from square_free_generator import SquareFreeGenerator
from symmetric_generator import SymmetricGenerator
from voting_district_generator import VotingDistrictGenerator
from voronoi_generator import VoronoiGenerator


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



@pytest.mark.parametrize("board_size", [6, 7, 8, 9])
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



# ── SymmetricGenerator ────────────────────────────────────────────────────────

SYMMETRY_TYPES = ['mirror', 'diagonal', 'double_mirror', 'rot_90', 'rot_180']

# TODO(jmerm): expand sizes here once other sizes work.
@pytest.mark.parametrize("board_size", [8])
class TestSymmetricGenerator:
    @pytest.fixture(params=SYMMETRY_TYPES)
    def sym_board_solutions(self, request, board_size):
        sym_type = request.param
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
