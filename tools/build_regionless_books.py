"""
build_regionless_books.py

Batch script that builds the regionless ("shapeless") puzzle books: for each
book spec below, repeatedly runs RegionlessGenerator.generate_tier_ladder()
(deduped via PuzzleDeduper and canonicalized/orientation-randomized the same
way Comparator._emit does) until every requested tier bucket has collected an
OVERSAMPLED pool, then downselects each tier to its final target count via
book_gen.py's select_uniform (spread evenly across that tier's own observed
score range) before writing ONE combined CSV per size to
data/<size>_regionless.csv -- puzzles ordered Beginner -> Medium -> Hard ->
Expert -> Grandmaster, so difficulty just ramps up as you page through the
one book.

Why oversample-then-select, not just stop at the target count directly:
generate_tier_ladder() harvests every tier ONE carve reaches on its way from
trivial to (possibly) harder than this ruleset can solve, so a single carve
can contribute to MULTIPLE tier buckets at once -- e.g. a carve's Beginner
snapshot and its own Hard snapshot both landing in the same book. Those two
aren't exact duplicates (PuzzleDeduper doesn't -- and shouldn't -- flag them),
but they ARE structural siblings: literally the same board at two points
along one void-growth path. Rather than chase that down with a same-carve
exclusion rule (real cost: throws away free samples a carve already paid
CP-SAT time for), this collects a MUCH bigger pool per tier than needed
(OVERSAMPLE_FACTOR) and then randomly-flavored uniform-selects the final
count from it -- diluting any given carve's sibling-pair influence across a
pool several times its target size, while also giving each tier bucket a
genuine wide difficulty spread instead of "whatever showed up first."

Beginner also gets an extra pre-selection filter: the trivial end of a carve
(right after the carve starts near-fully-voided) produces snapshots that are
technically valid Beginner-tier puzzles but are so void-heavy (few playable
cells) that they barely feel like a puzzle -- BEGINNER_VOID_DROP_FRACTION of
the oversampled Beginner pool, the most void-heavy fraction, gets dropped
before the uniform selection runs.

No separate "N very very hard" bonus tier for Expert: the wide-range
selection over an oversampled Expert pool already reaches toward genuinely
hard examples at the top of Expert's own score range, without needing a
separate mining pass. A book CAN still name a `bonus_tiers` set, though --
for a tier where real content is worth calling out as its own tiny "hardest
of the hard" finale (e.g. 1★ regionless boards can reach genuine single-
board Grandmaster, unlike 2★/3★, where it's cross-board-only and so
unreachable here) -- see BOOKS below. A bonus tier skips the void filter and
the uniform spread: it's oversampled much more aggressively
(BONUS_OVERSAMPLE_FACTOR) and downselected to the flat-out `count` HIGHEST-
scoring examples, appended after everything else in the book.

Not a general-purpose CLI like gen_puzzles.py -- BOOKS below is the spec,
edited in place per batch run.

Usage:
    python3 build_regionless_books.py [book_name ...]
    (with no args, builds every book in BOOKS; args restrict to a subset,
    matched against each spec's own "name")
"""

import csv
import os
import random
import sys
import time
from concurrent.futures import ProcessPoolExecutor

from board_utils import canonical_relabel, get_transformation_maps
from book_gen import select_uniform
from puzzle_deduper import PuzzleDeduper
from regionless_generator import RegionlessGenerator

DATA_DIR = "../data"

# Ascending difficulty, matching engine.py's TIER_ORDER (minus UNSOLVED,
# which never appears in a bucket -- generate_tier_ladder only returns
# tiers a puzzle was actually SOLVED at).
TIER_ORDER = ["Beginner", "Medium", "Hard", "Symmetry", "Expert", "Grandmaster"]

# How much bigger a pool to collect per tier than its final target count,
# before downselecting -- see the module docstring for why.
OVERSAMPLE_FACTOR = 3

# Bonus tiers (see module docstring) get a much bigger multiplier: the goal
# there is genuine tail extremes ("the hardest this ruleset can still
# solve"), not just diluting same-carve siblings, so a bigger sample matters
# more than it does for the main uniform-spread buckets.
BONUS_OVERSAMPLE_FACTOR = 30

# Fraction of the oversampled Beginner pool (the most void-heavy end of it)
# to drop before selection -- see the module docstring.
BEGINNER_VOID_DROP_FRACTION = 0.2

# Each book: (name, n, stars_per_unit, targets, bonus_tiers, max_runs).
# targets: {tier: final count} -- every tier the book wants, and how many
# puzzles it needs at that tier (before oversampling). bonus_tiers: set of
# tier names (a subset of targets' keys) to select as "top-N hardest by
# score" instead of a uniform spread -- see module docstring; empty set for
# a book with no bonus tier. max_runs is a safety cap, sized with real
# margin over the oversampled run-count estimate so a legitimate slow patch
# doesn't trip it, but a truly wrong yield-rate assumption still fails
# loudly instead of hanging forever.
#
# 6x6/8x8 (1★): real single-board Grandmaster is reachable here (~28%/~47%
# of runs in calibration -- more common than Expert), unlike 2★/3★ regionless
# where Grandmaster is cross-board-only and so structurally unreachable for
# a single board. 5-puzzle Grandmaster finale, oversampled at
# BONUS_OVERSAMPLE_FACTOR to find genuine extremes.
# max_runs sized from real calibration (this session): Expert-tier yield is
# the bottleneck at every size --
#   6x6:  0.67% Expert rate  -> ~112K runs needed for a 750-pool
#   8x8:  4.3%  Expert rate  -> ~17K runs needed
#   9x9:  11.7% Expert rate, 589ms/run  -> ~6.4K runs needed
#   13x13: 11.3% Expert rate, ~10s(!)/run -> ~6.6K runs needed
# each with a healthy (>=2.5x) safety margin over the expected count.
BOOKS = [
    ("6x6_1star",   6, 1, {"Beginner": 250, "Hard": 500, "Expert": 250, "Grandmaster": 5}, {"Grandmaster"}, 120000),
    ("8x8_1star",   8, 1, {"Beginner": 250, "Hard": 500, "Expert": 250, "Grandmaster": 5}, {"Grandmaster"}, 45000),
    ("9x9_2star",   9, 2, {"Beginner": 250, "Hard": 500, "Expert": 250}, set(), 20000),
    ("13x13_3star", 13, 3, {"Beginner": 250, "Hard": 500, "Expert": 250}, set(), 18000),
]


def _apply_transform(board_str, forward_map, n):
    result = [""] * (n * n)
    for i, ch in enumerate(board_str):
        result[forward_map[i]] = ch
    return "".join(result)


def _randomize_orientation(board_str, solution, n):
    """Mirrors Comparator._emit's orientation-randomization step (comparator.py)."""
    forward_map, _ = random.choice(get_transformation_maps(n))
    new_board = _apply_transform(board_str, forward_map, n)
    sol_list = ["."] * (n * n)
    for i, ch in enumerate(solution):
        if ch == 'x':
            sol_list[forward_map[i]] = 'x'
    return new_board, "".join(sol_list)


def _void_fraction(board_str, n):
    return board_str.count('*') / (n * n)


def _build_pool_worker(args):
    """One worker's share of pool collection -- runs single-threaded in its
    own process (own RegionlessGenerator + PuzzleDeduper instances), given
    its own slice of each tier's oversampled target and its own max_runs
    budget. See build_pool_parallel for how workers' results get merged
    (including a final cross-worker dedup pass, since each worker's
    PuzzleDeduper only knows about its own finds)."""
    worker_id, name, n, stars_per_unit, pool_targets, max_runs, progress_every = args
    gen = RegionlessGenerator(n, stars_per_unit=stars_per_unit)
    deduper = PuzzleDeduper()
    buckets = {tier: [] for tier in pool_targets}

    def satisfied():
        return all(len(buckets[t]) >= c for t, c in pool_targets.items())

    t0 = time.time()
    runs = 0
    while not satisfied() and runs < max_runs:
        runs += 1
        ladder = gen.generate_tier_ladder()
        if not ladder:
            continue
        for tier, (board_str, solution, score) in ladder.items():
            if tier not in pool_targets or len(buckets[tier]) >= pool_targets[tier]:
                continue

            board_str, solution = _randomize_orientation(board_str, solution, n)
            board_str = canonical_relabel(board_str)
            if deduper.is_duplicate([board_str], n):
                continue
            deduper.register([board_str], n)
            buckets[tier].append((board_str, solution, score))

        if runs % progress_every == 0:
            elapsed = time.time() - t0
            status = ", ".join(f"{t}={len(buckets[t])}/{c}" for t, c in pool_targets.items())
            print(f"  [{name} w{worker_id}] runs={runs} ({elapsed:.0f}s): {status}", flush=True)

    elapsed = time.time() - t0
    print(f"  [{name} w{worker_id}] {'done' if satisfied() else 'stopped (max_runs)'}: "
          f"{runs} runs in {elapsed:.0f}s", flush=True)
    return buckets


def build_pool(name, n, stars_per_unit, targets, bonus_tiers, max_runs, progress_every=500,
                num_workers=None):
    """Collects an OVERSAMPLED pool per tier (targets[tier] * OVERSAMPLE_FACTOR,
    or * BONUS_OVERSAMPLE_FACTOR for a tier in bonus_tiers), split across
    num_workers processes (default: every core) and merged with a final
    cross-worker dedup pass (each worker's own PuzzleDeduper only sees its
    own finds, so two different workers could otherwise both keep the same
    board under different orientations). Returns {tier: [(board_str,
    solution, score), ...]}."""
    num_workers = num_workers or os.cpu_count() or 1
    pool_targets = {
        tier: count * (BONUS_OVERSAMPLE_FACTOR if tier in bonus_tiers else OVERSAMPLE_FACTOR)
        for tier, count in targets.items()
    }
    # Ceiling-divide so num_workers copies always sum to >= pool_targets.
    per_worker_targets = {tier: -(-count // num_workers) for tier, count in pool_targets.items()}
    per_worker_max_runs = -(-max_runs // num_workers)

    print(f"[{name}] pool targets (post-oversample): {pool_targets}, "
          f"{num_workers} workers x {per_worker_targets} each, "
          f"max_runs={max_runs} ({per_worker_max_runs}/worker)", flush=True)

    t0 = time.time()
    worker_args = [
        (i, name, n, stars_per_unit, per_worker_targets, per_worker_max_runs, progress_every)
        for i in range(num_workers)
    ]
    with ProcessPoolExecutor(max_workers=num_workers) as pool:
        results = list(pool.map(_build_pool_worker, worker_args))

    # Merge, then a final cross-worker dedup pass (fresh PuzzleDeduper,
    # first-seen-wins) -- each worker already deduped against its OWN
    # finds, but not against every other worker's.
    merged = {tier: [] for tier in targets}
    for buckets in results:
        for tier, rows in buckets.items():
            merged[tier].extend(rows)

    final_deduper = PuzzleDeduper()
    buckets = {tier: [] for tier in targets}
    dupes_dropped = 0
    for tier, rows in merged.items():
        for board_str, solution, score in rows:
            if final_deduper.is_duplicate([board_str], n):
                dupes_dropped += 1
                continue
            final_deduper.register([board_str], n)
            buckets[tier].append((board_str, solution, score))

    elapsed = time.time() - t0
    satisfied = all(len(buckets[t]) >= c for t, c in pool_targets.items())
    print(f"[{name}] pool collection {'DONE' if satisfied else 'SHORT'} in {elapsed:.0f}s "
          f"(dropped {dupes_dropped} cross-worker dupes): "
          f"{ {t: len(buckets[t]) for t in buckets} }", flush=True)
    if not satisfied:
        short = {t: (len(buckets[t]), c) for t, c in pool_targets.items() if len(buckets[t]) < c}
        print(f"[{name}] WARNING: pool short on: {short}", flush=True)

    return buckets


def select_book_entries(name, n, targets, bonus_tiers, pool):
    """Downselects each tier's oversampled pool to targets[tier]. A tier in
    bonus_tiers takes the flat-out `count` HIGHEST-scoring candidates
    instead. Otherwise: book_gen.py's select_uniform (spread across that
    tier's own observed score range), with Beginner additionally dropping
    its most void-heavy BEGINNER_VOID_DROP_FRACTION first. Returns {tier:
    [(board_str, solution, score), ...]} at the final target counts."""
    selected = {}
    for tier, count in targets.items():
        candidates = pool[tier]

        if tier in bonus_tiers:
            hardest = sorted(candidates, key=lambda e: e[2], reverse=True)[:count]
            selected[tier] = sorted(hardest, key=lambda e: e[2])  # ascending for the book
            scores = [e[2] for e in hardest]
            print(f"  [{name}] {tier} (bonus): picked top {len(hardest)} of {len(candidates)} "
                  f"by score, range [{min(scores) if scores else '-'}, {max(scores) if scores else '-'}]",
                  flush=True)
            continue

        if tier == "Beginner" and len(candidates) > count:
            by_void = sorted(candidates, key=lambda e: _void_fraction(e[0], n))
            keep_n = max(count, int(len(by_void) * (1 - BEGINNER_VOID_DROP_FRACTION)))
            candidates = by_void[:keep_n]
            print(f"  [{name}] Beginner: dropped {len(pool[tier]) - len(candidates)} "
                  f"most void-heavy of {len(pool[tier])} before selection", flush=True)

        if len(candidates) <= count:
            print(f"  [{name}] {tier}: pool only has {len(candidates)}, "
                  f"wanted {count} -- taking all of it", flush=True)
            selected[tier] = sorted(candidates, key=lambda e: e[2])
            continue

        scores = [e[2] for e in candidates]
        chosen = select_uniform(candidates, 2, min(scores), max(scores), count)
        selected[tier] = chosen
        chosen_scores = [c[2] for c in chosen]
        print(f"  [{name}] {tier}: selected {len(chosen)} of {len(candidates)}, "
              f"score range [{min(chosen_scores):.0f}, {max(chosen_scores):.0f}] "
              f"(pool range [{min(scores):.0f}, {max(scores):.0f}])", flush=True)
    return selected


def write_book_csv(path, n, entries):
    """entries: list of (board_str, solution, score, tier), in the order they
    should appear in the book."""
    with open(path, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["name", "N", "board_1", "solution", "score", "tier", "is_solved"])
        for i, (board_str, solution, score, tier) in enumerate(entries, start=1):
            writer.writerow([f"puzzle_{i}", n, board_str, solution, score, tier, True])


def build_book(name, n, stars_per_unit, targets, bonus_tiers, max_runs):
    print(f"\n=== Building {name} (n={n}, stars={stars_per_unit}) ===", flush=True)
    pool = build_pool(name, n, stars_per_unit, targets, bonus_tiers, max_runs, progress_every=200)
    selected = select_book_entries(name, n, targets, bonus_tiers, pool)

    entries = []
    for tier in TIER_ORDER:
        if tier in selected:
            entries.extend((b, s, sc, tier) for b, s, sc in selected[tier])

    path = f"{DATA_DIR}/{n}x{n}_regionless.csv"
    write_book_csv(path, n, entries)
    print(f"  wrote {len(entries)} rows -> {path}", flush=True)
    return path


def main():
    only = set(sys.argv[1:]) or None
    for name, n, stars, targets, bonus_tiers, max_runs in BOOKS:
        if only and name not in only:
            continue
        build_book(name, n, stars, targets, bonus_tiers, max_runs)


if __name__ == "__main__":
    main()
