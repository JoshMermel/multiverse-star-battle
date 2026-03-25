# multiverse-star-battle

A browser-based puzzle game and puzzle generation toolkit for **Multiverse Star
Battle** — a variant of the classic Star Battle logic puzzle where two boards
share a single solution.

---

## What Is Multiverse Star Battle?

Standard Star Battle asks you to place one star per row, column, and bold region
on a single grid, with no two stars touching (even diagonally). Multiverse Star
Battle adds a twist: you play two boards simultaneously, and marks made on one
board also take effect on the other board.

If you look at either board in isolation, it looks like a standard star battle
with more than one solution. But if you make inferrences on both boards
together, you'll arrive at the only solution which solves both.

---

## Repository Structure

```
├── index.html          # Game shell and UI layout
├── style.css           # All visual styles and responsive layout
├── script.js           # StarBattleGame: game logic, rendering, persistence
├── solver.js           # PuzzleSolver: hint engine
├── constants.js        # Shared cell state constants
├── analysis-tools/
│   └── gen_puzzles.json   # Puzzle generation and scoring
└── data/
    ├── manifest.json   # List of puzzle books/categories
    └── <catId>.json    # Puzzle data for each category
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
  "categories": [
    {"id": "8x8_beginner",        "label": "Beginner",        "group": "8x8"},
    {"id": "8x8_medium",          "label": "Medium",          "group": "8x8"},
    ...
  ]
}
```

### `data/<catId>.json`

An array of puzzle objects:

```json
[
  {
    "id": 1,
    "N": 8,
    "board1": "AABBCCDD...",
    "board2": "AABBCCDD...",
    "solution": "x.......x......."
  },
  {
     ...
]
```

- `N` — board size (N×N grid with N regions per board)
- `board1` / `board2` — flat strings of length N², one character per cell; cells sharing a character belong to the same region
- `solution` — flat string of length N²; `x` marks a star, `.` marks empty

---

## Generating Puzzles (`gen_puzzles.py`)

Requires Python 3 and `ortools`:

```bash
pip install ortools
```

### Generation Modes

All modes produce puzzle pairs with **exactly one shared solution** across both
boards.

| Mode | Description |
|---|---|
| `random_pair` | Two independently generated random boards |
| `symmetric_pair` | Two boards each with rotational or reflective symmetry |
| `self_entangled` | One random board paired with its own rotation or reflection |
| `super_symmetric` | One symmetric board paired with its own rotation or reflection |
| `letter_pair` | Two boards whose regions form letter shapes (requires `--char1` and `--char2`) |
| `voting_district_pair` | Two boards where all regions contain the same number
of cells |

### Generation Usage

```bash
# Generate 100 random 8×8 puzzle pairs
python3 gen_puzzles.py --mode random_pair --n 8 --count 100

# Generate letter-shaped boards spelling "TH"
python3 gen_puzzles.py --mode letter_pair --char1 T --char2 H --n 8 --count 10

# Generate and immediately score
python3 gen_puzzles.py --mode random_pair --n 8 --count 100 --score-after

# Reject any board where a region contains only one cell
python3 gen_puzzles.py --mode symmetric_pair --n 8 --count 100 --reject-singletons
```

Output is a CSV file (default: `puzzles.csv`) with columns:
`name, N, board_1, board_2, solution`.

### How Generation Works

Each generator produces candidate boards by:
1. Seeding N random cells as region roots on an N×N grid
2. Flood-filling remaining cells from neighbouring roots to create N contiguous
   regions
3. Solving the board with an OR-Tools CP-SAT model to find all valid star
   placements

The **comparator** layer then matches pairs of boards that share exactly one
solution:
- `SymmetricPoolComparator` — maintains a pool of boards from a single
  generator; for each new board, tries all 8 rotations/reflections against the
  pool looking for a unique shared solution
- `AsymmetricPoolComparator` — same idea but with two separate generators (used
  for letter pairs, where orientation must be preserved)
- `SelfComparator` — matches each board against its own non-identity
  rotations/reflections

---

## Scoring Puzzles (`gen_puzzles.py --score`)

The scorer simulates human rule-based solving and measures difficulty by
tracking which rules were needed and how many times.

```bash
# Score an existing puzzle CSV
python3 gen_puzzles.py --score --input puzzles.csv

# Score to a specific output file
python3 gen_puzzles.py --score --input puzzles.csv --output scored.csv

# Score a single puzzle with verbose step-by-step output
python3 gen_puzzles.py --score --input puzzles.csv --puzzle puzzle_42 --verbose
```

Output adds three columns to the CSV: `score`, `tier`, `is_solved`.

### Difficulty Tiers

Rules are grouped into tiers. The highest-tier rule needed to solve a puzzle
determines its tier. The numeric score accumulates the weight of every rule
application made during the solve.

| Tier | Example Rules |
|---|---|
| **Beginner** | Only empty cell in a unit; propagate from placed star; domino/triomino shadows |
| **Medium** | Region candidates seen by external cells; 2-unit/region sync |
| **Hard** | 3-unit sync; disjoint row/column sets; region-contains-region |
| **Expert** | 3-disjoint sets; cross-board region pinning; partial overlap; half-lookahead |
| **Grandmaster** | Full lookahead 1–3 stages deep |

Puzzles that the scorer cannot fully solve are marked `UNSOLVED`.

---

## Hint System (`solver.js`)

`PuzzleSolver` is a js implementation of the scorer which reads the game's live
state. When the user clicks **Hint**, `getHint()` runs through a prioritised
rule list — the same logical hierarchy as the Python scorer — and returns the
first applicable hint.

Each hint is an object with:
- `description` — human-readable explanation shown as a toast
- `highlights` — cells to tint blue (the reasoning source)
- `marks` — cells to circle yellow (the deducible cells)
- `boardIdx` — if set, highlights apply only to that board; if `undefined`,
  highlights apply to both
