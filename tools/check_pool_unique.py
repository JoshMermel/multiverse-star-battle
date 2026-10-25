#!/usr/bin/env python3
"""check_pool_unique.py [--workers W] [--node-limit N] [--flag-out FILE] pool.csv[.gz] ...
Exact uniqueness check of every row of a puzzle pool/book (1-4 boards, any stars-per-unit): the boards must share exactly one solution, and it
must equal the row's `solution`. Uses the C joint solver (fast_solve.joint_solutions). Prints a summary per file; rows that are non-unique,
unsolvable, mismatched, or inconclusive (node limit hit) are listed in FLAG_OUT as `file,name,status`."""
import argparse, csv, gzip, os, sys, time
from collections import Counter
from multiprocessing import Pool
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from board_utils import ALPHABET
import fast_solve
csv.field_size_limit(10**9)
NODE_LIMIT = 200_000_000


def check(row):
    n = int(row["N"])
    boards = [row[k] for k in ("board_1", "board_2", "board_3", "board_4") if row.get(k)]
    sol = row["solution"]
    k = sol.count("x") // n
    grids = [[ALPHABET.index(c) for c in b] for b in boards]
    got = fast_solve.joint_solutions(grids, n, k, cap=2, node_limit=NODE_LIMIT)
    if got is None:
        return row["name"], "inconclusive"
    if len(got) == 0:
        return row["name"], "no_solution"
    if len(got) > 1:
        return row["name"], "non_unique"
    return row["name"], "ok" if got[0] == sol else "wrong_solution"


def rows_of(path):
    with (gzip.open(path, "rt", newline="") if path.endswith(".gz") else open(path, newline="")) as f:
        yield from csv.DictReader(f)


def _init(limit):
    global NODE_LIMIT
    NODE_LIMIT = limit


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+"); ap.add_argument("--workers", type=int, default=10)
    ap.add_argument("--node-limit", type=int, default=NODE_LIMIT); ap.add_argument("--flag-out", default=None)
    a = ap.parse_args()
    flags = open(a.flag_out, "a") if a.flag_out else None
    with Pool(a.workers, initializer=_init, initargs=(a.node_limit,)) as pool:
        for path in a.files:
            t0 = time.time()
            rows = list(rows_of(path))
            res = pool.map(check, rows, chunksize=64)
            c = Counter(s for _, s in res)
            print(f"{path}: {len(rows):,} rows in {time.time()-t0:.0f}s -> {dict(c)}", flush=True)
            if flags:
                for name, s in res:
                    if s != "ok":
                        flags.write(f"{path},{name},{s}\n")
                flags.flush()


if __name__ == "__main__":
    main()
