#!/usr/bin/env python3
"""
finalize.py -- merge the 10 worker_N_scored.csv files from the 17x17/4-star
regionless overnight run into the final book.

Target mix (no Medium tier exists for regionless boards post rule-reorder --
see the session's own calibration: 0/21 sample rows landed Medium):
  250 Beginner, 500 Hard, 250 Expert, 5 "max difficulty" (highest-scoring
  Expert/Grandmaster rows, carved out separately from the 250 above).

Selection within each tier: sorted by score ascending, lowest (easiest)
first -- same convention already used for the 17x17/21x21/25x25 mono
giants books (see puzzles_17_scored.csv etc.). The 5 bonus rows are the
GLOBAL highest-scoring rows across Expert+Grandmaster, excluded from the
normal Expert bucket so they don't double-count.

Dedupes by exact board_1 string across all workers before bucketing.
"""
import csv
import glob
import sys

TARGETS = {"Beginner": 250, "Hard": 500, "Expert": 250}
BONUS_COUNT = 5

def main():
    rows = []
    header = None
    for fp in sorted(glob.glob("tools/regionless17_run/worker_*_scored.csv")):
        with open(fp, newline="") as f:
            reader = csv.reader(f)
            h = next(reader, None)
            if h is None:
                continue
            if header is None:
                header = h
            for row in reader:
                if row and len(row) == len(header):
                    rows.append(row)

    if header is None:
        print("No scored worker output found yet.", file=sys.stderr)
        sys.exit(1)

    board_idx = header.index("board_1")
    tier_idx = header.index("tier")
    score_idx = header.index("score")
    name_idx = header.index("name")

    seen = set()
    deduped = []
    for row in rows:
        key = row[board_idx]
        if key in seen:
            continue
        seen.add(key)
        deduped.append(row)

    by_tier = {}
    for row in deduped:
        by_tier.setdefault(row[tier_idx], []).append(row)

    from collections import Counter
    print("Deduped rows:", len(deduped))
    print("Tier counts:", Counter(row[tier_idx] for row in deduped))

    # Bonus: 5 hardest rows across Expert + Grandmaster (if any), pulled out
    # BEFORE filling the normal Expert bucket so there's no overlap.
    expert_pool = sorted(
        by_tier.get("Expert", []) + by_tier.get("Grandmaster", []),
        key=lambda r: float(r[score_idx]), reverse=True,
    )
    bonus = expert_pool[:BONUS_COUNT]
    bonus_boards = {r[board_idx] for r in bonus}
    remaining_expert = [r for r in expert_pool if r[board_idx] not in bonus_boards]
    remaining_expert.sort(key=lambda r: float(r[score_idx]))

    out_rows = []
    shortfalls = {}
    for tier, target in TARGETS.items():
        if tier == "Expert":
            pool = remaining_expert
        else:
            pool = sorted(by_tier.get(tier, []), key=lambda r: float(r[score_idx]))
        chosen = pool[:target]
        if len(chosen) < target:
            shortfalls[tier] = (len(chosen), target)
        out_rows.extend(chosen)

    if len(bonus) < BONUS_COUNT:
        shortfalls["bonus"] = (len(bonus), BONUS_COUNT)
    out_rows.extend(bonus)

    if shortfalls:
        print("SHORTFALLS (not enough candidates yet):", shortfalls)

    # Each worker numbers its own puzzles "puzzle_1, puzzle_2, ..." from 1 --
    # fine within one worker's file, but 20 independent workers means heavy
    # name collisions once merged (two totally different boards both named
    # "puzzle_141"). Renumber sequentially in final (tier, score) order,
    # matching the sibling data/13x13_regionless.csv's convention of
    # globally-unique puzzle_N names across the whole file.
    for i, row in enumerate(out_rows, start=1):
        row[name_idx] = f"puzzle_{i}"

    output_path = "data/17x17_regionless.csv"
    with open(output_path, "w", newline="") as f:
        writer = csv.writer(f, lineterminator="\n")
        writer.writerow(header)
        writer.writerows(out_rows)

    print(f"Wrote {len(out_rows)} rows to {output_path}")
    if not shortfalls:
        print("ALL_QUOTAS_MET")


if __name__ == "__main__":
    main()
