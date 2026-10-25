"""mondrian2star_pairs.py n out.csv [--max-boards M] [--seed S] in1.pkl [in2.pkl ...]
Pair boards from mondrian2star_boards.py (all 8 orientations of board j against board i) and emit every 2-board puzzle whose
boards share EXACTLY one solution.  Solutions are hashed (Zobrist XOR over star cells), one sorted array finds every common
solution of every (i, j, orientation) at once -- no all-pairs loop -- and each hit is then verified exactly."""
import sys, os, pickle, random, csv, time, argparse
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from board_utils import get_transformation_maps, canonical_relabel


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("n", type=int); ap.add_argument("out"); ap.add_argument("pkls", nargs="+")
    ap.add_argument("--max-boards", type=int, default=0); ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--min-solutions", type=int, default=2)
    a = ap.parse_args()
    n = a.n; t0 = time.time()
    boards = {}
    for f in a.pkls:
        boards.update(pickle.load(open(f, "rb")))
    names = [b for b in boards if len(boards[b]) >= a.min_solutions]    # 1-solution boards are already puzzles on their own
    random.Random(a.seed).shuffle(names)
    if a.max_boards:
        names = names[:a.max_boards]
    print(f"{len(names)} boards (>= {a.min_solutions} solutions); {time.time()-t0:.0f}s", flush=True)
    maps = [np.array(m[0]) for m in get_transformation_maps(n)]
    rng = np.random.default_rng(12345)
    Z = rng.integers(0, 2**63, size=n * n, dtype=np.uint64) * np.uint64(2) + rng.integers(0, 2, size=n * n, dtype=np.uint64)
    keys, bid, gid = [], [], []
    for i, b in enumerate(names):
        cells = boards[b]
        for g, m in enumerate(maps):
            k = np.bitwise_xor.reduce(Z[m[cells]], axis=1)
            keys.append(k); bid.append(np.full(len(k), i, dtype=np.int32)); gid.append(np.full(len(k), g, dtype=np.int8))
    keys = np.concatenate(keys); bid = np.concatenate(bid); gid = np.concatenate(gid)
    print(f"{len(keys):,} (key, board, orientation) entries; {time.time()-t0:.0f}s", flush=True)
    order = np.argsort(keys, kind="stable"); keys = keys[order]; bid = bid[order]; gid = gid[order]
    same = keys[1:] == keys[:-1]
    starts = np.nonzero(same & ~np.concatenate(([False], same[:-1])))[0]      # first index of every run of length >= 2
    print(f"{len(starts):,} shared-solution groups; {time.time()-t0:.0f}s", flush=True)
    cnt = {}
    L = len(keys)
    for s in starts:
        e = s + 1
        while e < L and keys[e] == keys[s]:
            e += 1
        mem = [(int(bid[x]), int(gid[x])) for x in range(s, e)]
        for (i, g0) in mem:
            if g0 != 0:
                continue
            for (j, g) in mem:
                if j > i:
                    kk = (i * len(names) + j) * 8 + g
                    cnt[kk] = cnt.get(kk, 0) + 1
    cands = [kk for kk, c in cnt.items() if c == 1]
    print(f"{len(cnt):,} (i, j, orientation) triples share a solution; {len(cands):,} share exactly one; {time.time()-t0:.0f}s", flush=True)

    def tb(b, m):
        r = [""] * (n * n)
        for i, ch in enumerate(b):
            r[m[i]] = ch
        return "".join(r)
    seen, rows, bad = set(), [], 0
    for kk in cands:
        g = kk % 8; ij = kk // 8; i, j = divmod(ij, len(names))
        ci = boards[names[i]]; cj = maps[g][boards[names[j]]]
        si = {tuple(sorted(r)) for r in ci.tolist()}; sj = {tuple(sorted(r)) for r in cj.tolist()}
        com = si & sj
        if len(com) != 1:
            bad += 1; continue
        b1 = canonical_relabel(names[i]); b2 = canonical_relabel(tb(names[j], maps[g]))
        key = frozenset((b1, b2))
        if key in seen:
            continue
        seen.add(key)
        sol = "".join("x" if c in next(iter(com)) else "." for c in range(n * n))
        rows.append((b1, b2, sol))
    print(f"hash false positives dropped: {bad}; puzzles after symmetry dedupe: {len(rows):,}; {time.time()-t0:.0f}s")
    random.Random(a.seed).shuffle(rows)
    with open(a.out, "w", newline="") as f:
        w = csv.writer(f, lineterminator="\n"); w.writerow(["name", "N", "board_1", "board_2", "solution"])
        for k, (b1, b2, sol) in enumerate(rows):
            w.writerow([f"mond2_{n}_{k}", n, b1, b2, sol])


if __name__ == "__main__":
    main()
