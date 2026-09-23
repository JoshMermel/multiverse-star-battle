"""
trace_solve.py

Re-runs CompositeScorer's exact solve loop (same rule tables, same
try-in-order-restart-from-top algorithm as engine.py's solve()) but records
the full ordered trace of (rule_func.__name__, weight, tier) for every
successful application, instead of just the final (solved, score, tier).

This is the "more elegant than hacking the scorer" way to find a puzzle
where a SPECIFIC named rule is the hardest one used: since both the Python
scorer and the JS getHint() dispatcher use the identical
try-lowest-tier-first-and-restart algorithm (confirmed in parity as of
commit d848784), whatever rule is the max-tier entry in this trace is
exactly the rule a player mashing "Hint" will be shown at that point in
the puzzle -- guaranteed, not probabilistic.

Usage as a library:
    from trace_solve import trace_solve
    trace, solved, score, tier = trace_solve(n, boards, solution, stars_per_unit)
    # trace: list of (rule_name, weight, tier) in application order
    # the hardest rule used is trace[-1] among entries with tier == max tier,
    # more precisely: max(trace, key=lambda t: TIER_RANK[t[2]])
"""
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from scorer import StarBattlePuzzle, CompositeScorer
from scorer.engine import _TIER_RANK

TIER_ORDER = ["Beginner", "Medium", "Hard", "Symmetry", "Expert", "Grandmaster", "UNSOLVED"]


def cell_label(idx, n):
    """Matches renderer.js's axis labels: column = letter (A, B, C...),
    row = 1-indexed number. E.g. idx=5 at n=9 -> row 0, col 5 -> 'F1'."""
    r, c = divmod(idx, n)
    return f"{chr(65 + c)}{r + 1}"


def trace_solve(n, boards, solution, stars_per_unit, uncap_grandmaster=False):
    p = StarBattlePuzzle(n=n, boards=boards, solution_str=solution, name="trace",
                          stars_per_unit=stars_per_unit)
    scorer = CompositeScorer(verbose=False, uncap_grandmaster=uncap_grandmaster)

    if stars_per_unit == 1:
        rules = scorer.rules_1star
    elif stars_per_unit == 2:
        rules = scorer.rules_2_star
    else:
        rules = scorer.rules_multi_capped

    trace = []
    total_score = 0
    max_tier = "Beginner"

    try:
        while True:
            round_changes = 0
            for rule_func, weight, tier in rules:
                before = list(p.grid)
                changes = rule_func(p)
                if changes > 0:
                    round_changes += changes
                    total_score += weight
                    decided = [(i, p.grid[i]) for i in range(len(p.grid))
                               if before[i] is None and p.grid[i] is not None]
                    trace.append((rule_func.__name__, weight, tier, decided))
                    if _TIER_RANK[tier] > _TIER_RANK[max_tier]:
                        max_tier = tier
                    break
            if round_changes == 0:
                break
    except ValueError:
        return trace, False, -999, "UNSOLVED"

    solved = all(val is not None for i, val in enumerate(p.grid) if i not in p.void_cells)
    if not solved:
        max_tier = "UNSOLVED"
    return trace, solved, total_score, max_tier


def hardest_rule(trace):
    """The rule_func name of the single hardest-tier application in the
    trace (first one at that tier, if several tie -- deterministic since
    trace is already in application order)."""
    if not trace:
        return None
    best = max(trace, key=lambda t: _TIER_RANK[t[2]])
    return best[0]


def rule_counts(trace):
    """How many times each rule fired -- useful for preferring examples
    where the target rule fires exactly once (cleanest to screenshot)."""
    from collections import Counter
    return Counter(name for name, _, _, _ in trace)


if __name__ == "__main__":
    import csv
    path = sys.argv[1]
    name = sys.argv[2] if len(sys.argv) > 2 else None
    with open(path, newline="") as f:
        rows = list(csv.DictReader(f))
    if name:
        rows = [r for r in rows if r["name"] == name]
    for row in rows:
        board_cols = sorted([c for c in row if c.startswith("board_")])
        boards = [row[c] for c in board_cols]
        n = int(row["N"])
        stars = max((row["solution"][r0 * n:(r0 + 1) * n].count("x") for r0 in range(n)), default=1) or 1
        trace, solved, score, tier = trace_solve(n, boards, row["solution"], stars)
        print(f"=== {row['name']} (n={n}, stars={stars}, boards={len(boards)}) ===")
        for rule_name, weight, rtier, decided in trace:
            cells = ", ".join(f"{i}={v}" for i, v in decided)
            print(f"  [{rtier:11s}] {rule_name} (+{weight}) -> {cells}")
        print(f"RESULT solved={solved} score={score} tier={tier} hardest_rule={hardest_rule(trace)}")
