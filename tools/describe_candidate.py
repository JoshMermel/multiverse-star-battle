"""
describe_candidate.py

For one specific puzzle (by source CSV + name), prints the full trace with
row/col cell labels, AND an ASCII rendering of every board's state right
before the final (hardest) rule fires -- region layout + which cells are
already stars/dots -- so the exact geometry can be read off for writing
prose, without needing a screenshot yet.

Usage:
    python3 describe_candidate.py <csv_path> <puzzle_name>
"""
import csv
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from trace_solve import trace_solve, hardest_rule, cell_label
from scorer.engine import _TIER_RANK


def render_board(n, board_str, grid, void_char="*"):
    lines = []
    header = "    " + " ".join(chr(65 + c) for c in range(n))
    lines.append(header)
    for r in range(n):
        row_cells = []
        for c in range(n):
            idx = r * n + c
            if board_str[idx] == void_char:
                row_cells.append("##")
            elif grid[idx] == "x":
                row_cells.append(" *")
            elif grid[idx] == ".":
                row_cells.append(" .")
            else:
                row_cells.append(f" {board_str[idx]}")
        lines.append(f"{r + 1:>3} " + " ".join(row_cells))
    return "\n".join(lines)


def main():
    path = sys.argv[1]
    name = sys.argv[2]
    with open(path, newline="") as f:
        rows = list(csv.DictReader(f))
    row = next(r for r in rows if r["name"] == name)
    board_cols = sorted([c for c in row if c.startswith("board_")])
    boards = [row[c] for c in board_cols]
    n = int(row["N"])
    solution = row["solution"]
    stars = max((solution[r0 * n:(r0 + 1) * n].count("x") for r0 in range(n)), default=1) or 1

    print(f"=== {name} (n={n}, stars={stars}, boards={len(boards)}) ===")
    for i, b in enumerate(boards):
        print(f"--- board_{i+1} region layout ---")
        print(render_board(n, b, [None] * (n * n)))

    trace, solved, score, tier = trace_solve(n, boards, solution, stars)
    max_tier = max((t[2] for t in trace), key=lambda t: _TIER_RANK[t])
    hardest_idx = next(i for i, t in enumerate(trace) if t[2] == max_tier)

    print(f"\nsolved={solved} score={score} tier={tier}")
    print(f"\nFull trace ({len(trace)} steps):")
    for i, (rule_name, weight, rtier, decided) in enumerate(trace):
        cells = ", ".join(f"{cell_label(idx, n)}={'star' if v == 'x' else 'dot'}" for idx, v in decided)
        marker = "  <==== HARDEST STEP" if i == hardest_idx else ""
        print(f"  [{i:3d}] [{rtier:9s}] {rule_name}: {cells}{marker}")

    # Reconstruct grid state right BEFORE the hardest step.
    grid = [None] * (n * n)
    for idx in range(n * n):
        if any(boards[b][idx] == "*" for b in range(len(boards))):
            pass  # leave as None; render_board checks board_str directly per-board
    for step_i in range(hardest_idx):
        for idx, v in trace[step_i][3]:
            grid[idx] = v

    print(f"\n=== Board state right before the hardest step ({trace[hardest_idx][0]}) ===")
    for i, b in enumerate(boards):
        print(f"--- board_{i+1} (region letter shown where still empty) ---")
        print(render_board(n, b, grid))

    print(f"\nCells decided BY the hardest step:")
    for idx, v in trace[hardest_idx][3]:
        print(f"  {cell_label(idx, n)} -> {'star' if v == 'x' else 'dot'}")


if __name__ == "__main__":
    main()
