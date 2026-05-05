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
Columns: name, N, board_1, board_2, solution

Scoring output: CSV to --output file (default: puzzles_scored.csv).
Columns: name, N, board_1, board_2, solution, score, tier, is_solved

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

# Board generators
from letter_generator import LetterGenerator
from random_generator import RandomGenerator
from square_free_generator import SquareFreeGenerator
from symmetric_generator import SymmetricGenerator
from voting_district_generator import VotingDistrictGenerator

# Comparators for pairing puzzles
from asymmetric_pool_comparator import AsymmetricPoolComparator
from self_comparator import SelfComparator
from symmetric_pool_comparator import SymmetricPoolComparator
from sudoku_comparator import SudokuComparator

# Scoring utils
from scorer import StarBattlePuzzle, CompositeScorer, TIER_ORDER, _TIER_RANK


# ─────────────────────────────────────────────────────────────────────────────
# Mode wiring & CLI
# ─────────────────────────────────────────────────────────────────────────────

def _build_sudoku_pair(n, output_rows):
    if n != 9:
        raise ValueError("sudoku_pair mode requires --n 9")
    gen = RandomGenerator(n)
    return SudokuComparator(gen, n, output_rows)


def _build_letter_pair(args, n, output_rows):
    if not args.char1 or not args.char2:
        raise ValueError("--char1 and --char2 are required for letter_pair mode")
    gen_a = LetterGenerator(n, args.char1[0].upper())
    gen_b = LetterGenerator(n, args.char2[0].upper())
    return AsymmetricPoolComparator(gen_a, gen_b, n, output_rows, randomize_orientation_for_output=False)

# boilerplate so I don't need to write this every time when testing new
# generators or comparators.
def _build_tmp(args, n, output_rows):
    return SymmetricPoolComparator(SquareFreeGenerator(n), n, output_rows)
    #gen_a = SymmetricGenerator(n, symmetry_type="rot_90")
    #gen_b = SymmetricGenerator(n, symmetry_type="rot_180")
    #return AsymmetricPoolComparator(gen_a, gen_b, n, output_rows)


# Maps mode names to factory lambdas.
# To add a new mode: add one entry here — argparse choices are derived
# automatically from this dict.
MODES = {
    'random_pair':          lambda a, n, r: SymmetricPoolComparator(RandomGenerator(n), n, r),
    'symmetric_pair':       lambda a, n, r: SymmetricPoolComparator(SymmetricGenerator(n), n, r),
    'self_entangled':       lambda a, n, r: SelfComparator(RandomGenerator(n), n, r),
    'super_symmetric':      lambda a, n, r: SelfComparator(SymmetricGenerator(n), n, r),
    'letter_pair':          lambda a, n, r: _build_letter_pair(a, n, r),
    'voting_district_pair': lambda a, n, r: SymmetricPoolComparator(VotingDistrictGenerator(n), n, r),
    'tmp':                  lambda a, n, r: _build_tmp(a, n, r),
    'sudoku_pair':          lambda a, n, r: _build_sudoku_pair(n, r),
}


def _scored_output_path(input_path, explicit_output=None):
    """Derive a scored-output filename from the input path, unless overridden."""
    if explicit_output:
        return explicit_output
    stem, ext = os.path.splitext(input_path)
    return stem + "_scored" + (ext or ".csv")


def run_generation(args):
    output_rows = []
    print("# Mode: {0} | n={1} | count={2}".format(
        args.mode, args.n, args.count), flush=True)
    print("name,N,board_1,board_2,solution", flush=True)

    comparator = MODES[args.mode](args, args.n, output_rows)
    comparator.run(args.count)

    with open(args.output, 'w', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=['name', 'N', 'board_1', 'board_2', 'solution'])
        writer.writeheader()
        writer.writerows(output_rows)

    if args.score_after:
        # Reuse the generate namespace but override the scoring-specific fields.
        args.input = args.output
        args.output = _scored_output_path(args.output)
        args.puzzle = None
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

    scorer = CompositeScorer(verbose=args.verbose)
    all_results = []
    total, solved_count = 0, 0

    with open(input_file, mode='r') as f:
        reader = csv.DictReader(f)
        original_fieldnames = reader.fieldnames or []
        for row in reader:
            if args.puzzle and row['name'] != args.puzzle:
                continue
            total += 1
            puzzle = StarBattlePuzzle(
                int(row['N']), row['board_1'], row['board_2'],
                row['solution'], row['name']
            )
            solved, score, tier = scorer.solve(puzzle)
            if solved:
                solved_count += 1
            row['score'] = score
            row['tier'] = tier
            row['is_solved'] = solved
            all_results.append(row)

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

Examples:
  python3 gen_puzzles.py generate --mode random_pair --n 8 --count 100
  python3 gen_puzzles.py generate --mode symmetric_pair --n 6 --count 50 --output sym6.csv
  python3 gen_puzzles.py generate --mode letter_pair --char1 T --char2 H --n 8 --count 10
  python3 gen_puzzles.py generate --mode random_pair --n 8 --count 100 --score-after
  python3 gen_puzzles.py generate --mode voting_district_pair --n 8 --count 100
  python3 gen_puzzles.py generate --mode sudoku_pair --n 9 --count 100
        """,
    )
    gen_p.add_argument("--mode", choices=list(MODES.keys()), required=True,
                       help="Generation mode")
    gen_p.add_argument("--n", type=int, default=8,
                       help="Board size (default: 8)")
    gen_p.add_argument("--count", type=int, default=100,
                       help="Number of puzzle pairs to generate (default: 100)")
    gen_p.add_argument("--output", type=str, default="puzzles.csv",
                       help="Output CSV file (default: puzzles.csv)")
    gen_p.add_argument("--char1", type=str, default=None,
                       help="Character for board 1 (letter_pair mode only)")
    gen_p.add_argument("--char2", type=str, default=None,
                       help="Character for board 2 (letter_pair mode only)")
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

    args = parser.parse_args()

    if args.command == "generate":
        run_generation(args)
    else:
        run_scoring(args)


if __name__ == "__main__":
    main()
