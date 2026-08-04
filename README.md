# multiverse-star-battle

A browser-based puzzle game and puzzle generation toolkit for **Multiverse Star
Battle** — a variant of the classic Star Battle logic puzzle where several
boards share a single solution.

---

## What Is Multiverse Star Battle?

Standard Star Battle asks you to place one star per row, column, and bold region
on a single grid, with no two stars touching (even diagonally). Multiverse Star
Battle adds a twist: you play more than one board simultaneously, and marks made
on one board also take effect on all other boards.

If you look at any board in isolation, it looks like a standard star battle
with more than one solution. But if you make inferences on all boards together,
you'll arrive at the only unique solution.

---

## Repository Structure

```
├── index.html              # Game shell and UI layout
├── style.css               # All visual styles and responsive layout
├── script.js               # StarBattleGame: page setup and orchestration
├── puzzle-loader.js        # Puzzle/category fetching and URL param handling
├── input.js                # Click/drag input handling
├── renderer.js             # Rendering logic for the DOM
├── history.js              # Undo/redo management
├── rules.js                # Game logic, win/error detection
├── storage.js              # Saving and loading to local/remote storage
├── constants.js            # Shared constants
├── geometry.js             # Shared cell/board geometry helpers
├── sw.js                   # Service worker (offline caching)
├── solver.js               # Barrel: assembles PuzzleSolver from the pieces below
├── solver-core.js          # PuzzleSolver: precompute, getHint() dispatch, symmetry detection
├── solver-rules-common.js  # Hint rules shared by 1★ and 2★+ puzzles
├── solver-rules-single.js  # 1★-only hint rules
├── solver-rules-multi.js   # 2★+ hint rules (generalized to any stars-per-unit)
├── tools/
│   ├── gen_puzzles.py   # Main for puzzle generation and scoring
│   ├── scorer/           # Scoring engine (package; see tools/README.md)
│   ├── *_generator.py   # Generators for candidate boards
│   ├── *_comparator.py  # Compare candidate boards to produce puzzles
│   └── board_utils.py   # Shared utils
└── data/
    ├── manifest.json    # List of puzzle books/categories
    └── <catId>.csv      # Puzzle data for each category
```

---

## Playing the Game

There's a version of the game running at
https://www.joshmermelstein.com/multiverse-star-battle

You can also run a local copy by running a webserver (e.g.
`python3 -m http.server 8000`) from the dir containing `index.html`.

## Data Format

### `data/manifest.json`

Describes the available puzzle books:

```json
{
  "groups": {
    "8x8":              { "icon": "8×8",  "blurb": "Beginner → Expert",               "desc": "Puzzles by size and difficulty" },
    "6x6":              { "icon": "6×6",  "blurb": "Beginner → Expert",               "desc": "Puzzles by size and difficulty" },
    ...
  },
  "categories": [
    {"id": "8x8_beginner",        "label": "Beginner",            "group": "8x8"},
    {"id": "8x8_medium",          "label": "Medium",              "group": "8x8"},
    {"id": "6x6_beginner",        "label": "Beginner",            "group": "6x6"},
    {"id": "6x6_medium",          "label": "Medium",              "group": "6x6"},
    ...
  ]
}
```

### `data/<catId>.csv`

one puzzle per row, in the following csv format: 
`name,N,board_1,board_2,solution,score,tier,is_solved` . e.g.:

```csv
puzzle_1,8,CCCCEEEECCCCCEEECCFCFEBEGFFCFBBBGFFFFFBDGFFFFAADHHFAAAAAHHAAAAAA,FFFFCCCCFFFCCCHHFFCCCHHHAACCHHHHAACGDHEEAAAGGEEEAAGGGEEEBBBGEEEE,.....x....x...........x.x...........x..........x...x.....x......,15,Beginner,True
puzzle_2,8,BCCCCCCEBBBHHCCEGBBHHCAAGGBDHAAAGGDDDDAAGDDDDDAAGFDDDDAAFFDDDDAA,AACCCCCCAAAAACCCAAAAAEEEAAGAEEEEBBGEEEEFHBGFEFFFHHFFFFFFHHFFDFFF,.......x...x.........x....x.....x.............x..x..........x...,15,Beginner,True
```

- `N` — board size (N×N grid with N regions per board)
- `board_1` / `board_2` — flat strings of length N², one character per cell; cells sharing a character belong to the same region
- `solution` — flat string of length N²; `x` marks a star, `.` marks empty
-  everything else - unused metadata.

For other board counts, add or omit board_n columns from the csv header.

---

## Generating Puzzles (`gen_puzzles.py`)

Requires Python 3 and `ortools`:

```bash
pip install ortools
```

### Generation Modes

Most modes produce puzzle pairs with **exactly one shared solution** across
both boards; `mono` produces standalone single-board puzzles instead, and
`solution_first_pair` can produce more than 2 boards (via `--board-count`).

| Mode | Description |
|---|---|
| `random_pair` | Two independently generated random boards |
| `symmetric_pair` | Two boards each with rotational or reflective symmetry |
| `self_entangled` | One random board paired with its own rotation or reflection |
| `super_symmetric` | One symmetric board paired with its own rotation or reflection |
| `letter_pair` | Two boards whose regions form letter shapes (requires `--char1` and `--char2`) |
| `voting_district_pair` | Two boards where all regions contain the same number of cells |
| `sudoku_pair` | Two boards one of them looks like a classic sudoku grid |
| `mono` | A single standalone board (classic, non-multiverse Star Battle) with a unique solution |
| `solution_first_pair` | N boards (`--board-count`, default 2) built outward from a shared solution rather than matched after the fact |

### Generation Usage

See header comment of gen_puzzles.py

### How Generation Works

Each **generator** works in a different way, to generate boards with some
specific attribute. Most of them start by placing N "seeds", and then growing
those seeds until the board is full. Then they use an OR-Tools CP-SAT model to
find all valid star placements.

Each **comparator** takes one or more generators, and uses it/them to produce
pairs of boards with exactly one solution. Like Generators, these work in
different ways to achieve different styles of puzzle.

There is also a solution-first generator + comparator, which work differently.
These start from a solution and build boards around it; shifting boundaries
around to make the solution unique.

---

## Scoring Puzzles

The scorer simulates human rule-based solving and measures difficulty by
tracking which rules were needed and how many times.

For usage, see the header comment in gen_puzzles.py.

### Difficulty Tiers

Rules are grouped into tiers. The highest-tier rule needed to solve a puzzle
determines its tier. The numeric score accumulates the weight of every rule
application made during the solve.

| Tier | Example Rules |
|---|---|
| **Beginner**    | Only empty cell in a unit; propagate from placed star; domino/triomino shadows |
| **Medium**      | Region candidates seen by external cells; 2-unit/region sync |
| **Hard**        | 3-unit sync; disjoint row/column sets; region-contains-region |
| **Symmetry**    | rules that require noticing global symmetries of the solution |
| **Expert**      | 3-disjoint sets; cross-board region pinning; partial overlap; half-lookahead |
| **Grandmaster** | Full lookahead 1–3 stages deep |

For details on these inferences, see how_to_solve.md.

Puzzles that the scorer cannot fully solve are marked `UNSOLVED`.

---

## Hint System (`solver.js`)

`PuzzleSolver` is a js implementation of the scorer which reads the game's live
state. `solver.js` is a thin barrel file that assembles `PuzzleSolver` from
`solver-core.js` (precompute, symmetry detection, the `getHint()` dispatcher)
plus three rule-mixin files (`solver-rules-common.js`,
`solver-rules-single.js` for 1★-only rules, `solver-rules-multi.js` for
2★+ rules). When the user clicks **Hint**, `getHint()` runs through a
prioritised rule list for the puzzle's star count — the same logical
hierarchy as the Python scorer — and returns the first applicable hint.

Each hint is an object with:
- `description` — human-readable explanation shown as a toast (for some
  rules, this also names which technique found a highlighted group, e.g.
  "paired rows/cols covered by 2x2 boxes")
- `highlights` — cells to tint (the reasoning source), each an
  `{ idx, color, boards? }` object; `color` is usually blue, but a hint that
  combines several disjoint groups cycles through blue/purple/cyan/pink so
  each group is visually distinguishable
- `marks` — cells to circle (the deducible cells), each an
  `{ idx, color, boards? }` object; `color` is yellow (dot), green (star), or
  red (error)
- `boardIdx` — if set, the whole hint applies only to that one board and the
  UI switches straight to it; if `undefined`, per-cell `boards` (see below)
  decides instead
- `boards` (on an individual highlight/mark, not the hint itself) — which
  board(s) that specific cell applies to; falls back to `boardIdx`, then to
  every board, so single-board rules (which never set this) still render as
  before. Needed once a puzzle has more than 2 boards, since a cross-board
  deduction's source and target cells aren't always on the same two boards.

## Credits

Thank you to brennerd, whose [star battle android
app](https://play.google.com/store/apps/details?id=com.brennerd.grid_puzzle.star_battle)
is what got me into Star Battle in the first place.

Thank you to Jim Bumbardner (KrazyDad), whose [video
series](https://www.youtube.com/playlist?list=PLgs13YmhqEijgfADBtPesxGGfpykSrFs7)
on puzzle construction got me inspired to work on this project.

Thank you to my friends and coworkers who tested in-development versions of this
project and gave me invaluable feedback.
