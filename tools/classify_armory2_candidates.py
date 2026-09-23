"""
classify_armory2_candidates.py

Loads every candidate CSV in a directory, traces each puzzle with
trace_solve(), and buckets puzzles by their hardest-rule name. For each
target rule name, keeps the best few candidates (preferring: exactly one
occurrence of the target rule in the trace, more boards, no voids, smaller
N), so a favorite + backups can be picked per how_to_solve2.md section.

Usage:
    python3 classify_armory2_candidates.py <candidates_dir> [--out out.json]
"""
import argparse
import csv
import glob
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from trace_solve import trace_solve, hardest_rule, rule_counts
from board_utils import VOID_CHAR


def load_rows(candidates_dir):
    rows = []
    for path in glob.glob(os.path.join(candidates_dir, "*.csv")):
        with open(path, newline="") as f:
            for row in csv.DictReader(f):
                row["_source"] = os.path.basename(path)
                rows.append(row)
    return rows


def infer_stars(n, solution):
    return max((solution[r * n:(r + 1) * n].count("x") for r in range(n)), default=1) or 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("candidates_dir")
    ap.add_argument("--out", default=None)
    ap.add_argument("--keep", type=int, default=5, help="candidates to keep per rule")
    args = ap.parse_args()

    rows = load_rows(args.candidates_dir)
    print(f"loaded {len(rows)} candidate rows from {args.candidates_dir}", flush=True)

    buckets = {}
    processed = 0
    for row in rows:
        board_cols = sorted([c for c in row if c.startswith("board_")])
        boards = [row[c] for c in board_cols]
        n = int(row["N"])
        stars = infer_stars(n, row["solution"])
        trace, solved, score, tier = trace_solve(n, boards, row["solution"], stars)
        processed += 1
        if processed % 2000 == 0:
            print(f"  ...{processed}/{len(rows)} traced", flush=True)
        if not solved or not trace:
            continue
        hardest = hardest_rule(trace)
        counts = rule_counts(trace)
        has_voids = any(VOID_CHAR in b for b in boards)
        candidate = {
            "source": row["_source"], "name": row.get("name", "?"), "n": n, "stars": stars,
            "num_boards": len(boards), "boards": boards, "solution": row["solution"],
            "score": score, "tier": tier, "hardest_rule": hardest,
            "hardest_rule_count": counts[hardest], "has_voids": has_voids,
            "trace_len": len(trace),
        }
        buckets.setdefault(hardest, []).append(candidate)

    print(f"done tracing. Found {len(buckets)} distinct hardest-rule buckets.", flush=True)

    summary = {}
    for rule_name, candidates in buckets.items():
        candidates.sort(key=lambda c: (
            c["hardest_rule_count"] != 1,   # prefer exactly-1 occurrence
            -c["num_boards"],               # prefer more boards (2 > 1)
            c["has_voids"],                 # prefer no voids
            c["n"],                         # prefer smaller N
            c["trace_len"],                 # prefer shorter overall solve
        ))
        summary[rule_name] = candidates[:args.keep]

    out_path = args.out or os.path.join(args.candidates_dir, "classified.json")
    with open(out_path, "w") as f:
        json.dump(summary, f, indent=1)

    print(f"\nBucket sizes (rule_name: count found):")
    for rule_name in sorted(buckets, key=lambda r: -len(buckets[r])):
        print(f"  {rule_name}: {len(buckets[rule_name])}")
    print(f"\nWrote top candidates per rule -> {out_path}")


if __name__ == "__main__":
    main()
