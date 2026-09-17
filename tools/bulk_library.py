"""
bulk_library.py

Time-boxed bulk-up of one library/regionless/<name>.csv (see
build_regionless_library.py, which creates these files initially). No
target row count -- this just runs fresh RegionlessGenerator.
generate_full_history(include_unsolved=True) carves in parallel across
every core for a fixed wall-clock duration and keeps every new distinct
board found, for building a much deeper corpus than any specific book
currently needs (so book_gen.py always has a rich pool to select from
later, whatever a future book's tier targets turn out to be).

Before generating, RE-SCORES every row already in the file against the
CURRENT CompositeScorer rather than trusting its stored score/tier
columns. This matters whenever a size's corpus predates a solver-rule
change: e.g. library/regionless/17x17.csv's seed rows came from a
generation run that finished before this session's tileSeesTooMuchMulti/
tilePairQuotaFill rules existed, so their original tier/score values no
longer reflect what the current ruleset can actually deduce. Cheap to do
unconditionally (a rule-based solve, not a fresh CP-SAT uniqueness
search) and removes an entire class of staleness bugs, so this always
runs, not just when staleness is suspected.

Usage:
    python3 bulk_library.py <name> <n> <stars_per_unit> <minutes>
Example:
    python3 bulk_library.py 6x6 6 1 10
"""
import csv
import os
import random
import sys
import time
from concurrent.futures import ProcessPoolExecutor

from board_utils import canonical_relabel, get_transformation_maps
from puzzle_deduper import PuzzleDeduper
from regionless_generator import RegionlessGenerator
from scorer import StarBattlePuzzle, CompositeScorer

LIBRARY_DIR = "library/regionless"
TIER_DISPLAY_ORDER = ["Beginner", "Medium", "Hard", "Symmetry", "Expert", "Grandmaster", "UNSOLVED"]


def _apply_transform(board_str, forward_map, n):
    result = [""] * (n * n)
    for i, ch in enumerate(board_str):
        result[forward_map[i]] = ch
    return "".join(result)


def _randomize_orientation(board_str, solution, n):
    forward_map, _ = random.choice(get_transformation_maps(n))
    new_board = _apply_transform(board_str, forward_map, n)
    sol_list = ["."] * (n * n)
    for i, ch in enumerate(solution):
        if ch == 'x':
            sol_list[forward_map[i]] = 'x'
    return new_board, "".join(sol_list)


def load_existing(path, n):
    if not os.path.exists(path):
        return []
    with open(path, newline="") as f:
        reader = csv.DictReader(f)
        return [(row["board_1"], row["solution"]) for row in reader if int(row["N"]) == n]


def rescore(board_solution_pairs, n, stars_per_unit, label):
    """Re-runs the CURRENT CompositeScorer on every (board, solution) pair
    -- see module docstring for why this always happens, not just for
    sizes known to be stale. uncap_grandmaster=True: see CompositeScorer's
    own docstring -- measured cost-neutral for regionless boards, so every
    Grandmaster-tier rule (not just the always-exempted one) gets a real
    chance to fire during rescoring."""
    scorer = CompositeScorer(verbose=False, uncap_grandmaster=True)
    rows = []
    t0 = time.time()
    for i, (board_str, solution) in enumerate(board_solution_pairs):
        puzzle = StarBattlePuzzle(n=n, boards=[board_str], solution_str=solution,
                                   name="rescore", stars_per_unit=stars_per_unit)
        solved, score, tier = scorer.solve(puzzle)
        rows.append((board_str, solution, score, tier))
        if (i + 1) % 1000 == 0:
            print(f"  [{label}] rescored {i + 1}/{len(board_solution_pairs)} "
                  f"({time.time() - t0:.0f}s)", flush=True)
    print(f"  [{label}] rescored {len(rows)} rows in {time.time() - t0:.0f}s", flush=True)
    return rows


def _worker(args):
    worker_id, name, n, stars_per_unit, deadline, progress_every = args
    gen = RegionlessGenerator(n, stars_per_unit=stars_per_unit, uncap_grandmaster=True)
    deduper = PuzzleDeduper()
    rows = []
    t0 = time.time()
    runs = 0
    while time.time() < deadline:
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
            remaining = max(0, deadline - time.time())
            print(f"  [{name} w{worker_id}] runs={runs} rows={len(rows)} "
                  f"elapsed={elapsed:.0f}s remaining={remaining:.0f}s", flush=True)
    print(f"  [{name} w{worker_id}] time's up: {runs} runs, {len(rows)} rows", flush=True)
    return rows


def write_library_csv(path, n, rows):
    tier_rank = {t: i for i, t in enumerate(TIER_DISPLAY_ORDER)}
    ordered = sorted(rows, key=lambda r: (tier_rank.get(r[3], len(TIER_DISPLAY_ORDER)), r[2]))
    with open(path, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["name", "N", "board_1", "solution", "score", "tier", "is_solved"])
        for i, (board_str, solution, score, tier) in enumerate(ordered, start=1):
            writer.writerow([f"puzzle_{i}", n, board_str, solution, score, tier, tier != "UNSOLVED"])


def main():
    name, n, stars_per_unit, minutes = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), float(sys.argv[4])
    path = f"{LIBRARY_DIR}/{name}.csv"

    print(f"\n=== Bulking {path} for {minutes} minutes (n={n}, stars={stars_per_unit}) ===", flush=True)
    existing = load_existing(path, n)
    print(f"  {len(existing)} existing rows loaded", flush=True)
    rescored = rescore(existing, n, stars_per_unit, name) if existing else []

    deduper = PuzzleDeduper()
    seed_rows = []
    for board_str, solution, score, tier in rescored:
        canon = canonical_relabel(board_str)
        if deduper.is_duplicate([canon], n):
            continue
        deduper.register([canon], n)
        seed_rows.append((canon, solution, score, tier))
    print(f"  {len(seed_rows)} distinct rescored seed rows", flush=True)

    num_workers = os.cpu_count() or 1
    deadline = time.time() + minutes * 60
    progress_every = 1 if minutes >= 15 else 5
    worker_args = [(i, name, n, stars_per_unit, deadline, progress_every) for i in range(num_workers)]

    t0 = time.time()
    with ProcessPoolExecutor(max_workers=num_workers) as pool:
        results = list(pool.map(_worker, worker_args))

    combined = list(seed_rows)
    dupes = 0
    for rows in results:
        for board_str, solution, score, tier in rows:
            if deduper.is_duplicate([board_str], n):
                dupes += 1
                continue
            deduper.register([board_str], n)
            combined.append((board_str, solution, score, tier))

    elapsed = time.time() - t0
    tier_counts = {}
    for _b, _s, _sc, tier in combined:
        tier_counts[tier] = tier_counts.get(tier, 0) + 1

    os.makedirs(LIBRARY_DIR, exist_ok=True)
    write_library_csv(path, n, combined)
    print(f"[{name}] generation done in {elapsed:.0f}s (dropped {dupes} dupes): "
          f"total pool = {len(combined)} rows -> {path}", flush=True)
    print(f"[{name}] tier breakdown: "
          f"{ {t: tier_counts.get(t, 0) for t in TIER_DISPLAY_ORDER if t in tier_counts} }", flush=True)


if __name__ == "__main__":
    main()
