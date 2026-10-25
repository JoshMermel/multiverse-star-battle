#!/usr/bin/env python3
"""
filter.py

Scans a puzzle CSV (columns: name,N,board_1,board_2,solution,score,tier,is_solved)
for bold-line region boundaries that form a swastika glyph, and writes out a
filtered CSV with those rows removed.

Detection approach
-------------------
A bold line is drawn between two orthogonally-adjacent cells whenever their
region-label characters differ. We compute the full set of bold edges for a
board (as a set of ('v', row, col) / ('h', row, col) tuples, see
`board_edges()`), then slide a 4x4-cell window over the board. At each window
position we check whether the *local* bold-edge set (restricted to edges
that fall inside that window, expressed in window-local coordinates)
contains a swastika pattern.

The swastika pattern itself was traced directly from the reported example
(Board 2 of puzzle_666301): a 12-unit-edge pinwheel of four L-shaped hooks,
confirmed by re-rendering it and comparing against the source screenshot.
We generate all 8 dihedral symmetries (4 rotations x mirror) of that pattern
so both the symbol and its mirror image are caught, in any orientation.

Usage
-----
    python3 filter.py input.csv output.csv
"""

import csv
import sys
from itertools import product


# ---------------------------------------------------------------------------
# Swastika pattern definition (Core 8-segment pinwheel)
# ---------------------------------------------------------------------------

_WINDOW_SIZE = 4

# Defined as the 8 critical segments forming the central cross and its 4 hooks
_BASE_V = [(1, 0), (1, 1), (2, 1), (2, 2)]
_BASE_H = [(0, 2), (1, 1), (1, 2), (2, 1)]


def _edge_to_points(kind, r, c, n):
    """Map a local ('v'/'h', r, c) edge to its two endpoints in continuous
    grid-line coordinates (x, y), x and y in [0, n], y increasing upward."""
    if kind == 'v':
        x = c + 1
        y0, y1 = n - 1 - r, n - r
    else:
        y = n - 1 - r
        x0, x1 = c, c + 1
        return (x0, y), (x1, y)
    return (x, y0), (x, y1)


def _points_to_edge(p0, p1, n):
    """Inverse of _edge_to_points: convert two endpoints back to a local
    ('v'/'h', r, c) tuple."""
    (x0, y0), (x1, y1) = p0, p1
    if x0 == x1:
        x = x0
        y_hi = max(y0, y1)
        c = x - 1
        r = n - y_hi
        return ('v', r, c)
    else:
        y = y0
        x_lo = min(x0, x1)
        c = x_lo
        r = n - 1 - y
        return ('h', r, c)


# The 8 dihedral transforms of the unit square [0,n]x[0,n] onto itself.
_DIHEDRAL_TRANSFORMS = [
    lambda x, y, n: (x, y),              # identity
    lambda x, y, n: (y, n - x),          # rot90
    lambda x, y, n: (n - x, n - y),      # rot180
    lambda x, y, n: (n - y, x),          # rot270
    lambda x, y, n: (n - x, y),          # mirror (flip x)
    lambda x, y, n: (x, n - y),          # mirror (flip y)
    lambda x, y, n: (y, x),              # transpose
    lambda x, y, n: (n - y, n - x),      # anti-transpose
]


def _build_swastika_variants():
    """Return a list of frozensets, one per dihedral symmetry of the
    swastika pattern, each a set of local ('v'/'h', r, c) edge tuples
    within the 4x4 window."""
    n = _WINDOW_SIZE
    base_edges = []
    for (r, c) in _BASE_V:
        base_edges.append(_edge_to_points('v', r, c, n))
    for (r, c) in _BASE_H:
        base_edges.append(_edge_to_points('h', r, c, n))

    variants = []
    seen = set()
    for fn in _DIHEDRAL_TRANSFORMS:
        local_edges = []
        for (p0, p1) in base_edges:
            q0 = fn(p0[0], p0[1], n)
            q1 = fn(p1[0], p1[1], n)
            local_edges.append(_points_to_edge(q0, q1, n))
        fs = frozenset(local_edges)
        if fs not in seen:
            seen.add(fs)
            variants.append(fs)
    return variants


SWASTIKA_VARIANTS = _build_swastika_variants()


# ---------------------------------------------------------------------------
# Board edge computation
# ---------------------------------------------------------------------------

def board_edges(flat_board, n):
    edges = set()
    for r in range(n):
        for c in range(n):
            idx = r * n + c
            if c + 1 < n:
                idx_right = r * n + (c + 1)
                if flat_board[idx] != flat_board[idx_right]:
                    edges.add(('v', r, c))
            if r + 1 < n:
                idx_down = (r + 1) * n + c
                if flat_board[idx] != flat_board[idx_down]:
                    edges.add(('h', r, c))
    return edges


def find_swastika_windows(flat_board, n):
    if n < _WINDOW_SIZE:
        return []

    edges = board_edges(flat_board, n)
    matches = []

    for r0, c0 in product(range(n - _WINDOW_SIZE + 1), range(n - _WINDOW_SIZE + 1)):
        local_edges = set()
        for (kind, r, c) in edges:
            if kind == 'v':
                if r0 <= r < r0 + _WINDOW_SIZE and c0 <= c < c0 + _WINDOW_SIZE - 1:
                    local_edges.add(('v', r - r0, c - c0))
            else:
                if r0 <= r < r0 + _WINDOW_SIZE - 1 and c0 <= c < c0 + _WINDOW_SIZE:
                    local_edges.add(('h', r - r0, c - c0))

        for variant in SWASTIKA_VARIANTS:
            if variant <= local_edges:  # subset check
                matches.append((r0, c0))
                break

    return matches


def board_contains_swastika(flat_board, n):
    return len(find_swastika_windows(flat_board, n)) > 0


# ---------------------------------------------------------------------------
# Debug printing
# ---------------------------------------------------------------------------

def pretty_print_with_marks(flat_board, n, windows):
    marked = set()
    for (r0, c0) in windows:
        for r in range(r0, r0 + _WINDOW_SIZE):
            for c in range(c0, c0 + _WINDOW_SIZE):
                marked.add((r, c))

    for r in range(n):
        row_chars = []
        for c in range(n):
            ch = flat_board[r * n + c]
            row_chars.append(ch.lower() if (r, c) in marked else ch)
        print("  " + " ".join(row_chars))


# ---------------------------------------------------------------------------
# CSV processing
# ---------------------------------------------------------------------------

def process_csv(input_path, output_path):
    considered = 0
    removed = 0

    with open(input_path, newline="") as infile:
        reader = csv.reader(infile)
        rows = list(reader)

    has_header = rows and rows[0][:2] == ["name", "N"]
    header = rows[0] if has_header else None
    data_rows = rows[1:] if has_header else rows

    # Discover board column indices from the header row. Fall back to
    # columns 2 and 3 (the classic board_1/board_2 positions) if the
    # header is absent or contains no board_N columns.
    import re
    if header:
        board_col_indices = [
            i for i, name in enumerate(header)
            if re.fullmatch(r'board_\d+', name)
        ]
        board_col_indices.sort(key=lambda i: int(header[i].split('_')[1]))
    else:
        board_col_indices = [2, 3]

    kept_rows = []

    for row in data_rows:
        if not row:
            continue
        considered += 1

        name = row[0]
        n = int(row[1])

        flagged = {}
        for col_idx in board_col_indices:
            board_label = header[col_idx] if header else f"board_{col_idx - 1}"
            if not row[col_idx]:
                continue  # unused board column (e.g. board_3 in 2-board rows)
            windows = find_swastika_windows(row[col_idx], n)
            if windows:
                flagged[board_label] = windows

        if flagged:
            removed += 1
            print(f"=== Swastika found in {name} (N={n}) ===")
            for board_label, windows in flagged.items():
                print(f"  {board_label} — flagged windows at {windows}:")
            print()
            continue

        kept_rows.append(row)

    with open(output_path, "w", newline="") as outfile:
        writer = csv.writer(outfile)
        if has_header:
            writer.writerow(header)
        writer.writerows(kept_rows)

    print("=== Summary ===")
    print(f"Puzzles considered: {considered}")
    print(f"Puzzles removed:    {removed}")
    print(f"Puzzles kept:       {considered - removed}")


def main():
    if len(sys.argv) != 3:
        print("Usage: python3 filter.py <input.csv> <output.csv>")
        sys.exit(1)

    input_path = sys.argv[1]
    output_path = sys.argv[2]
    process_csv(input_path, output_path)


if __name__ == "__main__":
    main()
