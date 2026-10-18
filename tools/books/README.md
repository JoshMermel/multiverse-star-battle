# Building puzzle books: `tools/library/` → `data/`

The books that ship on the site (`data/*.csv`) are **built, not hand-edited**. Big scratch pools of generated puzzles live in
`tools/library/`; small declarative *recipes* (the `*.toml` files in this directory) say how to turn a pool into a book; and
`tools/build_books.py` executes the recipes. That makes a rescore (or a new scoring rule) a matter of rescoring the pools and
re-running one command, instead of re-running `book_gen.py` by hand for every book.

```
 generate ──► score ──► LIBRARY POOL ──► recipe + build_books.py ──► tools/books_staging/ ──► --promote ──► data/<book>.csv
 (gen_*.py)  (gen_puzzles    (tools/library/     (tools/books/*.toml)      (report + review)             (+ manifest.json
              score)          <dir>/*.csv)                                                                 already lists it)
```

- **Pool** — a CSV of scored puzzles in `tools/library/<dir>/`. Many more puzzles than any book needs. `tools/library/` is
  gitignored (it is large and not published).
- **Recipe** — an entry in `tools/books/<group>.toml`: which pool to draw from, which tiers and score ranges, how many of each,
  plus optional features (groups, bonus rows, …).
- **Book** — the finished `data/<out>.csv`, also listed in `data/manifest.json`.
- **Staging** — `tools/books_staging/` (gitignored). Builds land here first; nothing touches `data/` until you `--promote`.

Requirements: Python ≥ 3.11 (for `tomllib`). Scoring and generation need the OR-Tools venv: `tools/venv/bin/python`.
`build_books.py` itself only needs the standard library plus the repo's own modules.

---

## Quick start

Run everything from `tools/`.

```bash
python3 build_books.py --list                      # every book and its recipe at a glance
python3 build_books.py 8x8_hard                    # build one book into books_staging/ and print a report
python3 build_books.py one_star                    # every book in books/one_star.toml (the One Star group)
python3 build_books.py '9x9_*'                     # globs match book names
python3 build_books.py --all                       # all books (about a minute)
python3 build_books.py 8x8_hard --promote          # build, then copy into data/
python3 build_books.py 8x8_hard --promote-staged   # copy an already-built book (no rebuild)
```

Useful flags: `--seed N` (default 1; builds are deterministic per seed), `--force` (promote over a `data/` file that has
uncommitted changes), `--no-dup-check` (skip the rotation/reflection duplicate check).

**Promotion is guarded:** it refuses to overwrite a `data/` file with uncommitted git changes unless `--force`, and refuses
books marked `blocked` in their recipe. A book is only "live" once it is in `data/` (and in `data/manifest.json`, which
already lists every existing book).

### Reading the report

```
[8x8_twin]  (symmetry.toml)
  source symmetry/one_star_twin.csv (98,671 rows)
  Beginner  [12,85]  300/300  scores 12-85  (pool candidates 51,551)
      groups: rot180 105  rot90 90  flip 105
  Hard      [125,275] 1200/1200 ...
      groups: rot180 420  rot90 360  flip 420
  bonus Grandmaster: 6 rows, scores [...]  by group rot180 2, rot90 2, flip 2
  duplicates: exact 0, incl. rotations/reflections 0
  vs data/8x8_twin.csv: tiers {...} -> {...}; 814/3006 puzzles unchanged
```

- `got/want` per tier, the score span actually picked, and **pool candidates** (how many puzzles in the pool met the tier + range).
  A pool with barely more candidates than puzzles wanted gives little choice, so the score spread is whatever exists ("thin margin").
- `groups:` shows each group's allocation; `100/120 (avail 100)` means that group wanted 120, had only 100, and the others made up the difference.
- `WARNING: SHORT (allow_short)` — a segment that took everything the pool had; the book ships short.
- `vs data/...` compares with the live book, including how many puzzles are unchanged.

---

## How a book is chosen

For each tier segment (say Hard, 400 puzzles, scores 125–275):

1. Take the pool's puzzles of that tier whose score is in the range (exact-duplicate boards are skipped).
2. Split the range into `count` equal bins; for each bin, claim the unused candidate whose score is closest to the bin's centre
   (ties broken by a hash of the puzzle's own boards + solution, salted with `--seed`, so a rescore or a pool re-sort doesn't reshuffle the book); if some bins can't be served, cycle the centres until the count is reached.
   This makes the scores as evenly spread over the range as the pool allows. (Same idea as the old `book_gen.py`, but fast enough for million-row pools.)
3. Rows are written tier by tier (ascending score within a tier), then bonus rows, then carried rows.

The tier names, in difficulty order, are Beginner, Medium, Hard, (Symmetry), Expert, Grandmaster, UNSOLVED. A puzzle's **tier** is
the hardest rule the scorer needed; its **score** is the sum of the rule weights used (for UNSOLVED puzzles the score is instead
the number of cells decided before the solver got stuck — lower = harder).

---

## Recipe reference

A recipe file is `tools/books/<group>.toml`, one per group in `data/manifest.json` (so a book's recipe lives in the file named for its manifest group, whatever library dir its pool is in): shared score-range tables plus `[[book]]` entries. Range tables are scoped to their own file.

```toml
[ranges.8x8]                       # shared score ranges: Tier = [min, max]
Beginner = [14, 85]
Medium   = [40, 190]
Hard     = [125, 275]
Expert   = [225, 500]

[[book]]
out    = "8x8_hard"                      # -> data/8x8_hard.csv
source = "one_star/puzzles8_scored.csv"  # relative to tools/library/
ranges = "8x8"                           # take min/max from [ranges.8x8]
tier   = "Hard"                          # single-tier shorthand ...
count  = 1000
bonus  = { Grandmaster = 5 }             # the 5 highest-scoring Grandmasters in the pool

[[book]]                                 # ... or several tiers in one book
out    = "8x8_mono"
source = "one_star/mono_8.csv"
ranges = "8x8"
tiers  = [ {tier="Beginner", count=100}, {tier="Medium", count=400},
           {tier="Hard", count=400},     {tier="Expert", count=100} ]
bonus  = { Grandmaster = 5, UNSOLVED = 5 }
```

| Key | Meaning |
|---|---|
| `out`, `source` | output book name; pool path relative to `tools/library/` |
| `tier` + `count`, or `tiers = [...]` | what to select. A segment may give its own `min`/`max` instead of using `ranges` |
| `ranges = "name"` | use `[ranges.name]` from the same file |
| `bonus = { Grandmaster = N, UNSOLVED = M }` | extra rows appended after the main rows: the **hardest N** of each (see below) |
| `bonus_each = { Grandmaster = 2 }` | for grouped books: that many from **each group** (fewer if a group lacks them; no backfill) |
| `unsolved_extremes = true` | regionless rule: 2 UNSOLVED rows — the densest and the sparsest among the lowest-score ones (see below) |
| `carry = ["UNSOLVED"]` | copy those tiers' rows from the existing `data/<out>.csv` (for pools whose UNSOLVED scores are stale) |
| `pick = "easiest"` / `"hardest"` (on a segment) | take exactly the `count` lowest- (highest-) scoring candidates in range instead of spreading evenly (ties broken by the content-hash tie key); with groups, each group's share is picked this way. Not combinable with `suffix` segments. `pick` segments are selected first and their rows are removed from the other segments of the same tier, so `{tier="Hard", count=400}` + `{tier="Hard", count=52, pick="hardest", min=125, max=99999}` gives 452 distinct Hards |
| `shuffle = true` | shuffle the main rows (the `daily_*` books) |
| `order_by_group = true` | grouped books: emit main rows in the order of `shares` (within each tier) instead of by score |
| `rename = "puzzle_{group}"` | rename the main rows (`{group}` = the row's group, `{i}` = 1-based count within the group); used by `signoff` |
| `allow_short = true` | (per segment/book) if the pool has fewer than `count`, take what exists and warn instead of failing |
| `blocked = "reason"` | still builds, but `--promote` refuses it |
| `notes = "..."` | free text shown in the report |
| `group_by`, `groups`, `shares` | split the book by symmetry/type — see Groups |
| `suffix = "t180"` (on a segment) | a segment that draws only from rows with that name suffix, outside the groups — see Groups |

A build that can't fill a segment (and isn't `allow_short`) **fails with a hint**, e.g. `hint: to reach 1000, change min -> 148`, so
adjusting a range is quick.

### Grandmaster and UNSOLVED bonus rows

Bonus rows are drawn from the **source pool**, as the hardest N: Grandmaster = highest score; UNSOLVED = *lowest* score (fewest cells
decided before the solver stuck). For books made by mixing several kinds of puzzle, use `bonus_each` to get 1–2 of each type.

UNSOLVED scores only mean "cells decided" in pools scored since 2026-09-30, so rescore an old pool before building UNSOLVED bonus rows from it.

`unsolved_extremes = true` (used by the regionless books) picks up to two UNSOLVED rows: among those with score 0 ("no rule ever fired"),
the one with the fewest void cells (densest) and the one with the most (sparsest). **If the pool has no score-0 UNSOLVED puzzle it takes the 3 hardest
(lowest-score) UNSOLVED rows instead.** Where a pool simply lacks candidates (e.g. only 3 UNSOLVED puzzles exist) you get what exists.

### Groups: books made by splitting and re-joining

Some books are a mixture of puzzle *types* (e.g. `8x8_twin`: rot180 / rot90 / flip twins) in a target proportion. A row's group is its
**name suffix**: names are `puzzle_<id>_<suffix>`, and everything after the id is the suffix.

```toml
group_by = "suffix"
groups   = { rot180 = ["rot180"], rot90 = ["rot90"], flip = ["flip_diag", "flip_antidiag"] }  # label -> suffix globs
shares   = { rot180 = 0.35, rot90 = 0.30, flip = 0.35 }     # default: equal; share 0 = eligible only as backfill
# or: groups = ["a", "b", "c"]  -> each suffix is its own group, equal shares
```

For each tier segment the `count` is split by `shares` (largest remainder). **A group that has fewer candidates than its target gives what it has, and
the shortfall is spread over the other groups by repeatedly raising whichever currently has the smallest allocation** ("level fill"), so the groups end
up as even as availability allows. Two optional recipe keys change that: `fill = "proportional"` raises whichever group has the smallest allocation/share (groups keep their share proportions), and `backfill = ["a", "b"]` names groups that absorb a shortfall first (levelled among themselves, up to what they have) before `fill` takes over. A third option, two-level allocation, is `families = { a = ["g1", "g2"], b = ["g3"] }` + `family_shares` + `family_no_spill = ["b"]`: the count is split among families first (a family that can't supply its share is made up by the others, never by the `family_no_spill` ones), then among each family's groups by `shares`. Used by `10x10_symmetric_twin`. Rows are pooled within a merged group (like `flip` above) and spread by score, not split evenly; suffixes no group matches are excluded.

A **`suffix` segment** — e.g. `{tier="Beginner", count=50, suffix="t180"}` — draws only from rows with that suffix, outside the groups' shares. Use it for
a small bonus family. All segments of the same tier are merged into one score-sorted block, so such a family is interleaved into its tier rather than trailing the book.

### Adding a new book

1. Make sure the pool is a plain CSV with the standard header (see below) and *current* scores.
2. Add a `[[book]]` entry (and a `[ranges.X]` table if needed) to the `tools/books/<group>.toml` that matches the book's group in `data/manifest.json`.
3. `python3 build_books.py <out>` and read the report; tune ranges/counts.
4. Add the book to `data/manifest.json` (id = `out`) if it is new to the site, then `--promote`.

---

## Pools: conventions and upkeep

### Pool format
- A plain CSV: header `name,N,board_1[,board_2,…],solution,score,tier,is_solved` (extra trailing columns are allowed), no comment or marker rows. The runner **rejects** a file whose rows don't match its header width.
- Names are `puzzle_<id>_<suffix>` for grouped books (suffix = group), plain `puzzle_<id>` otherwise.
- Relabeled to this convention so far: `symmetry/symmetric_trio.csv` (`<kind>_<transforms>`), `symmetry/symmetric_twin.csv` (`<kind>_<transform>`, e.g. `mirror_rot90`, `translate_rot180`, `t180_rot90`),
  `symmetry/mono_sym.csv` (`<kind>`), `playground/8x8_squarefree_scored.csv` (`old` / `debox`: which square-free generator made the board).

### Rescoring
When the scorer changes, pools go stale (tiers and scores shift; many old UNSOLVED puzzles become solvable). To refresh:

```bash
venv/bin/python rescore_pools.py playground/two_star_squarefree.csv regionless/13x13.csv     # chunked, verified, atomic replace
venv/bin/python rescore_pools.py --only-tier UNSOLVED regionless/8x8.csv                    # refresh just one tier's rows (for huge pools)
venv/bin/python gen_puzzles.py score --skip-dedup --input X.csv --output Y.csv               # the underlying command, for a single file
```
Rescoring is a pure rescore (no rows added or dropped). Cost varies enormously: a million 8x8 1-star puzzles is minutes; a pool of Expert-heavy pairs or regionless
Grandmasters can be hours (the `giants/` pools and `regionless/8x8.csv` are the worst).

### Trimming an oversized pool
Pools can grow far beyond what books need (`regionless/8x8.csv` was 1M rows for ~3,000 book puzzles, and rescoring it would have taken ~10 h). `trim_pool.py` keeps up to a cap of puzzles per (tier, integer score) value,
so sparse score tails survive and only the dense heaps shrink; tiers can be kept whole, and any puzzle used by a live `data/` book is always kept. Dry run first; `--apply` archives the original to `<pool>.full-<date>.csv.gz`.

```bash
venv/bin/python trim_pool.py library/regionless/8x8.csv --rule Beginner=200 --rule Hard=200 --rule Expert=all --rule UNSOLVED=all --rule "Grandmaster=25,2@450,top=500"        # dry run
# ... add --apply to archive + replace; then rescore the (now small) pool with rescore_pools.py
```
Check the result by building the affected books before and after: the score multisets should match.

### Topping up a pool (when a book is short)
Time-box a generator, score the output, and append it, skipping rotation/reflection duplicates:

```bash
venv/bin/python probe_gen.py venn8 120 /tmp/x.csv          # how fast is this generator, and what tiers does it give? (estimate time = need / (rate x yield))
venv/bin/python topup_pool.py venn8 2400 library/playground/venn_scored.csv --id-base 700000 --tiers Hard,Expert,Grandmaster   # generate 40 min, score, append only the tiers a book is short of
venv/bin/python gen_twin_extra.py translate 3000 out.csv --keep rot180   # 8x8 symmetric-twin puzzles by kind (then score + append_to_pool.py)
venv/bin/python gen_mono_extra.py debox 4000 out.csv                     # single-board square-free puzzles (then score + append_to_pool.py)
venv/bin/python append_to_pool.py library/<dir>/<pool>.csv scored.csv [--tiers Hard,Expert]   # append scored puzzles, deduped (and filtered by tier: most generator output is Beginner)
```

Check that every UNSOLVED row in the live `data/` books is also in its pool (copying and rescoring any that aren't): `python3 unsolved_sync.py [--apply]`.

---

## Tool reference

| Script | What it does |
|---|---|
| `build_books.py` | build / report / promote books from recipes (this document) |
| `rescore_pools.py` | chunked, verified rescore of library pools; `--only-tier` for one tier |
| `trim_pool.py` | shrink an oversized pool while keeping every score tail: cap rows per (tier, score) + keep rows used by live books (dry run by default; archives the original) |
| `unsolved_sync.py` | check/copy UNSOLVED rows from `data/` books into their pools |
| `probe_gen.py` | time-boxed generator probe for estimating top-up time |
| `gen_allpairs.py` | all-pairs generation for 8x8 one-star two-board families (`--family mondrian\|venn`): collect boards, match every pair with a matrix product, score for a time budget, append to the pool |
| `tag_expert_rules.py` | rename a pool's Expert/Grandmaster rows with a suffix naming the Expert rule(s) their solve needs (`_ra`, `_tpq`, `_ls3`, `_ratpq`, `_gm`), so a recipe can split the Expert tier by rule |
| `verify_book_order.py` | check that books are ordered tier-by-tier and by ascending score within a tier (skips shuffled/hand-ordered books); run it on `../data` after promoting |
| `threshold_ladder.py` | derive score bands (Beginner/Medium/Hard/Expert) from the work a tier's puzzles ask of the solver (non-Beginner weight per row) instead of raw scores; prints old-vs-proposed bands with supply; see `books/THRESHOLDS.md` |
| `gen_signoff.py` | grow the `signoff` letter-pair pool (generate + score + name + append, per pair, in parallel) |
| `topup_pool.py` | generate + score + append, in one command |
| `gen_twin_extra.py` | extra 8x8 1-star symmetric-twin puzzles (translate, t180, tmirror, 180, mirror, diag) |
| `gen_mono_extra.py` | parallel single-board square-free puzzles (old / debox generators) |
| `append_to_pool.py` | append scored puzzles to a pool, skipping rotation/reflection duplicates |
| `sym9_book.py` | `9x9_symmetric` plumbing: `pool` / `recipe` / `needs` / `report`, all driven by `library/sym_data2/groups.toml` |
| `gen_sym9.py` | generate + score + fill `library/sym_data2/<name>.csv` for every 9x9 2★ symmetry pair (`run`, `report`, `merge`, `finalize`; `--needs` for gap-driven top-ups, `--shards` for parallel files) |
| `gen_sym9_mono.py` | grow `library/symmetry/mono_sym_9x9.csv` (one-board symmetric 9x9/2★ puzzles): `kind:workers` pairs for 180 / diag / translate / t180, dedupes, scores, appends; `--also FILE` imports existing boards |
| `gen_twin_pool.py` | grow a symmetric-twin pool at any N / star count (`kind:workers` pairs for 180 / diag / mirror / translate / t180 / tmirror, chunked rounds, score + dedupe + append; defaults 10x10 2 stars -> `library/symmetry/symmetric_twin_10x10.csv`; `--also` imports unscored pairs) |
| `book_gen.py` | the original one-book selector (kept; `build_books.py` supersedes it for routine rebuilds) |

## Notes on specific books

- **Regionless complement books** (`8x8/10x10_regionless_complement`): split by symmetry into thirds {(180,90), lr, t}; 90 counts as a subset of 180 (75/25 inside the first third): shares 180=3, 90=1, lr=4, t=4.
- **Regionless symmetric books** (`8x8/10x10_regionless_symmetric`): thirds {(180,90), diag, t}, same 75/25; shares 180=3, 90=1, diag=4, t=4. `t180` is a bonus family (`suffix` segments) interleaved into its tier by score:
  50 / 50 / 11 (10x10) and 35 / 35 / 0 (8x8), inside tier totals of 450 / 450 / 100. These pools' tiers do not track score like ordinary puzzles, so their score ranges are fitted to the pools.
- **`8x8_symmetric_twin`**: shares in puzzles-of-3000: mirror 750; 180 750 (500 rot90 + 250 flip); diag 750; translate 750 (300 rot180 + 300 rot90 + 150 flip); `t180` and `tmirror` share 0 (backfill only); Grandmaster 2 per group (`bonus_each`).
- **`9x9_symmetric`**: 800/3200/3200/800 + 1 Grandmaster per group over 42 symmetry-pair groups, built flat with `fill = "proportional"` from `library/symmetry/9x9_symmetric.csv` (= `sym_data2/*.csv`). The recipe block in `symmetry.toml` is generated by `sym9_book.py recipe --write` from `library/sym_data2/groups.toml`; see `library/sym_data2/NOTES.md`. Not promoted; needs a `data/manifest.json` entry first.
- **`9x9_symmetric_mono`**: token book (100 + Grandmaster bonus, 10/40/40/10) of one-board symmetric 9x9 2★ puzzles, same shape as `8x8_symmetric_mono`; Symmetry-tier puzzles are deliberately left out. Only rot180 / diag / translate / t180 can have a unique solution at 9x9/2★ (a one-board puzzle's unique solution must share the board's symmetry, and 9x9/2★ solutions can only be 180 or diagonal symmetric; probes found 0 boards for mirror, rot90, ddiag, dmirror, tmirror, octo). Rot180 is plentiful (~4 unique boards/core-second); diag ~1.2 puzzles/core-minute with few Medium/Hard in band; translate ~1 board/core-minute and mostly beyond the scorer; t180 almost none. Shares 180 2 / diag 1 / translate 1 with proportional backfill, so 180 fills what the others can't supply; t180 was dropped (almost none exist). Bonus: one Grandmaster and one UNSOLVED per group where the pool has one (diag and translate have no Grandmaster). Pool state after the 2026-10-14 1-hour search: 180 7,890 / diag ~510 / translate ~290 (translate's board space saturates: 612 boards found in an hour, only 179 new); the live book is 63 rot180 / 31 diag / 10 translate. Grow the pool with `gen_sym9_mono.py`. Promoted to `data/` and the manifest (uncommitted).
- **`10x10_symmetric_twin`** (draft, mid size 50/200/200/50): symmetric board + its own rotation/reflection, two stars. Groups `180_rot90`, `180_flip`, `translate_rot180/_rot90/_flip`, `diag`, `mirror`, arranged in four families at 25% each (mirror, diag, rot180, translate); mirror and diag contribute what they can and never receive a shortfall, which goes evenly to rot180 and translate (sub-shares 2:1 for 180, 2:2:1 for translate). t180 and tmirror are invalid at N=10; double mirror / double diagonal / rot90 yield nothing. Bands: two_star 10x10, Symmetry tier excluded. Not promoted; no manifest entry yet.
- **Square-free books** (`8x8_square_free`, `8x8_square_free_mono`): 50/50 mix of the `old` (SquareFreeGenerator) and `debox` (SquareFreeDeboxGenerator) generators; the 9x9 square-free books are single-generator.
- **`9x9_equal_area`**: every Medium (2) and Hard (17) puzzle the family has, the easiest 281 of ~421 Experts (`pick = "easiest"`), 5 bonus Grandmasters, 5 bonus UNSOLVED. The generator (`VotingDistrictGenerator`) is nearly exhausted: ~430 distinct Experts exist.
- **`mondrian`**: standard 100/400/400/100 + 5 Grandmasters. The pool's Expert tier was only ~30 distinct puzzles until the all-pairs run of 2026-10-11 (`tools/gen_allpairs.py --family mondrian`: 54k boards, every pair matched, 886k puzzles scored, +408 Expert +143 Grandmaster +10k Hard appended; pool now 44.5k rows). Further runs need a new `--seed`, and the board space saturates (150k requests give only 54k distinct boards). Findings from the investigation: every guillotine board has a full-width cut line, so row/column-window rules (Hard) solve most pairs; Expert and Grandmaster pairs are the few that stall and then need region algebra, a cross-board pin, or a lookahead. Generator tweaks (thin-strip weight, random/area-weighted split choice, pinwheel start) did not raise the Expert rate; base settings were best. A hill-climb on one board (mutating a subtree of the other) found Experts ~4x more often per scoring call but from very few seeds.
- **`venn`**: standard 100/400/400/100 + 5 Grandmasters. The pool's Experts were saturated under greedy pairing (66); the all-pairs run of 2026-10-11 (`gen_allpairs.py --family venn`, 58 min) scored 3.8M of the 14.4M possible pairs and added 1,983 Experts, 675 Grandmasters and 24.5k Hards (pool now 40k rows, 1,320 Experts in the book's 225-500 band).
- **Level-filled gaps accepted (2026-10-11):** twin `diag` Expert, `9x9_twin` flip Expert, `8x8_quadruplets`, the symmetric `diag`/`flip` Expert groups and the regionless complement/symmetric thin groups are filled by other groups; nobody plans to close them.
- **`void`**: the pool is 222 distinct void masks (generated in batches of 500 per mask), shared by both boards, so variety means masks. The trim uses `--rule Beginner=bymask=10 --rule Medium=bymask=40` (K rows per mask spread across the score range) instead of a per-score cap; the book then draws from 206 masks (190 before the trim; Medium 181 vs 135).
  `venn` and `voronoi` have no voids, so a plain per-score cap is fine for them.
- **`signoff`**: one puzzle per letter pair (board 1 / board 2 shaped like the two letters), the single hardest Expert of each, in message order `TH AN KS FO RP LA YI NG`, named `puzzle_TH`... (`groups` + `pick = "hardest"` + `order_by_group` + `rename`). The pool `library/signoff/letter_pairs.csv` holds the 8 original winners as `puzzle_0_<PAIR>` plus Medium+ puzzles from `gen_signoff.py`. The old winners were scored with an older scorer: rescored, the originals for RP (274), LA (428) and YI (450) are beaten by fresh Experts (458, 714, 1225), so those three change in the book; the originals stay in the pool.
- **`6x6_regionless_expert`**: only three Expert rules can fire on a 6x6 regionless board (region algebra `ra`, tile pair quota fill `tpq`, 3-row/col line sync `ls3`), 94% of the puzzles use exactly one Expert step, and the book is sorted by score, so neighbours often share a rule. Line-sync puzzles are short, low-scoring solves (median 125), so a score-spread book squeezes them out. The recipe therefore splits the Expert tier by rule with `groups`/`shares` (27 / 27 / 27 / 19 for ra / tpq / ls3 / ratpq, where `ratpq` = region algebra AND tile pair quota fill, only 193 exist), score range [120, 450]. This needs the pool's Expert/Grandmaster rows tagged with name suffixes by `tag_expert_rules.py` (rerun after every rescore of `regionless/6x6.csv`; the original is `6x6.csv.pre-tag`). The JS solver and the Python scorer agree on the Expert rule set for all but 1 of ~3,000 puzzles checked (`puzzle_1841119`: Python says ra+tpq, the JS hints use region algebra twice).

## Gotchas
- Both square-free generators reject uniquely-solvable boards by default (`Generator.MIN_SOLUTIONS = 2`), so `gen_puzzles.py --mode tmp` (Mono + SquareFree) can never emit anything;
  `gen_mono_extra.py` subclasses them with `min_solutions=1`.
- macOS has no `timeout`; use `perl -e 'alarm N; exec @ARGV' cmd ...`.
- Rotation/reflection duplicates inside a book are reported as a warning; exact-duplicate pool rows are skipped before selection.
- The regionless complement/symmetric pools' tiers do not track score like ordinary puzzles (e.g. Hard scores can sit below Beginner's top), so their ranges are fitted to the pools rather than copied from the single-tier regionless books.

See [`TODO.md`](TODO.md) for open work: short pools and how long they would take to grow, stale pools to rescore, and books not yet rebuilt.
