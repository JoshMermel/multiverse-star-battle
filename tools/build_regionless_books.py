"""
build_regionless_books.py

One-off batch script that builds the first regionless ("shapeless") puzzle
books: for each book spec below, repeatedly runs
RegionlessGenerator.generate_tier_ladder() (deduped via PuzzleDeduper and
canonicalized/orientation-randomized the same way Comparator._emit does)
until every requested tier bucket has reached its target count, then writes
ONE combined CSV per size to data/<size>_regionless.csv -- puzzles ordered
Beginner -> Medium -> Hard -> Expert -> Grandmaster (any bonus_tier puzzles
last), so difficulty just ramps up as you page through the one book. No
per-tier sub-books/categories -- one file, one category per size (see
manifest.json's "Regionless" group).

Not a general-purpose CLI like gen_puzzles.py -- BOOKS below is the spec,
edited in place per batch run. Difficulty tiers are NOT a generation
target the underlying carve aims for (see regionless_generator.py); this
script just keeps carving fresh boards and bucketing whatever tier each
one lands at until every bucket is full, same as gen_puzzles.py + this
project's existing generate-a-pool-then-classify convention, just with
book-sized per-tier quotas built in instead of a flat --count.

Usage:
    python3 build_regionless_books.py [book_name ...]
    (with no args, builds every book in BOOKS; args restrict to a subset,
    matched against each spec's own "name")
"""

import csv
import random
import sys
import time

from board_utils import canonical_relabel, get_transformation_maps
from puzzle_deduper import PuzzleDeduper
from regionless_generator import RegionlessGenerator

DATA_DIR = "../data"

# Ascending difficulty, matching engine.py's TIER_ORDER (minus UNSOLVED,
# which never appears in a bucket -- generate_tier_ladder only returns
# tiers a puzzle was actually SOLVED at).
TIER_ORDER = ["Beginner", "Medium", "Hard", "Symmetry", "Expert", "Grandmaster"]

# Each book: (name, n, stars_per_unit, targets, bonus_tier, bonus_count,
# max_runs). targets: {tier: count} -- every tier the book wants, and how
# many puzzles it needs at that tier. bonus_tier/bonus_count: an EXTRA
# bucket of the bonus_count HIGHEST-SCORING (hardest) puzzles seen at
# bonus_tier, on top of (not instead of) anything targets already asks for
# at that tier -- used for the "N very very hard Grandmaster puzzles"
# finale. max_runs is a safety cap (calibrated from real sampling -- see
# this session's transcript -- with a >=3x safety margin over the
# estimated run count, so a legitimate slow patch doesn't trip it, but a
# truly wrong yield-rate assumption still fails loudly instead of hanging
# forever).
#
# 6x6_1star/8x8_1star's bonus_tier is None here -- the built-in bonus
# mechanism above only keeps ONE (random- or "hardest"-sampled) candidate
# per carve run, which turned out to barely beat what's already in a
# large main-tier bucket (see this session's 9x9 bonus investigation:
# [657,813]/[717,795] either way vs [756,895] once actually pooling every
# candidate a run passes through). Their Grandmaster finale is mined
# separately after the fact via mine_extreme_bonus (below), which does
# that full-history pooling properly.
BOOKS = [
    # Regenerated with real Expert-tier content once rule_tile_domino/
    # rule_tile_sees_too_much/rule_tile_region_subset (rules_single_star.py)
    # existed to populate it -- previously Expert was ~0% reachable for 1★
    # regionless at any size (see this session's original 6x6/8x8 books and
    # the "1★ rule-ladder gap" memory note). Hard dropped from ~65-70% to
    # ~7-9% per run once Expert-tier reasoning could absorb what used to
    # dead-end there -- now the bottleneck tier, not Beginner or Expert.
    ("6x6_1star",  6, 1, {"Beginner": 150, "Hard": 700, "Expert": 150}, None, 0, 30000),
    ("8x8_1star",  8, 1, {"Beginner": 150, "Hard": 700, "Expert": 150}, None, 0, 35000),
    ("9x9_2star",  9, 2, {"Beginner": 100, "Medium": 400, "Hard": 400, "Expert": 100}, None, 0, 4000),
    # Grown from the original 10/40/40/10 demo to match 9x9_2star's counts.
    # Calibration (21-run sample + the original demo run's own behavior):
    # Beginner/Medium ~100%, Hard ~95% per run, but Expert ~8-9% per run --
    # matches 9x9_2star's own observed Expert rate (100/1140 =~ 8.8%) almost
    # exactly, so that's the number this is sized against. Expected ~1150
    # runs (~3.3 hours at this size's ~10.5s/run); max_runs gives a
    # healthy margin in case the true rate is toward the low end of the
    # ~6-12% range this session's samples spanned.
    ("13x13_3star", 13, 3, {"Beginner": 100, "Medium": 400, "Hard": 400, "Expert": 100}, None, 0, 6000),
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


def build_book(name, n, stars_per_unit, targets, bonus_tier, bonus_count, max_runs,
               progress_every=500):
    gen = RegionlessGenerator(n, stars_per_unit=stars_per_unit)
    deduper = PuzzleDeduper()
    buckets = {tier: [] for tier in targets}
    bonus_pool = []  # (score, board_str, solution), only for bonus_tier

    def satisfied():
        return all(len(buckets[t]) >= c for t, c in targets.items())

    t0 = time.time()
    runs = 0
    while not satisfied() and runs < max_runs:
        runs += 1
        ladder = gen.generate_tier_ladder()
        if not ladder:
            continue
        for tier, (board_str, solution, score) in ladder.items():
            want_main = tier in targets and len(buckets[tier]) < targets[tier]
            want_bonus = bonus_tier is not None and tier == bonus_tier
            if not (want_main or want_bonus):
                continue

            board_str, solution = _randomize_orientation(board_str, solution, n)
            board_str = canonical_relabel(board_str)
            if deduper.is_duplicate([board_str], n):
                continue
            deduper.register([board_str], n)

            if want_main:
                buckets[tier].append((board_str, solution, score))
            if want_bonus:
                bonus_pool.append((score, board_str, solution))

        if runs % progress_every == 0:
            elapsed = time.time() - t0
            status = ", ".join(f"{t}={len(buckets[t])}/{c}" for t, c in targets.items())
            print(f"  [{name}] runs={runs} ({elapsed:.0f}s): {status}, "
                  f"bonus_pool={len(bonus_pool)}", flush=True)

    elapsed = time.time() - t0
    print(f"[{name}] {'DONE' if satisfied() else 'STOPPED (max_runs hit)'}: "
          f"{runs} runs in {elapsed:.0f}s", flush=True)
    if not satisfied():
        short = {t: (len(buckets[t]), c) for t, c in targets.items() if len(buckets[t]) < c}
        print(f"[{name}] WARNING: short on: {short}", flush=True)

    bonus = []
    if bonus_tier is not None and bonus_count > 0:
        bonus_pool.sort(key=lambda x: -x[0])
        bonus = bonus_pool[:bonus_count]
        print(f"[{name}] bonus ({bonus_tier}): picked top {len(bonus)} of "
              f"{len(bonus_pool)} by score, range "
              f"[{bonus[-1][0] if bonus else '-'}, {bonus[0][0] if bonus else '-'}]", flush=True)

    return buckets, bonus


def write_book_csv(path, n, entries):
    """entries: list of (board_str, solution, score, tier), in the order they
    should appear in the book."""
    with open(path, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["name", "N", "board_1", "solution", "score", "tier", "is_solved"])
        for i, (board_str, solution, score, tier) in enumerate(entries, start=1):
            writer.writerow([f"puzzle_{i}", n, board_str, solution, score, tier, True])


def main():
    only = set(sys.argv[1:]) or None
    for name, n, stars, targets, bonus_tier, bonus_count, max_runs in BOOKS:
        if only and name not in only:
            continue
        print(f"\n=== Building {name} (n={n}, stars={stars}) ===", flush=True)
        buckets, bonus = build_book(name, n, stars, targets, bonus_tier, bonus_count, max_runs,
                                     progress_every=100)

        # One combined book per size: every target tier in ascending
        # difficulty order, then any bonus_tier puzzles last (the "N very
        # very hard" finale) -- never interleaved with the tier they were
        # drawn from, even if bonus_tier also appears in targets. Within
        # each of those blocks (tier bucket, and the bonus block), sort by
        # score ascending too, so difficulty ramps up smoothly as you page
        # through the whole book, not just in coarse tier-sized jumps.
        entries = []
        for tier in TIER_ORDER:
            if tier in buckets:
                entries.extend((b, s, sc, tier) for b, s, sc in sorted(buckets[tier], key=lambda e: e[2]))
        entries.extend((b, s, sc, bonus_tier) for sc, b, s in sorted(bonus, key=lambda e: e[0]))

        path = f"{DATA_DIR}/{n}x{n}_regionless.csv"
        write_book_csv(path, n, entries)
        print(f"  wrote {len(entries)} rows -> {path}", flush=True)


# -- Post-hoc "extreme bonus" mining ------------------------------------------
#
# For multi-star (2*/3*) books, real Grandmaster tier is structurally
# unreachable for a single-board puzzle: the only ACTIVE multi-star
# Grandmaster rules are cross-board-only (rule_crossboard_region_line_
# partition_forced/quota_fill in composite_scorer.py) -- the lookahead-based
# ones that would work single-board are commented out there for performance,
# pre-dating this project. So "harder than Expert" for a regionless 2*/3*
# book can't mean a genuinely harder TIER the way it does for 1* (whose
# Grandmaster is real, single-board lookahead). Instead: mine a large fresh
# pool of Expert-tier candidates and keep the highest-SCORING few -- the most
# extreme examples Expert actually contains, still honestly labeled "Expert"
# (not a tier the scorer didn't actually assign).
#
# Reads the book's EXISTING csv, registers every board already in it with a
# PuzzleDeduper so a freshly-mined candidate that happens to collide (same
# board under some dihedral orientation) gets skipped, mines until
# pool_target distinct mine_tier candidates are found (or max_runs is hit),
# takes the top `count` by score, and appends them to the end of the book
# (sequential renumbering, so the book stays one clean puzzle_1..puzzle_N
# sequence with difficulty still only ramping up).
#
# Uses generate_full_history() rather than generate_tier_ladder(): a single
# run can pass through MANY distinct boards at mine_tier before graduating
# or exhausting candidates, and keeping only one per run (whether random or
# "hardest") throws almost all of that away. Pooling every one of them
# (still deduped) gets a much larger, richer sample per unit of carve time,
# which matters here specifically because the goal is the tail of the
# distribution (the few most extreme examples), not a single "typical"
# pick -- see this session's own before/after comparison in the transcript:
# switching hardest-per-run barely moved the observed max at all, while
# pooling full histories did.
def mine_extreme_bonus(book_name, n, stars_per_unit, mine_tier, count, pool_target, max_runs,
                        progress_every=50):
    path = f"{DATA_DIR}/{n}x{n}_regionless.csv"
    with open(path, newline="") as f:
        existing_rows = list(csv.DictReader(f))

    deduper = PuzzleDeduper()
    for row in existing_rows:
        deduper.register([row["board_1"]], n)

    gen = RegionlessGenerator(n, stars_per_unit=stars_per_unit)
    pool = []  # (score, board_str, solution)
    t0 = time.time()
    runs = 0
    while len(pool) < pool_target and runs < max_runs:
        runs += 1
        history = gen.generate_full_history()
        if not history or mine_tier not in history:
            continue
        for board_str, solution, score in history[mine_tier]:
            board_str, solution = _randomize_orientation(board_str, solution, n)
            board_str = canonical_relabel(board_str)
            if deduper.is_duplicate([board_str], n):
                continue
            deduper.register([board_str], n)
            pool.append((score, board_str, solution))

        if runs % progress_every == 0:
            print(f"  [{book_name} bonus] runs={runs} ({time.time() - t0:.0f}s): "
                  f"pool={len(pool)}/{pool_target}", flush=True)

    print(f"[{book_name} bonus] {'DONE' if len(pool) >= pool_target else 'STOPPED (max_runs hit)'}: "
          f"{runs} runs in {time.time() - t0:.0f}s, pool={len(pool)}", flush=True)

    pool.sort(key=lambda x: -x[0])
    picked = pool[:count]
    print(f"[{book_name} bonus] picked top {len(picked)} of {len(pool)} by score, "
          f"range [{picked[-1][0] if picked else '-'}, {picked[0][0] if picked else '-'}]", flush=True)
    picked.sort(key=lambda x: x[0])  # write ascending, so the single hardest lands last in the book

    with open(path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=existing_rows[0].keys())
        writer.writeheader()
        i = 0
        for row in existing_rows:
            i += 1
            row["name"] = f"puzzle_{i}"
            writer.writerow(row)
        for score, board_str, solution in picked:
            i += 1
            writer.writerow({"name": f"puzzle_{i}", "N": n, "board_1": board_str,
                              "solution": solution, "score": score, "tier": mine_tier,
                              "is_solved": True})
    print(f"[{book_name} bonus] appended {len(picked)} rows -> {path} ({i} total)", flush=True)


if __name__ == "__main__":
    if len(sys.argv) > 2 and sys.argv[1] == "bonus":
        # python3 build_regionless_books.py bonus <book_name> <mine_tier> <count> <pool_target> <max_runs>
        _, _, book_name, mine_tier, count, pool_target, max_runs = sys.argv
        spec = next(b for b in BOOKS if b[0] == book_name)
        _, n, stars, *_ = spec
        mine_extreme_bonus(book_name, n, stars, mine_tier, int(count), int(pool_target), int(max_runs))
    else:
        main()
