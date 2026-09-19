"""
split_regionless_books.py

One-off: splits each combined data/<size>_regionless.csv into separate
per-difficulty files, matching the naming convention the One Star/Two Star/
Three Star groups already use (<id>_beginner, <id>_hard, <id>_expert).
Grandmaster/UNSOLVED bonus rows (a handful each) are appended to the END of
the Expert file rather than getting their own near-empty category, matching
how the combined file already treated them as "a few extras after Expert."

Usage:
    python3 split_regionless_books.py
"""
import csv

SIZES = ["6x6", "8x8", "9x9", "13x13", "17x17"]
TIER_RANK = {"Beginner": 0, "Medium": 1, "Hard": 2, "Symmetry": 3, "Expert": 4, "Grandmaster": 5, "UNSOLVED": 6}


def write_csv(path, rows):
    with open(path, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["name", "N", "board_1", "solution", "score", "tier", "is_solved"])
        for i, r in enumerate(rows, start=1):
            writer.writerow([f"puzzle_{i}", r["N"], r["board_1"], r["solution"], r["score"], r["tier"], r["is_solved"]])


def main():
    for size in SIZES:
        src = f"data/{size}_regionless.csv"
        with open(src, newline="") as f:
            rows = list(csv.DictReader(f))

        beginner = [r for r in rows if r["tier"] == "Beginner"]
        hard = [r for r in rows if r["tier"] == "Hard"]
        expert_and_bonus = [r for r in rows if r["tier"] not in ("Beginner", "Hard")]
        expert_and_bonus.sort(key=lambda r: (TIER_RANK[r["tier"]], float(r["score"])))

        write_csv(f"data/{size}_regionless_beginner.csv", beginner)
        write_csv(f"data/{size}_regionless_hard.csv", hard)
        write_csv(f"data/{size}_regionless_expert.csv", expert_and_bonus)

        bonus_tiers = sorted({r["tier"] for r in expert_and_bonus if r["tier"] != "Expert"})
        print(f"{size}: beginner={len(beginner)} hard={len(hard)} "
              f"expert+bonus={len(expert_and_bonus)} (bonus tiers: {bonus_tiers or 'none'})")


if __name__ == "__main__":
    main()
