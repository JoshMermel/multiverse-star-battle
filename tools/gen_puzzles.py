"""
gen_puzzles.py

Puzzle generator and CLI for Multiverse Star Battle.

Generation usage:
    python3 gen_puzzles.py generate --mode random_pair --n 8 --count 100
    python3 gen_puzzles.py generate --mode symmetric_pair --n 8 --count 100
    python3 gen_puzzles.py generate --mode self_entangled --n 8 --count 100
    python3 gen_puzzles.py generate --mode sudoku_pair --n 8 --count 100
    python3 gen_puzzles.py generate --mode super_symmetric --n 8 --count 100
    python3 gen_puzzles.py generate --mode letter_pair --char1 T --char2 H --n 8 --count 10
    python3 gen_puzzles.py generate --mode voting_district_pair --n 8 --count 100
    python3 gen_puzzles.py generate --mode random_pair --n 8 --count 100 --score-after

Scoring usage:
    python3 gen_puzzles.py score --input puzzles.csv
    python3 gen_puzzles.py score --input puzzles.csv --output scored.csv
    python3 gen_puzzles.py score --input puzzles.csv --puzzle puzzle_42 --verbose

Generation output: CSV to stdout and to --output file.
Columns: name, N, board_1 .. board_N, solution (N = comparator.board_count,
which depends on mode — most modes pair 2 boards, but e.g. a triple-matching
mode would have board_1, board_2, board_3).

Scoring output: CSV to --output file (default: puzzles_scored.csv).
Columns: same as the input file (whatever board_1 .. board_N columns it
has), plus score, tier, is_solved.

Module layout
-------------
board_solver.py   OR-Tools CP-SAT solver (get_all_solutions)
board_utils.py    Board geometry: ALPHABET, transforms, get_board_variants, flood_fill
font_data.py      7x5 pixel font for LetterGenerator
scorer.py         StarBattlePuzzle, CompositeScorer, TIER_ORDER
*_generator.py    Various bespoke generators for different board types
*_comparator.py   Various bespoke comparators for styles of board-pairing
gen_puzzles.py    CLI
"""

import argparse
import csv
import os
import statistics
import random

from board_utils import board_columns

# Board generators
from letter_generator import LetterGenerator
from quad_aligned_generator import QuadAlignedGenerator
from random_generator import RandomGenerator
from subdivision_generator import SubdivisionGenerator
from square_free_generator import SquareFreeGenerator
from symmetric_generator import SymmetricGenerator
from venn_generator import VennGenerator
from voronoi_generator import VoronoiGenerator
from voting_district_generator import VotingDistrictGenerator

# Comparators for pairing puzzles
from asymmetric_pool_comparator import AsymmetricPoolComparator
from mono_comparator import MonoComparator
from self_comparator import SelfComparator
from solution_first_generator import SolutionFirstGenerator
from solution_first_pair_comparator import SolutionFirstPairComparator
from symmetric_pool_comparator import SymmetricPoolComparator
from sudoku_comparator import SudokuComparator
from triple_comparator import TripleComparator

# Scoring utils
from scorer import StarBattlePuzzle, CompositeScorer, TIER_ORDER, _TIER_RANK, score_puzzles_parallel
from puzzle_deduper import PuzzleDeduper


# ─────────────────────────────────────────────────────────────────────────────
# Mode wiring & CLI
# ─────────────────────────────────────────────────────────────────────────────

def _build_sudoku_pair(n, output_rows, stars_per_unit=1):
    if n != 9:
        raise ValueError("sudoku_pair mode requires --n 9")
    gen = RandomGenerator(n, stars_per_unit=stars_per_unit)
    return SudokuComparator(gen, n, output_rows, stars_per_unit=stars_per_unit)


def _build_letter_pair(args, n, output_rows):
    if not args.char1 or not args.char2:
        raise ValueError("--char1 and --char2 are required for letter_pair mode")
    gen_a = LetterGenerator(n, args.char1[0].upper(), stars_per_unit=args.stars)
    gen_b = LetterGenerator(n, args.char2[0].upper(), stars_per_unit=args.stars)
    return AsymmetricPoolComparator(gen_a, gen_b, n, output_rows, randomize_orientation_for_output=False, match_variants=False)


def _build_mono(args, n, output_rows):
    gen = SolutionFirstGenerator(n, stars_per_unit=args.stars, size_variation=args.size_variation)
    return MonoComparator(gen, n, output_rows)


def _build_solution_first_pair(args, n, output_rows):
    return SolutionFirstPairComparator(
        n, output_rows, board_count=args.board_count, stars_per_unit=args.stars,
        size_variation=args.size_variation)

# Scratch/dev boilerplate for testing new generators or comparators by hand,
# edited in place per experiment rather than kept as a stable mode. The
# early `return` below is intentional -- this is a scratchpad, not a real
# mode, and the unreachable line after it is kept on purpose as the next
# thing to swap in, not dead code to clean up.
def _build_tmp(args, n, output_rows):
    gen_a = RandomGenerator(n)
    return TripleComparator(gen_a, n, output_rows)
    gen_b = SymmetricGenerator(n, symmetry_type="none", translation_type="hsplit")
    return AsymmetricPoolComparator(gen_a, gen_b, n, output_rows, match_variants=False)


# Maps mode names to factory lambdas.
# To add a new mode: add one entry here — argparse choices are derived
# automatically from this dict.
MODES = {
    'random_pair':          lambda a, n, r: SymmetricPoolComparator(RandomGenerator(n, stars_per_unit=a.stars), n, r),
    'symmetric_pair':       lambda a, n, r: SymmetricPoolComparator(SymmetricGenerator(n, stars_per_unit=a.stars), n, r),
    'self_entangled':       lambda a, n, r: SelfComparator(RandomGenerator(n, stars_per_unit=a.stars), n, r),
    'super_symmetric':      lambda a, n, r: SelfComparator(SymmetricGenerator(n, stars_per_unit=a.stars), n, r),
    'letter_pair':          lambda a, n, r: _build_letter_pair(a, n, r),
    'voting_district_pair': lambda a, n, r: SymmetricPoolComparator(VotingDistrictGenerator(n, stars_per_unit=a.stars), n, r),
    'tmp':                  lambda a, n, r: _build_tmp(a, n, r),
    'sudoku_pair':          lambda a, n, r: _build_sudoku_pair(n, r, stars_per_unit=a.stars),
    'mono':                 lambda a, n, r: _build_mono(a, n, r),
    'solution_first_pair':  lambda a, n, r: _build_solution_first_pair(a, n, r),
}

# Modes whose underlying generator/comparator actually varies its region
# layout by star count (via Generator.stars_per_unit, or a comparator's own
# stars_per_unit passthrough, e.g. SudokuComparator). 'tmp' is excluded
# deliberately -- it's scratch/dev boilerplate for testing new generators,
# edited by hand per experiment, not a stable mode to wire a flag through.
STARS_CAPABLE_MODES = {
    'random_pair', 'symmetric_pair', 'self_entangled', 'super_symmetric',
    'letter_pair', 'voting_district_pair', 'sudoku_pair', 'mono',
    'solution_first_pair',
}

# Smallest board size that can plausibly fit a given star count. Non-touching
# stars (including diagonally) mean an n x n board can hold at most
# ceil(n/2)^2 stars total, since it can be tiled by that many disjoint 2x2
# boxes each holding at most one star. n * stars must stay comfortably under
# that bound, or the row/col/region quotas leave no room to actually place
# regions -- e.g. n=8 with 2 stars hits the bound exactly (16 == 16), which
# is too tight to be satisfiable in practice.
MIN_N_FOR_STARS = {
    2: 9,
}


def _scored_output_path(input_path, explicit_output=None):
    """Derive a scored-output filename from the input path, unless overridden."""
    if explicit_output:
        return explicit_output
    stem, ext = os.path.splitext(input_path)
    return stem + "_scored" + (ext or ".csv")


def _infer_stars_per_unit(n, solution):
    """
    How many stars each row/column/region must contain, inferred directly
    from a puzzle's own solution string -- the most stars found in any one
    row (max rather than row 0, in case row 0 happens to be entirely
    void). Always correct, since the solution is already part of every
    puzzle CSV -- no need to separately track or guess stars_per_unit at
    scoring time the way run_scoring used to (a hardcoded guess).
    """
    return max(
        (solution[r * n:(r + 1) * n].count('x') for r in range(n)),
        default=1,
    ) or 1


def run_generation(args):
    if args.stars != 1 and args.mode not in STARS_CAPABLE_MODES:
        raise ValueError(
            "--stars {0} requires a mode whose region layout actually "
            "varies by star count; {1!r} doesn't support that (supported: "
            "{2}).".format(args.stars, args.mode, ", ".join(sorted(STARS_CAPABLE_MODES)))
        )

    min_n = MIN_N_FOR_STARS.get(args.stars)
    if min_n is not None and args.n < min_n:
        raise ValueError(
            "--stars {0} requires --n >= {1} (an n x n board can hold at "
            "most ~ceil(n/2)^2 non-touching stars, so n={2} can't fit "
            "{0} stars per row/column/region).".format(args.stars, min_n, args.n)
        )

    # Every generator/comparator in this codebase draws from the shared
    # global `random` module (no per-instance RNG), so seeding it once here
    # makes an entire run fully reproducible -- rerun with the same --seed
    # to get byte-identical output, e.g. to investigate a specific reported
    # bad board. Always printed (not just when explicitly passed) so any
    # run can be reproduced after the fact, not just ones where reproducing
    # was anticipated in advance.
    seed = args.seed if args.seed is not None else random.SystemRandom().randrange(2**32)
    random.seed(seed)

    output_rows = []
    print("# Mode: {0} | n={1} | count={2} | stars={3} | seed={4}".format(
        args.mode, args.n, args.count, args.stars, seed), flush=True)

    comparator = MODES[args.mode](args, args.n, output_rows)

    board_cols = [f'board_{i}' for i in range(1, comparator.board_count + 1)]
    fieldnames = ['name', 'N'] + board_cols + ['solution']
    print(",".join(fieldnames), flush=True)

    comparator.run(args.count)

    with open(args.output, 'w', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(output_rows)

    if args.score_after:
        # Reuse the generate namespace but override the scoring-specific fields.
        args.input = args.output
        args.output = _scored_output_path(args.output)
        args.puzzle = None
        # Generation already deduped; no need to repeat the work.
        args.skip_dedup = True
        print("\n# Scoring {0}...".format(args.input), flush=True)
        run_scoring(args)

    print("\n# Done. {0}/{1} pairs -> {2}".format(
        comparator.pairs_found, args.count, args.output), flush=True)


def run_scoring(args):
    input_file = args.input
    output_file = _scored_output_path(input_file, args.output)

    if not os.path.exists(input_file):
        print("Error: {0} not found.".format(input_file))
        return

    deduper = None if getattr(args, 'skip_dedup', False) else PuzzleDeduper()
    all_results = []
    # (row_index into all_results, n, boards, solution, stars_per_unit) for
    # every row that survives dedup -- deduper.is_duplicate/register must
    # stay a strictly sequential pass (it depends on accumulated state
    # across rows), so this loop is never parallelized; only the actual
    # scorer.solve() calls below are.
    to_score = []
    skipped_count = 0

    with open(input_file, mode='r') as f:
        reader = csv.DictReader(f)
        original_fieldnames = reader.fieldnames or []
        board_cols = board_columns(original_fieldnames)
        if not board_cols:
            print("Error: no board_N columns found in {0}.".format(input_file))
            return
        for row in reader:
            if args.puzzle and row['name'] != args.puzzle:
                continue
            n = int(row['N'])
            boards = [row[c] for c in board_cols]
            if deduper is not None:
                if deduper.is_duplicate(boards, n):
                    skipped_count += 1
                    continue
                deduper.register(boards, n)
            row_idx = len(all_results)
            all_results.append(row)
            stars_per_unit = _infer_stars_per_unit(n, row['solution'])
            to_score.append((row_idx, n, boards, row['solution'], stars_per_unit))

    total = len(to_score)
    solved_count = 0

    if args.verbose or total <= 1:
        # Sequential: verbose per-deduction logging would interleave
        # unreadably across worker processes, and a single puzzle isn't
        # worth process-pool startup overhead.
        scorer = CompositeScorer(verbose=args.verbose)
        for row_idx, n, boards, solution, stars_per_unit in to_score:
            row = all_results[row_idx]
            puzzle = StarBattlePuzzle(
                n, boards, solution, row['name'], stars_per_unit=stars_per_unit)
            solved, score, tier = scorer.solve(puzzle)
            if solved:
                solved_count += 1
            row['score'] = score
            row['tier'] = tier
            row['is_solved'] = solved
    else:
        # Scoring is embarrassingly parallel (each puzzle solves
        # independently), so hand the batch to a process pool. Keyed by
        # row_idx rather than row['name'] since puzzle names aren't
        # guaranteed unique within a batch.
        specs = [
            (str(row_idx), n, boards, solution, stars_per_unit)
            for row_idx, n, boards, solution, stars_per_unit in to_score
        ]
        results = score_puzzles_parallel(specs)
        for row_idx, n, boards, solution, stars_per_unit in to_score:
            row = all_results[row_idx]
            solved, score, tier, error = results[str(row_idx)]
            if error:
                raise ValueError(f"Logic error scoring {row['name']}: {error}")
            if solved:
                solved_count += 1
            row['score'] = score
            row['tier'] = tier
            row['is_solved'] = solved

    def sort_key(x):
        tier_idx = _TIER_RANK.get(x['tier'], len(TIER_ORDER))
        return (tier_idx, x['score'] if x['is_solved'] else float('inf'))

    all_results.sort(key=sort_key)

    new_fields = ['score', 'tier', 'is_solved']
    fieldnames = original_fieldnames + [f for f in new_fields if f not in original_fieldnames]
    with open(output_file, mode='w', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(all_results)

    current_tier = None
    print("\n{0:<25} | {1:<12} | {2:<8}".format('Name', 'Tier', 'Score'))
    print("-" * 52)

    for res in all_results:
        tier = res['tier']
        if tier != current_tier:
            current_tier = tier
            print("\n  -- {0} --".format(tier))
        score_str = str(res['score']) if res['is_solved'] else "STUCK"
        print("  {0:<23} | {1:<12} | {2:<8}".format(res['name'], tier, score_str))

    solved_scores = [res['score'] for res in all_results if res['is_solved']]
    print("\n" + "=" * 52)
    print("STATISTICS")
    print("=" * 52)
    print("Total:   {0}".format(total))
    if skipped_count:
        print("Skipped (duplicates): {0}".format(skipped_count))
    pct = (solved_count / total * 100) if total > 0 else 0
    print("Solved:  {0} ({1:.1f}%)".format(solved_count, pct))
    if solved_scores:
        print("Mean score:   {0:.1f}".format(statistics.mean(solved_scores)))
        print("Median score: {0:.1f}".format(statistics.median(solved_scores)))
        by_tier = {}
        for res in all_results:
            if res['is_solved']:
                by_tier.setdefault(res['tier'], []).append(res['score'])
        print("\nBy tier:")
        for tier in TIER_ORDER:
            if tier in by_tier:
                scores = by_tier[tier]
                print("  {0:<14} {1:>4} puzzles  avg {2:.0f}  range [{3}, {4}]".format(
                    tier, len(scores), statistics.mean(scores), min(scores), max(scores)))
    else:
        print("No puzzles solved.")
    print("=" * 52)
    print("Full results written to: {0}".format(output_file))


def main():
    parser = argparse.ArgumentParser(
        description="Generate and score Multiverse Star Battle puzzle pairs.",
    )
    sub = parser.add_subparsers(dest="command", metavar="COMMAND")
    sub.required = True

    # ── generate subcommand ───────────────────────────────────────────────────
    gen_p = sub.add_parser(
        "generate",
        help="Generate puzzle pairs",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        description="""
Generate Multiverse Star Battle puzzle pairs and write them to a CSV.

Modes:
  random_pair            Two random boards sharing exactly one solution
  symmetric_pair         Two symmetric boards sharing exactly one solution
  self_entangled         One random board paired with its own rotation/reflection
  super_symmetric        One symmetric board paired with its own rotation/reflection
  letter_pair            Two letter-shaped boards (requires --char1 and --char2)
  voting_district_pair   Two boards where every region contains exactly N cells
  sudoku_pair            Fixed sudoku 3x3-box board paired with random boards (n=9 only)
  mono                   Single-board puzzles with a unique solution (SolutionFirstGenerator)
  solution_first_pair    board_count boards, each individually ambiguous, jointly unique

--stars (default 1) sets how many stars each row/column/region must
contain. Every mode above supports it except tmp (scratch/dev boilerplate,
edited by hand per experiment). Scoring never needs this flag -- it's
inferred from each puzzle's own solution.

--size-variation and --board-count only affect mono/solution_first_pair.

Examples:
  python3 gen_puzzles.py generate --mode random_pair --n 8 --count 100
  python3 gen_puzzles.py generate --mode symmetric_pair --n 6 --count 50 --output sym6.csv
  python3 gen_puzzles.py generate --mode letter_pair --char1 T --char2 H --n 8 --count 10
  python3 gen_puzzles.py generate --mode random_pair --n 8 --count 100 --score-after
  python3 gen_puzzles.py generate --mode voting_district_pair --n 8 --count 100
  python3 gen_puzzles.py generate --mode sudoku_pair --n 9 --count 100
  python3 gen_puzzles.py generate --mode symmetric_pair --n 9 --count 100 --stars 2
  python3 gen_puzzles.py generate --mode mono --n 8 --count 100
  python3 gen_puzzles.py generate --mode solution_first_pair --n 8 --count 50 --board-count 3
  python3 gen_puzzles.py generate --mode random_pair --n 8 --count 100 --seed 12345
        """,
    )
    gen_p.add_argument("--mode", choices=list(MODES.keys()), required=True,
                       help="Generation mode")
    gen_p.add_argument("--n", type=int, default=8,
                       help="Board size (default: 8)")
    gen_p.add_argument("--count", type=int, default=100,
                       help="Number of puzzle pairs to generate (default: 100)")
    gen_p.add_argument("--stars", type=int, default=1,
                       help="Stars per row/column/region (default: 1). Supported by every "
                            "mode except tmp.")
    gen_p.add_argument("--output", type=str, default="puzzles.csv",
                       help="Output CSV file (default: puzzles.csv)")
    gen_p.add_argument("--char1", type=str, default=None,
                       help="Character for board 1 (letter_pair mode only)")
    gen_p.add_argument("--char2", type=str, default=None,
                       help="Character for board 2 (letter_pair mode only)")
    gen_p.add_argument("--size-variation", type=float, default=0.0,
                       dest="size_variation",
                       help="Region size variation, mono/solution_first_pair only (default: 0.0)")
    gen_p.add_argument("--board-count", type=int, default=2,
                       dest="board_count",
                       help="Number of boards, solution_first_pair only (default: 2)")
    gen_p.add_argument("--seed", type=int, default=None,
                       help="Random seed for reproducible generation. The seed used is "
                            "always printed at the start of the run -- rerun with "
                            "--seed <value> to reproduce a run's output exactly, e.g. to "
                            "investigate a specific reported bad board.")
    gen_p.add_argument("--score-after", action="store_true",
                       dest="score_after",
                       help="Score the generated puzzles immediately after generation")
    gen_p.add_argument("--verbose", action="store_true",
                       help="Print scoring steps (only relevant with --score-after)")

    # ── score subcommand ──────────────────────────────────────────────────────
    score_p = sub.add_parser(
        "score",
        help="Score an existing puzzle CSV",
        description="""
Score puzzles in an existing CSV using rule-based difficulty estimation.

Examples:
  python3 gen_puzzles.py score --input puzzles.csv
  python3 gen_puzzles.py score --input puzzles.csv --output scored.csv
  python3 gen_puzzles.py score --input puzzles.csv --puzzle puzzle_42 --verbose
        """,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    score_p.add_argument("--input", type=str, default="puzzles.csv",
                         help="Input CSV to score (default: puzzles.csv)")
    score_p.add_argument("--output", type=str, default=None,
                         help="Output CSV (default: puzzles_scored.csv)")
    score_p.add_argument("--puzzle", type=str, default=None,
                         help="Score only this named puzzle")
    score_p.add_argument("--verbose", action="store_true",
                         help="Print each inference step during scoring")
    score_p.add_argument("--skip-dedup", action="store_true", dest="skip_dedup",
                         help="Skip duplicate detection (use when input was already deduped during generation)")

    args = parser.parse_args()

    if args.command == "generate":
        run_generation(args)
    else:
        run_scoring(args)


if __name__ == "__main__":
    main()
