#!/usr/bin/env python3
"""
build_books.py

Rebuilds the curated "book" CSVs in data/ from the big scratch pools in
tools/library/, driven by declarative recipes in tools/books/*.toml.

Each recipe says: which library CSV to draw from, and for each tier a score
range and a count. The selection itself is the same idea as book_gen.py
(split the range into `count` equal bins, claim the unused candidate closest
to each bin's centre, backfill any shortfall) but implemented with a sorted
list + bisect so it stays fast on pools with millions of rows.

Nothing touches data/ unless you ask: books are built into
tools/books_staging/, a report is printed, and `--promote` copies the
finished books over to data/.

Recipe format (tools/books/<name>.toml)
---------------------------------------
    # optional named score ranges, shared by books in this file
    [ranges.8x8]
    Beginner = [12, 85]
    Hard     = [125, 275]

    [[book]]
    out    = "8x8_hard"                     # -> data/8x8_hard.csv
    source = "one_star/puzzles8_scored.csv" # relative to tools/library/
    ranges = "8x8"                          # take min/max from [ranges.8x8]
    tier   = "Hard"                         # single-tier shorthand ...
    count  = 1000
    bonus  = { Grandmaster = 5 }            # top-N by score from the whole pool,
                                            #   appended after the main rows
    carry  = ["UNSOLVED"]                   # copy these tiers' rows from the
                                            #   existing data/<out>.csv
    shuffle = false                         # shuffle the main rows (daily books)
    notes   = "free text, shown in reports"
    blocked = "reason"                      # still stages, but --promote refuses it (unless --force)
    allow_short = true                      # (per segment) if the pool has fewer than
                                            #   `count` in range, take all of them and warn
                                            #   instead of failing -- for pools we intend to grow

    # ... or, for multi-tier books, a list of segments (each may give explicit
    # min/max instead of using `ranges`):
    tiers = [ {tier="Medium", count=400}, {tier="Hard", count=400, min=1, max=2} ]

Groups (split books)
--------------------
A row's group comes from its normalized name suffix: names look like
`puzzle_<id>_<suffix>` and the suffix is everything after the id. A book may
split every tier segment among groups:

    group_by = "suffix"
    groups   = { rot180 = ["rot180"], rot90 = ["rot90"],
                 flip = ["flip_diag", "flip_antidiag"] }   # label -> suffix globs
    shares   = { rot180 = 0.35, rot90 = 0.30, flip = 0.35 }  # default: equal
    # or: groups = ["a", "b", "c"]   -> each suffix is its own group, equal shares

Each segment's `count` is apportioned by `shares` (largest remainder). A group
that has fewer candidates in range than its target gives what it has, and the
shortfall is spread over the other groups by repeatedly raising whichever
currently has the smallest allocation ("level fill"), so groups end up as even
as availability allows. A group with share 0 is eligible only as backfill.
Optional `fill = "proportional"` raises whichever group has the smallest allocation/share
instead, so groups keep their share proportions as availability allows; optional
`backfill = ["a", "b"]` names groups that absorb a shortfall before anyone else (levelled
among themselves, up to what they have), after which `fill` takes over.
Optional two-level allocation: `families = { a = ["g1","g2"], b = ["g3"] }` (every group in exactly one family),
`family_shares = { a = 1, b = 1 }` and `family_no_spill = ["b"]`: the count is first split among the families, a family
that can't supply its share is made up by the other families (never by the `family_no_spill` ones), and inside each
family the groups' `shares` apply with proportional fill.
Suffixes not matched by any group are excluded. `bonus` counts are split by
shares too (top scores within each group, same level-fill backfill); or give
`bonus_each = { Grandmaster = 2 }` for exactly that many top-scoring rows from
EACH group (fewer if a group lacks them; no backfill). Within a merged group
(like `flip`) rows are pooled and spread by score, not split evenly.

A segment may carry `pick = "easiest"` (or `"hardest"`): instead of spreading the picks evenly over the score range, take exactly the `count`
lowest- (highest-) scoring candidates in range, ties broken by the content-hash tie key. Not combinable with groups.

A segment may instead carry `suffix = "t180"` (or a list of globs): it then draws ONLY from rows whose
suffix matches, uniformly over its range, outside the book's groups/shares. Use it for a small
small "bonus" family, e.g.
    {tier="Beginner", count=25, suffix="t180"}
Segments of the same tier are merged into ONE block of the book, sorted by score, so such a bonus
family is interleaved into its tier\'s section instead of trailing the book.

UNSOLVED bonus: `bonus = { UNSOLVED = 2 }` / `bonus_each = { UNSOLVED = 1 }` take the HARDEST UNSOLVED rows from
the pool: lowest score = fewest cells decided before the solver got stuck (Grandmaster is the highest scores). This is only
meaningful if the pool's UNSOLVED scores use the current meaning (scored after 2026-09-30), so rescore a pool before
building UNSOLVED bonus rows from an old one.

Regionless UNSOLVED rule: `unsolved_extremes = true` picks up to TWO UNSOLVED rows per book (where possible): among the
UNSOLVED rows with score 0 (no rule ever fired), the DENSEST (fewest void cells in board_1) and the SPARSEST (most void
cells). If the pool has NO score-0 UNSOLVED puzzle, it takes the 3 HARDEST (lowest-score) UNSOLVED rows instead. For grouped books only rows belonging to a group are considered.

Why `carry`: UNSOLVED bonus rows are hand-picked (ranked by cells filled
before the solver stalls -- see find_hardest_unsolved.py) and sometimes come
from special generation runs, so they can't be re-derived from the pool. A
carried row is refreshed from the pool when it is found there; if a rescore
has made it solvable it is dropped with a warning (it no longer belongs in
the UNSOLVED section).

Usage
-----
    python3 build_books.py --list
    python3 build_books.py one_star                # every book in books/one_star.toml
    python3 build_books.py 8x8_medium 8x8_hard     # specific books
    python3 build_books.py --all [--seed 1]
    python3 build_books.py --all --promote         # build, then copy to data/
    python3 build_books.py 8x8_medium --promote-staged   # copy an already-built book
"""

import argparse
import bisect
import csv
import fnmatch
import glob
import hashlib
import heapq
import os
import random
import re
import shutil
import subprocess
import sys
import tomllib
from collections import Counter, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from board_utils import VOID_CHAR  # noqa: E402

LIB_DIR = os.path.join(HERE, "library")
BOOKS_DIR = os.path.join(HERE, "books")
STAGING_DIR = os.path.join(HERE, "books_staging")
DATA_DIR = os.path.join(HERE, "..", "data")

csv.field_size_limit(10**9)

BOOK_KEYS = {"out", "source", "ranges", "tier", "count", "min", "max", "tiers",
             "bonus", "carry", "shuffle", "notes", "allow_short",
             "group_by", "groups", "shares", "bonus_each", "blocked", "unsolved_extremes",
             "order_by_group", "rename", "fill", "backfill", "families", "family_shares", "family_no_spill"}
SUFFIX_RE = re.compile(r"puzzle_\d+_(.+)")
SEG_KEYS = {"tier", "count", "min", "max", "allow_short", "suffix", "pick"}


class BookError(Exception):
    pass


# --------------------------------------------------------------------------
# Spec loading
# --------------------------------------------------------------------------

def load_specs():
    specs = []
    seen_out = {}
    for path in sorted(glob.glob(os.path.join(BOOKS_DIR, "*.toml"))):
        stem = os.path.splitext(os.path.basename(path))[0]
        with open(path, "rb") as f:
            doc = tomllib.load(f)
        ranges = doc.get("ranges", {})
        for raw in doc.get("book", []):
            try:
                spec = _normalize_book(raw, ranges)
            except BookError as e:
                raise BookError(f"{stem}.toml: book {raw.get('out', '?')!r}: {e}") from None
            spec["file"] = stem
            if spec["out"] in seen_out:
                raise BookError(f"{stem}.toml: duplicate book {spec['out']!r} "
                                f"(also in {seen_out[spec['out']]}.toml)")
            seen_out[spec["out"]] = stem
            specs.append(spec)
    return specs


def _normalize_book(raw, ranges):
    unknown = set(raw) - BOOK_KEYS
    if unknown:
        raise BookError(f"unknown key(s) {sorted(unknown)}")
    for k in ("out", "source"):
        if k not in raw:
            raise BookError(f"missing {k!r}")

    if "tiers" in raw:
        if "tier" in raw:
            raise BookError("give either `tier` or `tiers`, not both")
        segs = [dict(s) for s in raw["tiers"]]
    elif "tier" in raw:
        segs = [{k: raw[k] for k in SEG_KEYS if k in raw}]
    else:
        raise BookError("needs `tier` or `tiers`")

    table = None
    if "ranges" in raw:
        if raw["ranges"] not in ranges:
            raise BookError(f"no [ranges.{raw['ranges']}] table in this file")
        table = ranges[raw["ranges"]]

    for s in segs:
        bad = set(s) - SEG_KEYS
        if bad or "tier" not in s or "count" not in s:
            raise BookError(f"bad segment {s} (needs tier+count; allowed {sorted(SEG_KEYS)})")
        if "min" not in s or "max" not in s:
            if table is None or s["tier"] not in table:
                raise BookError(f"segment {s['tier']}: no min/max and no `ranges` entry for it")
            s["min"], s["max"] = table[s["tier"]]
        if s["min"] > s["max"] or s["count"] <= 0:
            raise BookError(f"segment {s['tier']}: bad min/max/count")
        if "suffix" in s:
            s["suffix"] = [s["suffix"]] if isinstance(s["suffix"], str) else list(s["suffix"])
        if s.get("pick", "spread") not in ("spread", "easiest", "hardest"):
            raise BookError(f"segment {s['tier']}: pick must be spread, easiest or hardest")
        if s.get("pick", "spread") != "spread" and s.get("suffix"):
            raise BookError(f"segment {s['tier']}: pick = easiest/hardest isn't supported with suffix segments")

    groups = shares = None
    if "groups" in raw or "shares" in raw or "group_by" in raw:
        if raw.get("group_by", "suffix") != "suffix":
            raise BookError("only group_by = \"suffix\" is supported")
        g = raw.get("groups")
        if not g:
            raise BookError("`shares`/`group_by` given without `groups`")
        groups = {x: [x] for x in g} if isinstance(g, list) else \
            {k: ([v] if isinstance(v, str) else list(v)) for k, v in g.items()}
        shares = {k: float(v) for k, v in raw.get("shares", {}).items()}
        bad = set(shares) - set(groups)
        if bad:
            raise BookError(f"`shares` names unknown group(s) {sorted(bad)}")
        for k in groups:
            shares.setdefault(k, 1.0 if not raw.get("shares") else 0.0)
        if sum(shares.values()) <= 0:
            raise BookError("group shares sum to zero")

    fill = raw.get("fill", "level")
    if fill not in ("level", "proportional"):
        raise BookError("`fill` must be \"level\" or \"proportional\"")
    backfill = list(raw.get("backfill", []))
    if backfill and not groups:
        raise BookError("`backfill` needs `groups`")
    bad = set(backfill) - set(groups or ())
    if bad:
        raise BookError(f"`backfill` names unknown group(s) {sorted(bad)}")

    families = fam_shares = None
    fam_no_spill = []
    if "families" in raw:
        if not groups:
            raise BookError("`families` needs `groups`")
        families = {k: list(v) for k, v in raw["families"].items()}
        placed = [g for gs in families.values() for g in gs]
        if sorted(placed) != sorted(groups) or len(set(placed)) != len(placed):
            raise BookError("`families` must list every group exactly once")
        fam_shares = {k: float(v) for k, v in raw.get("family_shares", {}).items()}
        bad = set(fam_shares) - set(families)
        if bad:
            raise BookError(f"`family_shares` names unknown famil(ies) {sorted(bad)}")
        for k in families:
            fam_shares.setdefault(k, 1.0)
        fam_no_spill = list(raw.get("family_no_spill", []))
        bad = set(fam_no_spill) - set(families)
        if bad:
            raise BookError(f"`family_no_spill` names unknown famil(ies) {sorted(bad)}")
        if raw.get("backfill"):
            raise BookError("`backfill` can't be combined with `families`")
    elif raw.get("family_shares") or raw.get("family_no_spill"):
        raise BookError("`family_shares`/`family_no_spill` need `families`")

    bonus = dict(raw.get("bonus", {}))
    bonus_each = dict(raw.get("bonus_each", {}))
    if bonus_each and not groups:
        raise BookError("`bonus_each` needs `groups`")
    if set(bonus) & set(bonus_each):
        raise BookError(f"tier(s) {sorted(set(bonus) & set(bonus_each))} in both `bonus` and `bonus_each`")
    if raw.get("unsolved_extremes") and ("UNSOLVED" in bonus or "UNSOLVED" in bonus_each or "UNSOLVED" in raw.get("carry", [])):
        raise BookError("`unsolved_extremes` can't be combined with an UNSOLVED bonus/bonus_each/carry")
    # UNSOLVED bonus rows: the HARDEST are the ones with the fewest decided cells, i.e. the LOWEST score
    # (scorer/engine.py scores an UNSOLVED puzzle by cells decided before the solver stuck). Only valid
    # for pools whose UNSOLVED scores are current (rescore an old pool first).
    return {
        "out": raw["out"],
        "source": raw["source"],
        "segments": segs,
        "bonus": bonus,
        "bonus_each": bonus_each,
        "carry": list(raw.get("carry", [])),
        "unsolved_extremes": bool(raw.get("unsolved_extremes", False)),
        "shuffle": bool(raw.get("shuffle", False)),
        "order_by_group": bool(raw.get("order_by_group", False)),
        "rename": raw.get("rename", ""),
        "notes": raw.get("notes", ""),
        "blocked": raw.get("blocked", ""),
        "groups": groups,
        "shares": shares,
        "fill": fill,
        "backfill": backfill,
        "families": families,
        "family_shares": fam_shares,
        "family_no_spill": fam_no_spill,
    }


# --------------------------------------------------------------------------
# Stable tie-break key
# --------------------------------------------------------------------------
# Every "ties are broken at random" decision uses this per-puzzle key instead of a shuffle: a 64-bit hash of the
# puzzle's own content (all boards + solution), salted with --seed. It depends on nothing else -- not the pool's row
# order, not its size, not the puzzle's name -- so rescoring a pool (which reorders rows and moves a few scores) or
# growing it only disturbs the puzzles that actually changed, instead of reshuffling every group of equal scores.

def make_tie_key(seed, bcols, sol_i):
    salt = f"{seed}|".encode()

    def tie_key(row):
        h = hashlib.blake2b(salt, digest_size=8)
        for i in bcols:
            h.update(row[i].encode())
            h.update(b"|")
        h.update(row[sol_i].encode())
        return int.from_bytes(h.digest(), "big")
    return tie_key


# --------------------------------------------------------------------------
# Selection (same semantics as book_gen.select_uniform, but O(count log n))
# --------------------------------------------------------------------------

def select_uniform_fast(cands, lo, hi, count, tk):
    """
    cands: list of (score, key). Returns `count` of them, spread as evenly as
    possible over [lo, hi]. For each bin centre in turn, claims the unused
    candidate whose score is closest (ties go to the lower score); if some
    bins end up unfilled the same centres are cycled until `count` is reached.
    Candidates with equal scores are taken in the order of their content-hash tie key (tk: record index -> key).
    """
    n = len(cands)
    if n < count:
        raise BookError(f"only {n} candidates for {count} slots")
    cands = sorted(cands, key=lambda c: (c[0], tk[c[1]]))
    scores = [c[0] for c in cands]

    # nxt[i] = smallest free element >= i (n = none).
    # prv[k] = largest free node <= k, where node k is element k-1 (0 = none).
    nxt = list(range(n + 2))
    prv = list(range(n + 2))

    def find(parent, i):
        root = i
        while parent[root] != root:
            root = parent[root]
        while parent[i] != root:
            parent[i], i = root, parent[i]
        return root

    def claim_closest(c):
        i = bisect.bisect_left(scores, c)
        r = find(nxt, i)
        lnode = find(prv, i)  # node i == element i-1
        r_ok = r < n
        l_ok = lnode > 0
        if l_ok and (not r_ok or c - scores[lnode - 1] <= scores[r] - c):
            j = lnode - 1
        else:
            j = r
        nxt[j] = j + 1
        prv[j + 1] = j
        return cands[j]

    if count == 1:
        centers = [(lo + hi) / 2.0]
    else:
        w = (hi - lo) / count
        centers = [lo + w * (i + 0.5) for i in range(count)]

    out = []
    idx = 0
    while len(out) < count:
        out.append(claim_closest(centers[idx % len(centers)]))
        idx += 1
    return out


# --------------------------------------------------------------------------
# Groups
# --------------------------------------------------------------------------

class Grouper:
    """Maps a row name to its group label (or None = excluded)."""

    def __init__(self, groups):
        self.groups = groups
        self._cache = {}

    def label(self, name):
        m = SUFFIX_RE.fullmatch(name)
        suffix = m.group(1) if m else None
        if suffix not in self._cache:
            lab = None
            if suffix is not None:
                for k, pats in self.groups.items():
                    if any(fnmatch.fnmatchcase(suffix, pat) for pat in pats):
                        lab = k
                        break
            self._cache[suffix] = lab
        return self._cache[suffix]


def apportion(count, shares):
    """Largest-remainder split of `count` by `shares` (dict label -> weight)."""
    total = float(sum(shares.values()))
    quota = {g: count * w / total for g, w in shares.items()}
    out = {g: int(q) for g, q in quota.items()}
    left = count - sum(out.values())
    for g in sorted(shares, key=lambda g: -(quota[g] - out[g]))[:left]:
        out[g] += 1
    return out


def allocate(count, shares, avail, fill="level", backfill=()):
    """
    Per-group counts for a segment: apportioned targets, capped by availability,
    with the shortfall filled from the groups that still have spare rows.
      fill="level" (default): the group with the smallest allocation is raised first.
      fill="proportional": the group with the smallest allocation/share is raised first,
        so the groups keep their share proportions as availability allows (share-0 groups
        are only raised after every positive-share group is exhausted).
      backfill: groups that absorb the shortfall before anyone else (levelled among
        themselves, up to their availability), then `fill` takes over for what remains.
    Returns (alloc, targets).
    """
    targets = apportion(count, shares)
    alloc = {g: min(targets[g], avail.get(g, 0)) for g in shares}
    order = list(shares)
    need = count - sum(alloc.values())
    backfill = [g for g in backfill if g in shares]
    while need > 0:
        open_ = [g for g in backfill if alloc[g] < avail.get(g, 0)]
        if open_:
            g = min(open_, key=lambda g: alloc[g])
        else:
            open_ = [g for g in order if alloc[g] < avail.get(g, 0)]
            if not open_:
                break
            if fill == "proportional":
                g = min(open_, key=lambda g: (alloc[g] / shares[g]) if shares[g] > 0 else float("inf"))
            else:
                g = min(open_, key=lambda g: alloc[g])
        alloc[g] += 1
        need -= 1
    return alloc, targets


def allocate_families(count, shares, avail, families, fam_shares, no_spill=()):
    """
    Two-level allocation for a segment. Level 1 splits `count` among the FAMILIES by `fam_shares`; a family can supply
    at most the sum of its groups' availability, and its shortfall is spread over the other families (those not in
    `no_spill`) in proportion to their family shares. Level 2 splits each family's count among its groups by `shares`
    (proportional fill: a group short of its share is made up by its siblings, in proportion). Returns (alloc, targets)
    over groups; `targets` are the group targets inside the family's final count.
    """
    inf = float("inf")
    cap = {f: sum(avail.get(g, 0) for g in gs) for f, gs in families.items()}
    fam_alloc = {f: min(t, cap[f]) for f, t in apportion(count, fam_shares).items()}
    need = count - sum(fam_alloc.values())
    while need > 0:
        open_ = [f for f in families if f not in no_spill and fam_alloc[f] < cap[f]]
        if not open_:
            break
        f = min(open_, key=lambda f: fam_alloc[f] / fam_shares[f] if fam_shares[f] > 0 else inf)
        fam_alloc[f] += 1
        need -= 1
    alloc, targets = {}, {}
    for f, gs in families.items():
        a, t = allocate(fam_alloc[f], {g: shares[g] for g in gs}, avail, "proportional")
        alloc.update(a)
        targets.update(t)
    return alloc, targets


# --------------------------------------------------------------------------
# Pool scanning
# --------------------------------------------------------------------------

def _read_header(path):
    with open(path, newline="") as f:
        header = next(csv.reader(f), None)
    if not header or header[:2] != ["name", "N"]:
        raise BookError(f"{path}: header must start with 'name,N'")
    for col in ("tier", "score", "board_1"):
        if col not in header:
            raise BookError(f"{path}: header missing {col!r}")
    return header


def _load_existing(out):
    """Current data/<out>.csv as (header, rows), or (None, [])."""
    path = os.path.join(DATA_DIR, out + ".csv")
    if not os.path.exists(path):
        return None, []
    with open(path, newline="") as f:
        rows = list(csv.reader(f))
    rows = [r for r in rows if r]
    return rows[0], rows[1:]


class BookJob:
    """Per-book working state while a shared source file is scanned."""

    def __init__(self, spec, rng):
        self.spec = spec
        self.rng = rng
        self.grouper = Grouper(spec["groups"]) if spec["groups"] else None
        # (score, rec_idx) lists; per-group dicts of lists when the book has groups
        self.cands = [[] if seg.get("suffix") else (defaultdict(list) if self.grouper else [])
                      for seg in spec["segments"]]
        # bonus heaps keep the top-N scores (per group when grouped, so the allocator
        # can level-fill from groups with spare rows)
        self.bonus_quota = {**spec["bonus"], **spec["bonus_each"]}   # heap capacity per tier
        if self.grouper:
            self.bonus = {t: defaultdict(list) for t in self.bonus_quota}   # label -> heap
        else:
            self.bonus = {t: [] for t in self.bonus_quota}  # heap of (score, tiebreak, rec_idx)
        self.bonus_groups = {}                           # tier -> [(label, alloc, target, avail)]
        self.seg_groups = {}                             # seg idx -> [(label, alloc, target, avail)]
        self.old_header, self.old_rows = _load_existing(spec["out"])
        self.carry_old = []
        if spec["carry"] and self.old_header:
            ti = self.old_header.index("tier")
            self.carry_old = [r for r in self.old_rows if r[ti] in spec["carry"]]
        self.carry_boards = {r[self.old_header.index("board_1")] for r in self.carry_old} \
            if self.carry_old else set()
        self.carry_found = {}                            # board_1 -> (rec_idx, tier)
        self.pool_tier_counts = Counter()
        self.chosen = []                                 # list of (segment_idx, rec_idx)
        self.cur_k = 0                                   # segment being selected (for error messages)
        self.bonus_chosen = []
        self.short = []                                  # segments filled via allow_short
        self.extremes = []                               # unsolved_extremes picks: (idx, label, void cells)
        self.us_lowest = []                              # unsolved_extremes fallback: the 3 lowest-score rows (score, tiebreak, idx)
        self.us_min = None                               # unsolved_extremes: lowest UNSOLVED score seen
        self.us_dense = self.us_sparse = None            # (voids, tiebreak, idx) / (-voids, tiebreak, idx)

    def n_cands(self, k):
        c = self.cands[k]
        return sum(len(v) for v in c.values()) if isinstance(c, dict) else len(c)


def scan_source(source_rel, jobs, seed="1"):
    """One pass over a library CSV, feeding every job that uses it."""
    path = os.path.join(LIB_DIR, source_rel)
    if not os.path.exists(path):
        raise BookError(f"source not found: {path}")
    header = _read_header(path)
    ti, si, bi = header.index("tier"), header.index("score"), header.index("board_1")

    # tier -> [(job, seg_idx, lo, hi)]
    by_tier = defaultdict(list)
    bonus_by_tier = defaultdict(list)
    for job in jobs:
        for k, seg in enumerate(job.spec["segments"]):
            by_tier[seg["tier"]].append((job, k, seg["min"], seg["max"]))
        for t in job.bonus_quota:
            bonus_by_tier[t].append(job)
    carry_jobs = [j for j in jobs if j.carry_boards]
    ext_jobs = [j for j in jobs if j.spec["unsolved_extremes"]]

    bcols = [i for i, c in enumerate(header) if re.fullmatch(r"board_\d+", c)]
    tie_key = make_tie_key(seed, bcols, header.index("solution"))
    tk = {}               # record index -> content-hash tie key, for every row offered as a candidate
    for job in jobs:
        job.tk, job.tie_key = tk, tie_key
    seen = set()          # tie keys of puzzles already offered as candidates (exact-dup pool rows)
    dups_skipped = 0
    total = 0
    tier_scores = {t: [] for t in by_tier}   # every score per wanted tier, for shortfall hints
    with open(path, newline="") as f:
        reader = csv.reader(f)
        next(reader)
        for idx, row in enumerate(reader):
            if not row:
                continue
            if len(row) != len(header):
                raise BookError(f"{source_rel}: record {idx + 1} has {len(row)} fields, header has "
                                f"{len(header)} (hacked/mixed-schema file?)")
            total += 1
            tier = row[ti]
            try:
                score = float(row[si])
            except (ValueError, IndexError):
                continue
            if tier in tier_scores:
                tier_scores[tier].append(score)
            for job in jobs:
                job.pool_tier_counts[tier] += 1
            if carry_jobs:
                b = row[bi]
                for job in carry_jobs:
                    if b in job.carry_boards:
                        job.carry_found[b] = (idx, tier)
            if tier == "UNSOLVED" and ext_jobs:
                voids = row[bi].count(VOID_CHAR)
                dg = tie_key(row)
                for job in ext_jobs:
                    if job.grouper and job.grouper.label(row[0]) is None:
                        continue
                    job.us_lowest.append((score, dg, idx))
                    job.us_lowest.sort()
                    del job.us_lowest[3:]
                    if job.us_min is None or score < job.us_min:
                        job.us_min, job.us_dense, job.us_sparse = score, None, None
                    if score == job.us_min:
                        tb = dg
                        if job.us_dense is None or (voids, tb) < job.us_dense[:2]:
                            job.us_dense = (voids, tb, idx)
                        if job.us_sparse is None or (-voids, -tb) < job.us_sparse[:2]:   # opposite tie-break end, so
                            job.us_sparse = (-voids, -tb, idx)                           # all-equal pools still give 2 rows
            hits = []
            for job, k, lo, hi in by_tier.get(tier, ()):
                if lo <= score <= hi:
                    seg_suffix = job.spec["segments"][k].get("suffix")
                    if seg_suffix:   # segment restricted to specific suffixes, outside the book's groups
                        m = SUFFIX_RE.fullmatch(row[0])
                        if m and any(fnmatch.fnmatchcase(m.group(1), pat) for pat in seg_suffix):
                            hits.append((job, k, None))
                        continue
                    g = job.grouper.label(row[0]) if job.grouper else None
                    if job.grouper and g is None:
                        continue
                    hits.append((job, k, g))
            bonus_jobs = []
            for job in bonus_by_tier.get(tier, ()):
                g = job.grouper.label(row[0]) if job.grouper else None
                if job.grouper and g is None:
                    continue
                bonus_jobs.append((job, g))
            if not hits and not bonus_jobs:
                continue
            key = tie_key(row)
            if key in seen:
                dups_skipped += 1
                continue
            seen.add(key)
            tk[idx] = key
            for job, k, g in hits:
                (job.cands[k][g] if isinstance(job.cands[k], dict) else job.cands[k]).append((score, idx))
            for job, g in bonus_jobs:
                heap = job.bonus[tier][g] if job.grouper else job.bonus[tier]
                heapq.heappush(heap, (-score if tier == "UNSOLVED" else score, key, idx))
                if len(heap) > job.bonus_quota[tier]:
                    heapq.heappop(heap)
    return header, total, tier_scores, dups_skipped


def fetch_rows(source_rel, wanted):
    path = os.path.join(LIB_DIR, source_rel)
    got = {}
    with open(path, newline="") as f:
        reader = csv.reader(f)
        next(reader)
        for idx, row in enumerate(reader):
            if idx in wanted:
                got[idx] = row
    return got


# --------------------------------------------------------------------------
# Building
# --------------------------------------------------------------------------

def build_group(source_rel, specs, seed, dup_check):
    """Build every spec that draws from one source file. Returns [(spec, ok, text)]."""
    jobs = [BookJob(s, random.Random(f"{seed}:{s['out']}")) for s in specs]
    header, total, tier_scores, dups_skipped = scan_source(source_rel, jobs, seed)
    for job in jobs:
        job.dups_skipped = dups_skipped

    results = []
    live = []
    for job in jobs:
        spec = job.spec
        try:
            # `pick` segments go first, and what they take is removed from the other segments of the same tier
            # (so "400 spread + the 52 hardest" never selects a puzzle twice)
            order = sorted(range(len(spec["segments"])), key=lambda i: spec["segments"][i].get("pick", "spread") == "spread")
            for k in order:
                seg = spec["segments"][k]
                job.cur_k = k
                if job.grouper and not seg.get("suffix"):
                    got = _select_grouped(job, k, seg)
                elif seg.get("allow_short") and len(job.cands[k]) < seg["count"]:
                    got = list(job.cands[k])
                    job.short.append(f"{seg['tier']} {len(got)}/{seg['count']}")
                elif seg.get("pick") in ("easiest", "hardest"):
                    if len(job.cands[k]) < seg["count"] and not seg.get("allow_short"):
                        raise BookError("too few candidates")
                    cands = sorted(job.cands[k], key=lambda c: (c[0], job.tk[c[1]]), reverse=(seg["pick"] == "hardest"))
                    got = cands[:seg["count"]]
                    used = {idx for _, idx in got}
                    for k2, seg2 in enumerate(spec["segments"]):
                        if k2 != k and seg2["tier"] == seg["tier"] and not seg2.get("suffix") and not job.grouper:
                            job.cands[k2] = [c for c in job.cands[k2] if c[1] not in used]
                else:
                    got = select_uniform_fast(job.cands[k], seg["min"], seg["max"], seg["count"], job.tk)
                job.chosen.append((k, got))
            for t in spec["bonus_each"]:
                n = spec["bonus_each"][t]
                flat = []
                job.bonus_groups[t] = []
                for g in spec["shares"]:
                    top = sorted(job.bonus[t].get(g, ()), reverse=True)[:n]
                    flat.extend(top)
                    job.bonus_groups[t].append((g, len(top), n, len(job.bonus[t].get(g, ()))))
                job.bonus_chosen.append((t, sorted(flat)))
            for t in spec["bonus"]:
                if job.grouper:
                    avail = {g: len(job.bonus[t].get(g, ())) for g in spec["shares"]}
                    alloc, targets = allocate(spec["bonus"][t], spec["shares"], avail)
                    flat = []
                    for g, n in alloc.items():
                        flat.extend(sorted(job.bonus[t].get(g, ()), reverse=True)[:n])
                    job.bonus_groups[t] = [(g, alloc[g], targets[g], avail[g]) for g in spec["shares"]]
                    job.bonus_chosen.append((t, sorted(flat)))
                else:
                    job.bonus_chosen.append((t, sorted(job.bonus[t])))
            if spec["unsolved_extremes"] and job.us_lowest and job.us_min != 0:
                # no score-0 UNSOLVED puzzle in this pool: take the 3 hardest (lowest scores) instead
                job.extremes = [(idx, "hardest", sc) for sc, _, idx in job.us_lowest]
                job.bonus_chosen.append(("UNSOLVED", [(0, 0, idx) for idx, _, _ in job.extremes]))
            elif spec["unsolved_extremes"] and job.us_dense is not None:
                picks = {job.us_dense[2]: ("densest", job.us_dense[0]),
                         job.us_sparse[2]: ("sparsest", -job.us_sparse[0])}
                job.extremes = [(idx, label, voids) for idx, (label, voids) in picks.items()]
                job.bonus_chosen.append(("UNSOLVED", [(0, 0, idx) for idx, _, _ in job.extremes]))
            live.append(job)
        except BookError as e:
            k = job.cur_k
            seg = spec["segments"][k]
            results.append((spec, False, [],
                f"  ERROR {seg['tier']} [{seg['min']:g},{seg['max']:g}]: wanted {seg['count']}, "
                f"pool only has {job.n_cands(k)} in range "
                f"(pool tiers: {dict(job.pool_tier_counts)})\n"
                + (f"  per-group availability: { {g: len(v) for g, v in job.cands[k].items()} }"
                   if isinstance(job.cands[k], dict) else _shortfall_hint(seg, tier_scores[seg["tier"]]))))

    wanted = set()
    for job in live:
        for _, got in job.chosen:
            wanted.update(idx for _, idx in got)
        for _, got in job.bonus_chosen:
            wanted.update(idx for _, _, idx in got)
        wanted.update(idx for idx, tier in job.carry_found.values() if tier in job.spec["carry"])
    rows = fetch_rows(source_rel, wanted)

    for job in live:
        results.append(_finish_job(job, header, rows, total, source_rel, dup_check))
    return results


def _select_grouped(job, k, seg):
    spec = job.spec
    avail = {g: len(job.cands[k].get(g, ())) for g in spec["shares"]}
    if spec["families"]:
        alloc, targets = allocate_families(seg["count"], spec["shares"], avail, spec["families"],
                                           spec["family_shares"], spec["family_no_spill"])
    else:
        alloc, targets = allocate(seg["count"], spec["shares"], avail, spec["fill"], spec["backfill"])
    got_total = sum(alloc.values())
    if got_total < seg["count"]:
        if not seg.get("allow_short"):
            raise BookError(f"only {got_total} candidates across groups for {seg['count']} slots")
        job.short.append(f"{seg['tier']} {got_total}/{seg['count']}")
    got = []
    for g, n in alloc.items():
        if not n:
            continue
        if seg.get("pick", "spread") in ("easiest", "hardest"):      # the n easiest/hardest of this group
            cands = sorted(job.cands[k][g], key=lambda c: (c[0], job.tk[c[1]]), reverse=(seg["pick"] == "hardest"))
            got.extend(cands[:n])
        else:
            got.extend(select_uniform_fast(job.cands[k][g], seg["min"], seg["max"], n, job.tk))
    job.seg_groups[k] = [(g, alloc[g], targets[g], avail[g]) for g in spec["shares"]]
    return got


def _shortfall_hint(seg, scores):
    """Say which single-bound change would make the segment fillable."""
    scores = sorted(scores)
    lo, hi, count = seg["min"], seg["max"], seg["count"]
    tips = []
    i = bisect.bisect_right(scores, hi)
    if i >= count:
        tips.append(f"min -> {scores[i - count]:g}")
    j = bisect.bisect_left(scores, lo)
    if len(scores) - j >= count:
        tips.append(f"max -> {scores[j + count - 1]:g}")
    if scores:
        tips.append(f"({seg['tier']} scores in pool span {scores[0]:g}-{scores[-1]:g}, {len(scores):,} rows)")
    return "  hint: to reach %d, change " % count + "; or ".join(tips) if tips else "  hint: none"


def _finish_job(job, header, rows, total, source_rel, dup_check):
    spec = job.spec
    lines = [f"  source {source_rel} ({total:,} rows"
             + (f", {job.dups_skipped:,} exact-duplicate candidate rows skipped" if job.dups_skipped else "") + ")"]
    if spec["notes"]:
        lines.append(f"  note: {spec['notes']}")
    if spec["blocked"]:
        lines.append(f"  BLOCKED from promotion: {spec['blocked']}")
    ti, si = header.index("tier"), header.index("score")
    out_rows = []
    warnings = []

    main = []
    tier_blocks = {}          # tier -> rows; several segments of one tier (e.g. a `suffix` bonus) share a block
    for k, got in sorted(job.chosen, key=lambda kg: kg[0]):     # recipe order (selection order differs: `pick` segments are selected first)
        seg = spec["segments"][k]
        seg_rows = [rows[idx] for _, idx in sorted(got, key=lambda c: (c[0], job.tk[c[1]]))]
        tier_blocks.setdefault(seg["tier"], []).extend(seg_rows)
        sc = [float(r[si]) for r in seg_rows]
        label = seg["tier"] + (f"+{'/'.join(seg['suffix'])}" if seg.get("suffix") else "")
        lines.append(f"  {label:<9} [{seg['min']:g},{seg['max']:g}]  {len(seg_rows)}/{seg['count']}  "
                     f"scores {(f'{min(sc):g}-{max(sc):g}') if sc else '(none)'}  (pool candidates {job.n_cands(k):,})")
        if k in job.seg_groups:
            lines.append("      groups: " + "  ".join(
                f"{g} {a}" + (f"/{t}" if a != t else "") + (f" (avail {av})" if a < t or av < t else "")
                for g, a, t, av in job.seg_groups[k]))
    for rows_t in tier_blocks.values():     # tiers in recipe order; within a tier, ascending score
        main.extend(sorted(rows_t, key=lambda r: (float(r[si]), job.tie_key(r))))
    if any(sum(1 for sg in spec["segments"] if sg["tier"] == t) > 1 for t in tier_blocks):
        lines.append("  (segments of the same tier are merged into one score-sorted block)")
    if spec["shuffle"]:
        main.sort(key=job.tie_key)          # hash order: shuffled-looking but stable across rescores
        lines.append("  main rows shuffled (by content hash)")
    if spec["order_by_group"]:      # tiers stay in recipe order; within a tier, the groups' order in `shares`
        tier_pos = {t: i for i, t in enumerate(tier_blocks)}
        g_pos = {g: i for i, g in enumerate(spec["shares"])}
        main.sort(key=lambda r: (tier_pos[r[ti]], g_pos.get(job.grouper.label(r[0]), len(g_pos))))
        lines.append("  main rows ordered by group")
    if spec["rename"]:
        ni = header.index("name")
        counts = Counter()
        renamed = []
        for r in main:
            g = job.grouper.label(r[0]) if job.grouper else ""
            counts[g] += 1
            renamed.append(list(r[:ni]) + [spec["rename"].format(group=g, i=counts[g])] + list(r[ni + 1:]))
        main = renamed
        if len({r[ni] for r in main}) != len(main):
            warnings.append(f"rename {spec['rename']!r} gives duplicate names (add {{i}})")
    out_rows.extend(main)

    for t, got in job.bonus_chosen:
        got_rows = sorted((rows[idx] for _, _, idx in got), key=lambda r: (float(r[si]), job.tie_key(r)))  # ascending by score
        sc = [float(r[si]) for r in got_rows]
        if t in spec["bonus"] and len(got_rows) < spec["bonus"][t]:
            warnings.append(f"bonus {t}: wanted {spec['bonus'][t]}, pool has only {len(got_rows)}")
        by_g = ""
        if job.grouper and t in job.bonus_groups:
            cnt = Counter(job.grouper.label(r[0]) for r in got_rows)
            by_g = "  by group " + ", ".join(
                f"{g} {a}" + (f"/{tg}" if a != tg else "") for g, a, tg, av in job.bonus_groups[t])
            if t in spec["bonus_each"]:
                by_g += "  (bonus_each: no backfill)"
        if t == "UNSOLVED" and spec["unsolved_extremes"]:
            if job.us_min != 0:
                by_g = (f"  (no score-0 UNSOLVED in this pool: took the {len(job.extremes)} hardest, "
                        f"scores {[round(v) for _, _, v in job.extremes]})")
            else:
                desc = ", ".join(f"{lab} ({voids} void cells)" for _, lab, voids in job.extremes)
                by_g = f"  (lowest-score UNSOLVED, score {job.us_min:g}: {desc})"
        lines.append(f"  bonus {t}: {len(got_rows)} rows, scores {[round(s) for s in sc]}{by_g}")
        out_rows.extend(got_rows)

    if job.carry_old:
        old_cols = job.old_header
        kept = refreshed = verbatim = dropped = 0
        for old in job.carry_old:
            rec = dict(zip(old_cols, old))
            hit = job.carry_found.get(rec["board_1"])
            if hit is None:
                try:
                    out_rows.append([rec[c] for c in header])
                except KeyError:
                    raise BookError("existing book's columns don't match the source's")
                verbatim += 1
            elif hit[1] in spec["carry"]:
                out_rows.append(rows[hit[0]])
                refreshed += 1
            else:
                dropped += 1
                warnings.append(f"carried {rec['tier']} row {rec['name']} is now tier {hit[1]} in the pool "
                                f"-- dropped; pick a replacement (find_hardest_unsolved.py)")
        lines.append(f"  carry {spec['carry']}: {refreshed} refreshed from pool, {verbatim} not in pool "
                     f"(kept verbatim), {dropped} dropped")

    # Exact + rotation/reflection duplicate check over the whole book.
    boards_idx = [i for i, c in enumerate(header) if re.fullmatch(r"board_\d+", c)]
    exact = Counter(tuple(r[i] for i in boards_idx) for r in out_rows)
    n_exact = sum(c - 1 for c in exact.values() if c > 1)
    n_canon = None
    if dup_check:
        from puzzle_deduper import PuzzleDeduper
        n = int(out_rows[0][header.index("N")])
        seen = set()
        n_canon = 0
        for r in out_rows:
            fp = PuzzleDeduper._canonical_fingerprint([r[i] for i in boards_idx], n)
            if fp in seen:
                n_canon += 1
            seen.add(fp)
    dup_txt = f"exact {n_exact}" + (f", incl. rotations/reflections {n_canon}" if n_canon is not None else "")
    lines.append(f"  duplicates: {dup_txt}")
    if n_exact or n_canon:
        warnings.append(f"book contains duplicate puzzles ({dup_txt})")

    # Compare with the book currently in data/.
    if job.old_header:
        old_tiers = Counter(r[job.old_header.index("tier")] for r in job.old_rows)
        new_tiers = Counter(r[ti] for r in out_rows)
        old_boards = {r[job.old_header.index("board_1")] for r in job.old_rows}
        bi = header.index("board_1")
        reused = sum(1 for r in out_rows if r[bi] in old_boards)
        lines.append(f"  vs data/{spec['out']}.csv: tiers {dict(old_tiers)} -> {dict(new_tiers)}; "
                     f"{reused}/{len(out_rows)} puzzles unchanged")
        old_main = [float(r[job.old_header.index("score")]) for r in job.old_rows
                    if r[job.old_header.index("tier")] == spec["segments"][0]["tier"]]
        if old_main:
            lines.append(f"  current book {spec['segments'][0]['tier']} score span {min(old_main):g}-{max(old_main):g}")
    else:
        lines.append(f"  (no existing data/{spec['out']}.csv)")

    if job.short:
        warnings.append("SHORT (allow_short): " + ", ".join(job.short))
    for w in warnings:
        lines.append(f"  WARNING: {w}")

    os.makedirs(STAGING_DIR, exist_ok=True)
    dest = os.path.join(STAGING_DIR, spec["out"] + ".csv")
    with open(dest, "w", newline="") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(header)
        w.writerows(out_rows)
    lines.append(f"  -> {os.path.relpath(dest, HERE)} ({len(out_rows)} rows)")
    return spec, True, job.short, "\n".join(lines)


# --------------------------------------------------------------------------
# Promotion
# --------------------------------------------------------------------------

def promote(outs, force, blocked=None):
    done, refused = [], []
    blocked = blocked or {}
    for out in outs:
        if blocked.get(out) and not force:
            refused.append((out, f"blocked: {blocked[out]} (use --force to override)"))
            continue
        src = os.path.join(STAGING_DIR, out + ".csv")
        dst = os.path.join(DATA_DIR, out + ".csv")
        if not os.path.exists(src):
            refused.append((out, "not built (no staged file)"))
            continue
        if os.path.exists(dst) and not force:
            st = subprocess.run(["git", "status", "--porcelain", "--", dst],
                                capture_output=True, text=True, cwd=HERE).stdout.strip()
            if st:
                refused.append((out, f"data/{out}.csv has uncommitted changes ({st[:2].strip()}); use --force"))
                continue
        shutil.copyfile(src, dst)
        done.append(out)
    return done, refused


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

def select_specs(specs, names, use_all):
    if use_all:
        return specs
    chosen = []
    for pat in names:
        hits = [s for s in specs if s["file"] == pat or fnmatch.fnmatch(s["out"], pat)]
        if not hits:
            raise BookError(f"no book or recipe file matches {pat!r} (try --list)")
        for h in hits:
            if h not in chosen:
                chosen.append(h)
    return chosen


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("names", nargs="*", help="book names (globs ok) or recipe file stems")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--list", action="store_true", help="list known books and exit")
    ap.add_argument("--seed", default="1")
    ap.add_argument("--promote", action="store_true", help="after building, copy to data/")
    ap.add_argument("--promote-staged", action="store_true",
                    help="don't build; copy already-staged books to data/")
    ap.add_argument("--force", action="store_true",
                    help="overwrite data/ files that have uncommitted changes")
    ap.add_argument("--no-dup-check", action="store_true",
                    help="skip the rotation/reflection duplicate check")
    args = ap.parse_args()

    try:
        specs = load_specs()
        if args.list:
            for s in specs:
                segs = ", ".join(f"{g['tier']} {g['count']}@[{g['min']:g},{g['max']:g}]" for g in s["segments"])
                extra = "".join([f" +bonus{s['bonus']}" if s["bonus"] else "",
                                 f" +bonus_each{s['bonus_each']}" if s["bonus_each"] else "",
                                 f" +carry{s['carry']}" if s["carry"] else "",
                                 " +unsolved_extremes" if s["unsolved_extremes"] else "",
                                 " shuffled" if s["shuffle"] else "",
                                 " (short ok)" if any(g.get("allow_short") for g in s["segments"]) else "",
                                 f" groups{list(s['groups'])}" if s["groups"] else ""])
                print(f"{s['file']:<12} {s['out']:<28} {s['source']:<36} {segs}{extra}")
            return 0
        if not args.names and not args.all:
            ap.error("name some books / a recipe file, or pass --all (or --list)")
        chosen = select_specs(specs, args.names, args.all)
    except BookError as e:
        print(f"Error: {e}", file=sys.stderr)
        return 2

    if args.promote_staged:
        done, refused = promote([s["out"] for s in chosen], args.force,
                                {s["out"]: s["blocked"] for s in specs})
        for o in done:
            print(f"promoted {o}")
        for o, why in refused:
            print(f"NOT promoted {o}: {why}")
        return 1 if refused else 0

    by_source = defaultdict(list)
    for s in chosen:
        by_source[s["source"]].append(s)

    built, failed, shorts = [], [], []
    for source_rel, group in by_source.items():
        print(f"== {source_rel}: {len(group)} book(s)", flush=True)
        try:
            results = build_group(source_rel, group, args.seed, not args.no_dup_check)
        except BookError as e:
            for s in group:
                failed.append(s["out"])
                print(f"\n[{s['out']}]\n  ERROR {e}")
            continue
        for spec, ok, short, text in results:
            print(f"\n[{spec['out']}]  ({spec['file']}.toml)\n{text}", flush=True)
            (built if ok else failed).append(spec["out"])
            if short:
                shorts.append((spec["out"], short))

    print(f"\n=== built {len(built)}, failed {len(failed)} ===")
    if shorts:
        print("short (allow_short): " + "; ".join(f"{o} [{', '.join(sh)}]" for o, sh in shorts))
    if failed:
        print("failed: " + ", ".join(failed))
    if args.promote and built:
        done, refused = promote(built, args.force, {s["out"]: s["blocked"] for s in specs})
        print(f"promoted {len(done)} book(s) to data/")
        for o, why in refused:
            print(f"NOT promoted {o}: {why}")
        if refused:
            return 1
    elif built:
        print("staged in tools/books_staging/ -- re-run with --promote (or --promote-staged) to copy to data/")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
