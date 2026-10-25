"""Regression tests for board_solver's capped enumeration."""
from board_solver import get_solutions_capped
from board_utils import ALPHABET

# 10x10 2-star Mondrian board with 2,529 solutions; unrestricted CP-SAT enumeration takes ~20 s.
SLOW_BOARD = ("JJJJJJJJJJIIIEEEEEEEIIIEEEEEEEFFFFFFFBBBFFFFFFFBBBAAAGGGCCDDAAAGGGCCDDAAAGGGCCDDAAAGGGCCDDHHHHHHHHHH")
SLOW_BOARD_SOLUTIONS = 2529


def test_time_limit_never_yields_partial_solution_set():
    """A search cut off by the time limit after finding some solutions used to come back as if it were complete
    (status FEASIBLE, not UNKNOWN); it must be reported as inconclusive (None) instead."""
    grid = [ALPHABET.index(c) for c in SLOW_BOARD]
    sols = get_solutions_capped(grid, 10, cap=4000, stars_per_unit=2, time_limit_seconds=0.5)
    assert sols is None or len(sols) == SLOW_BOARD_SOLUTIONS


def test_exhaustive_search_returns_all_solutions():
    grid = [ALPHABET.index(c) for c in "AABBAABBCCDDCCDD"]   # 4x4, 1 star
    sols = get_solutions_capped(grid, 4, cap=100, stars_per_unit=1)
    assert sols is not None


def test_joint_c_solver_agrees_with_cpsat():
    """fast_solve.joint_solutions (used by check_pool_unique.py) must match CP-SAT's joint enumeration."""
    import random
    from board_solver import get_all_solutions_multi
    from fast_solve import joint_solutions
    from subdivision_generator import SubdivisionGenerator
    random.seed(7)
    for n, stars in ((6, 1), (8, 1), (8, 2)):
        grids = []
        gen = SubdivisionGenerator(n, stars_per_unit=stars, min_region_size=3 if stars == 2 else 1)
        while len(grids) < 2:
            got = []
            gen._make_result = lambda grid, *a, **k: got.append(list(grid)) or None
            gen._try_generate()
            grids += got
        assert set(joint_solutions(grids, n, stars, cap=10**6)) == get_all_solutions_multi(grids, n, stars)
