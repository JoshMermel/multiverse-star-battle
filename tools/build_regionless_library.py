"""
build_regionless_library.py

Builds a large, UNCURATED corpus of scored regionless puzzles per board
size, at library/regionless/<n>x<n>.csv -- for offline experimentation
(trying new solver rules, rescoring against tier changes, etc.) without
needing to generate fresh puzzles every time. This is deliberately NOT
build_regionless_books.py's curated player-facing book: no fixed per-tier
counts, no uniform score-range selection, no Beginner void-filter, no
bonus-tier top-N. It just pools as many DISTINCT, already-scored puzzles
as it can find per size, across the FULL difficulty range -- including
UNSOLVED, which the real books never include (a player-facing book only
ever wants a puzzle the rule engine can actually crack; a research corpus
benefits from "the rule engine gave up here" examples too).

Each size's pool is SEEDED from whatever already-scored puzzles exist on
disk (the real book at data/<n>x<n>_regionless.csv, plus -- for 17x17
specifically -- the raw worker_*_scored.csv leftovers under
tools/regionless17_run/ from that size's original generation run), then
topped up via fresh generation to reach TARGET_TOTAL.

Fresh generation uses RegionlessGenerator.generate_full_history(
include_unsolved=True) rather than generate_tier_ladder(): both run the
SAME carve at the SAME cost, but generate_tier_ladder collapses it down to
one board per tier, while generate_full_history returns every board seen
at every tier (now including UNSOLVED) along the way -- strictly more
yield per unit of carve time, with no downside for a corpus that wants
bulk + variety rather than one curated pick per tier per run.

No per-tier target/quota: whatever mix of tiers a size's carves naturally
produce is exactly the "real" difficulty distribution for that size, and
forcing an artificial per-tier count would misrepresent that. Progress is
tracked purely by total row count toward TARGET_TOTAL; the final tier
breakdown is reported, not engineered.

Usage:
    python3 build_regionless_library.py [size_name ...]
    (with no args, builds every size in SPECS; args restrict to a subset,
    matched against each spec's own "name")
"""
import csv
import glob
import os
import random
import sys
import time
from concurrent.futures import ProcessPoolExecutor

from board_utils import canonical_relabel, get_transformation_maps
from puzzle_deduper import PuzzleDeduper
from regionless_generator import RegionlessGenerator

DATA_DIR = "../data"
LIBRARY_DIR = "library/regionless"

# Ascending difficulty for display purposes only (this corpus makes no
# attempt to hit every one of these -- see module docstring). UNSOLVED
# sorts last, matching engine.py's TIER_ORDER.
TIER_DISPLAY_ORDER = ["Beginner", "Medium", "Hard", "Symmetry", "Expert", "Grandmaster", "UNSOLVED"]

# Each size: (name, n, stars_per_unit, target_total, seed_glob_patterns,
# max_runs). Seed globs are relative to this script's own directory
# (tools/) and are read BEFORE generation starts; already-scored, so no
# rescoring needed -- just canonicalized and deduped into the same pool
# fresh generation adds to.
#
# max_runs sized from this session's own calibrate_library_yield.py
# numbers (rows/carve, ms/carve at each size), with a >=5x safety margin
# over the single-threaded run count actually needed to reach target_total
# (generation is split across every core, so real wall-clock is far below
# what max_runs alone would suggest):
#   6x6:   19.7 rows/carve,   39ms/carve -> ~460 carves needed for 9k rows
#   8x8:   32.9 rows/carve,  134ms/carve -> ~275 carves needed for 9k rows
#   9x9:   51.6 rows/carve,  593ms/carve -> ~175 carves needed for 9k rows
#   13x13: 112.5 rows/carve, 10.5s/carve -> ~36 carves needed for 4k rows
# full_history's yield-per-carve turned out far higher than
# generate_tier_ladder's (one board per tier vs. EVERY board seen at every
# tier, now including UNSOLVED) -- these sizes finish in well under a
# minute in practice, not the overnight run originally expected.
SPECS = [
    ("6x6",   6, 1, 10000, ["../data/6x6_regionless.csv"], 3000),
    ("8x8",   8, 1, 10000, ["../data/8x8_regionless.csv"], 2000),
    ("9x9",   9, 2, 10000, ["../data/9x9_regionless.csv"], 1200),
    ("13x13", 13, 3, 5000, ["../data/13x13_regionless.csv"], 250),
    # 17x17 (4-star): very slow per carve -- mostly reuse the ~4.7k
    # leftover puzzles from this size's original generation run, light
    # top-up only. max_runs set once this session's own 17x17 calibration
    # (calibrate_library_yield.py 17 4 2) returns real numbers.
    ("17x17", 17, 4, 5000,
     ["../data/17x17_regionless.csv", "regionless17_run/worker_*_scored.csv"], 40),
]


def _apply_transform(board_str, forward_map, n):
    result = [""] * (n * n)
    for i, ch in enumerate(board_str):
        result[forward_map[i]] = ch
    return "".join(result)


def _randomize_orientation(board_str, solution, n):
    """Mirrors build_regionless_books.py's own helper of the same name."""
    forward_map, _ = random.choice(get_transformation_maps(n))
    new_board = _apply_transform(board_str, forward_map, n)
    sol_list = ["."] * (n * n)
    for i, ch in enumerate(solution):
        if ch == 'x':
            sol_list[forward_map[i]] = 'x'
    return new_board, "".join(sol_list)


def load_seed_rows(seed_globs, n):
    """Reads every already-scored (board, solution, score, tier) row from
    the given CSV glob patterns (each in the usual name,N,board_1,solution,
    score,tier,is_solved schema). Skips rows whose N doesn't match (a
    defensive check, not expected to trigger)."""
    rows = []
    for pattern in seed_globs:
        for path in sorted(glob.glob(pattern)):
            with open(path, newline="") as f:
                reader = csv.DictReader(f)
                count = 0
                for row in reader:
                    if int(row["N"]) != n:
                        continue
                    rows.append((row["board_1"], row["solution"], float(row["score"]), row["tier"]))
                    count += 1
            print(f"  seeded {count} rows from {path}", flush=True)
    return rows


def _build_pool_worker(args):
    """One worker's share of fresh-generation top-up -- runs single-
    threaded in its own process (own RegionlessGenerator + PuzzleDeduper),
    given its own row-count share of what's still needed and its own
    max_runs budget. See build_pool for how workers' results get merged
    (including a final cross-worker dedup pass)."""
    worker_id, name, n, stars_per_unit, target_rows, max_runs, progress_every = args
    gen = RegionlessGenerator(n, stars_per_unit=stars_per_unit)
    deduper = PuzzleDeduper()
    rows = []

    t0 = time.time()
    runs = 0
    while len(rows) < target_rows and runs < max_runs:
        runs += 1
        history = gen.generate_full_history(include_unsolved=True)
        if not history:
            continue
        for tier, entries in history.items():
            for board_str, solution, score in entries:
                board_str, solution = _randomize_orientation(board_str, solution, n)
                if deduper.is_duplicate([board_str], n):
                    continue
                deduper.register([board_str], n)
                rows.append((canonical_relabel(board_str), solution, score, tier))

        if runs % progress_every == 0:
            elapsed = time.time() - t0
            print(f"  [{name} w{worker_id}] runs={runs} ({elapsed:.0f}s): "
                  f"rows={len(rows)}/{target_rows}", flush=True)

    elapsed = time.time() - t0
    print(f"  [{name} w{worker_id}] {'done' if len(rows) >= target_rows else 'stopped (max_runs)'}: "
          f"{runs} runs in {elapsed:.0f}s, {len(rows)} rows", flush=True)
    return rows


def build_pool(name, n, stars_per_unit, need_rows, max_runs, seed_rows, progress_every=5,
               num_workers=None):
    """Tops up seed_rows (already deduped against each other by the
    caller) with fresh generation until roughly need_rows MORE distinct
    rows are collected, split across num_workers processes and merged with
    a final cross-worker dedup pass (each worker's own PuzzleDeduper only
    sees its own finds). Returns the combined list of (board_str, solution,
    score, tier) tuples: seed_rows + newly generated ones."""
    if need_rows <= 0:
        print(f"[{name}] seed pool already >= target -- skipping fresh generation", flush=True)
        return seed_rows

    num_workers = num_workers or os.cpu_count() or 1
    per_worker_target = -(-need_rows // num_workers)
    per_worker_max_runs = -(-max_runs // num_workers)

    print(f"[{name}] need {need_rows} more rows, {num_workers} workers x "
          f"{per_worker_target} each, max_runs={max_runs} ({per_worker_max_runs}/worker)", flush=True)

    t0 = time.time()
    worker_args = [
        (i, name, n, stars_per_unit, per_worker_target, per_worker_max_runs, progress_every)
        for i in range(num_workers)
    ]
    with ProcessPoolExecutor(max_workers=num_workers) as pool:
        results = list(pool.map(_build_pool_worker, worker_args))

    # Seed the final dedup pass with every seed row already accepted, so a
    # freshly-generated duplicate of an existing seed puzzle gets dropped
    # too, not just cross-worker duplicates among the fresh rows.
    final_deduper = PuzzleDeduper()
    for board_str, _solution, _score, _tier in seed_rows:
        final_deduper.register([board_str], n)

    combined = list(seed_rows)
    dupes_dropped = 0
    for rows in results:
        for board_str, solution, score, tier in rows:
            if final_deduper.is_duplicate([board_str], n):
                dupes_dropped += 1
                continue
            final_deduper.register([board_str], n)
            combined.append((board_str, solution, score, tier))

    elapsed = time.time() - t0
    print(f"[{name}] generation done in {elapsed:.0f}s (dropped {dupes_dropped} dupes "
          f"against seed+cross-worker): total pool = {len(combined)} rows", flush=True)
    return combined


def write_library_csv(path, n, rows):
    """rows: list of (board_str, solution, score, tier), any order --
    written sorted by tier (TIER_DISPLAY_ORDER) then score, purely so the
    file reads top-to-bottom in a sensible progression; this corpus makes
    no claim about proportional representation."""
    tier_rank = {t: i for i, t in enumerate(TIER_DISPLAY_ORDER)}
    ordered = sorted(rows, key=lambda r: (tier_rank.get(r[3], len(TIER_DISPLAY_ORDER)), r[2]))
    with open(path, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["name", "N", "board_1", "solution", "score", "tier", "is_solved"])
        for i, (board_str, solution, score, tier) in enumerate(ordered, start=1):
            writer.writerow([f"puzzle_{i}", n, board_str, solution, score, tier, tier != "UNSOLVED"])


def build_size(name, n, stars_per_unit, target_total, seed_globs, max_runs):
    print(f"\n=== Building library/regionless/{name}.csv (n={n}, stars={stars_per_unit}, "
          f"target={target_total}) ===", flush=True)

    raw_seed_rows = load_seed_rows(seed_globs, n)
    deduper = PuzzleDeduper()
    seed_rows = []
    for board_str, solution, score, tier in raw_seed_rows:
        canon = canonical_relabel(board_str)
        if deduper.is_duplicate([canon], n):
            continue
        deduper.register([canon], n)
        seed_rows.append((canon, solution, score, tier))
    print(f"  {len(seed_rows)} distinct seed rows (of {len(raw_seed_rows)} loaded)", flush=True)

    need_rows = target_total - len(seed_rows)
    pool = build_pool(name, n, stars_per_unit, need_rows, max_runs, seed_rows)

    tier_counts = {}
    for _b, _s, _sc, tier in pool:
        tier_counts[tier] = tier_counts.get(tier, 0) + 1

    os.makedirs(LIBRARY_DIR, exist_ok=True)
    path = f"{LIBRARY_DIR}/{name}.csv"
    write_library_csv(path, n, pool)
    print(f"  wrote {len(pool)} rows -> {path}", flush=True)
    print(f"  tier breakdown: { {t: tier_counts.get(t, 0) for t in TIER_DISPLAY_ORDER if t in tier_counts} }",
          flush=True)
    return path


def main():
    only = set(sys.argv[1:]) or None
    for name, n, stars, target_total, seed_globs, max_runs in SPECS:
        if only and name not in only:
            continue
        build_size(name, n, stars, target_total, seed_globs, max_runs)


if __name__ == "__main__":
    main()
