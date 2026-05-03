"""
test_generators.py

Tests for all board generator classes.

Run with:
    pytest test_comparators.py -v

Or for a specific generator:
    pytest test_comparators.py -v -k "Symmetric"
"""

import pytest
import random
from unittest.mock import patch

# Verbatim file references
from asymmetric_pool_comparator import AsymmetricPoolComparator
from self_comparator import SelfComparator
from sudoku_comparator import SudokuComparator
from symmetric_pool_comparator import SymmetricPoolComparator
from generator import GenerationError

class MockGenerator:
    """A deterministic generator for testing matching logic."""
    def __init__(self, n, returns=None):
        self.n = n
        self.returns = returns or []
        self.call_count = 0

    def generate(self):
        if self.call_count >= len(self.returns):
            raise GenerationError("Mock exhausted")
        res = self.returns[self.call_count]
        self.call_count += 1
        return res

@pytest.fixture
def output_rows():
    return []

# ── SelfComparator Tests ──────────────────────────────────────────────────────

def test_self_comparator_normalization(output_rows):
    n = 4
    board = "ZZZZYYYYXXXXWWWW"
    sol_match = "x" + "." * 15
    
    with patch('self_comparator.get_board_variants') as mock_variants:
        mock_variants.return_value = [
            (board, {sol_match}),
            ("YYYYZZZZWWWWXXXX", {sol_match}),
        ]
        
        gen = MockGenerator(n, [(board, {sol_match})])
        comp = SelfComparator(gen, n, output_rows)
        comp.randomize_orientation_for_output = False
        comp._next_pair()
        
        assert comp.pairs_found == 1
        # Combined: ZZZZYYYYXXXXWWWW + YYYYZZZZWWWWXXXX
        # Z->A, Y->B, X->C, W->D
        assert output_rows[0]['board_1'] == "AAAABBBBCCCCDDDD"
        assert output_rows[0]['board_2'] == "BBBBAAAADDDDCCCC"

# ── SudokuComparator Tests ────────────────────────────────────────────────────

def test_sudoku_comparator_matches(output_rows):
    n = 9
    gen_board = "ZZZZZZZZZ" * 9
    sol_match = "x" + "." * 80
    
    gen = MockGenerator(n, [(gen_board, {sol_match, "." * 81})])
    comp = SudokuComparator(gen, n, output_rows)
    comp.randomize_orientation_for_output = False
    
    # Override fixed solutions
    comp.sudoku_solutions = {sol_match, "....x" + "." * 76}
    
    comp._next_pair()
    assert comp.pairs_found == 1
    # Check that the fixed sudoku board (board_1) is also normalized starting at 'A'
    assert output_rows[0]['board_1'].startswith("AAA")

# ── SymmetricPoolComparator Tests ─────────────────────────────────────────────

def test_symmetric_pool_matches_transform(output_rows):
    n = 2
    board_1 = "MMNN" 
    board_2 = "OOPP" 
    sol_1 = "x..." 
    sol_2 = ".x.."
    
    gen = MockGenerator(n, [(board_1, {sol_1}), (board_2, {sol_2})])
    comp = SymmetricPoolComparator(gen, n, output_rows)
    comp.randomize_orientation_for_output = False

    comp._next_pair() # Call 1: Adds board_1 to pool
    
    with patch('symmetric_pool_comparator.get_board_variants') as mock_variants:
        # We ensure the variant uses the same labels as board_2 to simulate real behavior
        mock_variants.return_value = [
            (board_2, {sol_2}),
            ("OPOP", {sol_1}), # Corrected: No spaces in mock string
        ] + [("ZZZZ", {"...."})] * 6
        
        comp._next_pair() # Call 2: Matches OPOP against MMNN

    assert comp.pairs_found == 1
    # Combined string for normalization: "OPOPM MNN"
    # O->A, P->B, M->C, N->D
    assert output_rows[0]['board_1'] == "ABAB" 
    assert output_rows[0]['board_2'] == "CCDD"

# ── AsymmetricPoolComparator Tests ────────────────────────────────────────────

def test_asymmetric_pool_behavior(output_rows):
    """
    Tests that boards are pooled when they don't match, and retrieved later,
    respecting the A-B ordering and joint canonicalization.
    """
    n = 4
    # Unique patterns to ensure we can track which board is which
    board_pattern_a = "A" * 8 + "B" * 8
    board_pattern_b = "C" * 8 + "D" * 8
    
    sol_1 = "x" + "." * 15
    sol_2 = "." + "x" + "." * 14
    
    # Sequence of returns:
    # 1. Gen A: sol_1 | Gen B: sol_2 -> No match. sol_2 (board_pattern_b) is pooled.
    # 2. Gen A: sol_2 | Gen B: sol_1 -> Gen A matches the pooled sol_2.
    gen_a = MockGenerator(n, [(board_pattern_a, {sol_1}), (board_pattern_a, {sol_2})])
    gen_b = MockGenerator(n, [(board_pattern_b, {sol_2}), (board_pattern_b, {sol_1})])
    
    comp = AsymmetricPoolComparator(gen_a, gen_b, n, output_rows)
    comp.randomize_orientation_for_output = False
    
    # First call: No match found yet.
    comp._next_pair()
    assert comp.pairs_found == 0
    assert len(comp.pool) == 1
    
    # Second call: Match found between new Gen A and pooled Gen B.
    comp._next_pair()
    assert comp.pairs_found == 1
    
    # Verify Ordering: Gen A must be board_1, Gen B (pooled) must be board_2.
    # Combined for normalization: board_pattern_a + board_pattern_b
    # "AAAAAAAA MMMMMMMM" + "CCCCCCCC DDDDDDDD"
    # 'A' -> 'A', 'B' -> 'B', 'C' -> 'C', 'D' -> 'D'
    res = output_rows[0]
    assert res['board_1'] == board_pattern_a
    assert res['board_2'] == board_pattern_b
    assert res['solution'] == sol_2

# ── Normalization ──────────────────────────────────────────────────────────

def test_comparator_randomization_and_normalization(output_rows):
    """
    Verifies that when randomization is ON, boards are transformed and 
    then correctly canonicalized as a pair.
    """
    n = 2
    # Board 1: [M, M]  Board 2: [N, N]
    #          [M, M]           [N, N]
    board_1 = "MMMM"
    board_2 = "NNNN"
    sol = "x..."
    
    # Simple Concrete Comparator to test base class _emit logic
    class SimpleComp(SymmetricPoolComparator):
        def _next_pair(self):
            self._emit("test", board_1, board_2, sol)

    comp = SimpleComp(None, n, output_rows)
    comp.randomize_orientation_for_output = True
    
    # Seed random for determinism in this specific test
    random.seed(42) 
    comp._next_pair()
    
    row = output_rows[0]
    # Boards should be normalized to A and B regardless of random transform
    assert set(row['board_1']) == {'A'}
    assert set(row['board_2']) == {'B'}
    # Solution should still have exactly one 'x'
    assert row['solution'].count('x') == 1
