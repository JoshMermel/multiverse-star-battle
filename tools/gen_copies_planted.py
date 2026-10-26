#!/usr/bin/env python3
"""
gen_copies_planted.py n stars per_class workers out.csv [--known pool.csv ...] [--chunk-seconds 30] [--max-rounds 40] [--include-groups]

Planted generation of K=4 "quadruplets" (a board + three rotated/reflected copies sharing exactly one solution, every three still ambiguous) for the
NON-group transform classes, which naive random generation almost never produces (see copies_plant.py: random boards have no common solution for
them at all).  Per class: pick a random target solution S0 (symmetric under the class's left-stabilizer element when it has one -- otherwise a
second common solution is forced), anneal a contiguous region layout that accepts S0 in all four copies, then verify EXACTLY with the C joint
solver (one common solution; every leave-one-out subset ambiguous) and drop swastika-shaped boards.  Rows are deduplicated up to global
rotation/reflection/relabeling, against each other and against --known pools.  Output (unscored): name=puzzle_<id>_<class>,N,board_1..4,solution.

Classes: group classes (rot90_rot180_rot270, rot180_flip_diag_flip_antidiag) are cheap with the naive copies_probe.py, so they are skipped unless
--include-groups; classes whose left-stabilizer is a mirror (flip_h/flip_v) are impossible (no mirror-symmetric 2-star solution exists).
"""
import argparse, csv, os, random, sys, time
from collections import Counter
from concurrent.futures import ProcessPoolExecutor
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from board_utils import ALPHABET, get_transformation_maps, TRANSFORM_NAMES, canonical_relabel
from filter import board_contains_swastika
import copies_plant as cp
csv.field_size_limit(10**9)

CLASSES = ["rot90_rot180_rot270", "rot180_flip_diag_flip_antidiag", "rot90_flip_h_flip_antidiag", "rot90_flip_h_flip_diag",
           "rot90_flip_h_flip_v", "rot90_rot180_flip_diag", "rot90_rot180_flip_h", "rot180_flip_h_flip_v"]


def parse(cls):
    toks = cls.split('_'); parts = []; i = 0
    while i < len(toks):
        for L in (2, 1):
            c = "_".join(toks[i:i + L])
            if c in TRANSFORM_NAMES: parts.append(c); i += L; break
        else: raise ValueError(cls)
    return (0,) + tuple(TRANSFORM_NAMES.index(p) for p in parts)


def setup(n):
    maps = [np.array(m[0]) for m in get_transformation_maps(n)]
    idx = {tuple(m): g for g, m in enumerate(maps)}
    comp = lambda a, b: idx[tuple(maps[a][maps[b]])]
    return maps, comp


def class_info(cls, n):
    """(M, sym, kind): sym = transform the target solution must be invariant under; kind in plain|group|impossible"""
    maps, comp = setup(n)
    M = parse(cls); S = set(M)
    stab = [k for k in range(1, 8) if {comp(k, m) for m in M} == S]
    if len(stab) == 3 or (len(stab) >= 1 and all(comp(a, b) in S for a in M for b in M)):
        return M, tuple(k for k in M if k), 'group'
    if not stab: return M, None, 'plain'
    k = stab[0]
    if TRANSFORM_NAMES[k] in ('flip_h', 'flip_v'): return M, k, 'impossible'
    return M, k, 'plain'


def canon_key(boards, maps, n):
    def tb(b, m):
        r = [""] * (n * n)
        for i, ch in enumerate(b): r[m[i]] = ch
        return "".join(r)
    return min(tuple(sorted(canonical_relabel(tb(b, maps[h])) for b in boards)) for h in range(8))


def worker(job):
    cls, n, stars, secs, seed, size_bias = job
    rng = random.Random(seed)
    maps, _ = setup(n); nb = cp.neighbours4(n)
    M, sym, kind = class_info(cls, n)
    out = []; st = Counter(); t0 = time.time()
    while time.time() - t0 < secs:
        st['trials'] += 1
        S0 = cp.random_solution_cp(n, stars, rng, maps, sym)
        if S0 is None: continue
        lab = cp.plant(M, S0, n, stars, rng, maps, nb, 100000, size_bias=size_bias)
        if lab is None: continue
        st['planted'] += 1
        cnt, ok = cp.evaluate(M, lab, S0, n, stars, maps)
        if not ok: continue
        boards = []
        for g in M:
            gr = [0] * (n * n)
            for u in range(n * n): gr[int(maps[g][u])] = lab[u]
            boards.append(canonical_relabel("".join(ALPHABET[v] for v in gr)))
        if any(board_contains_swastika(b, n) for b in boards): st['swastika'] += 1; continue
        st['valid'] += 1
        out.append((boards, "".join('x' if c in S0 else '.' for c in range(n * n))))
    return cls, out, st


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("n", type=int); ap.add_argument("stars", type=int); ap.add_argument("per_class", type=int)
    ap.add_argument("workers", type=int); ap.add_argument("out")
    ap.add_argument("--known", nargs="*", default=[]); ap.add_argument("--chunk-seconds", type=float, default=30)
    ap.add_argument("--max-rounds", type=int, default=40); ap.add_argument("--include-groups", action="store_true")
    ap.add_argument("--classes", nargs="*", default=None); ap.add_argument("--size-bias", type=float, default=0.0)
    a = ap.parse_args()
    n = a.n; maps, _ = setup(n)
    classes = a.classes or [c for c in CLASSES if class_info(c, n)[2] == 'plain' or (a.include_groups and class_info(c, n)[2] == 'group')]
    print("classes:", classes, flush=True)
    seen = {}
    for f in a.known:
        for r in csv.DictReader(open(f, newline="")):
            bs = [r[k] for k in ("board_1", "board_2", "board_3", "board_4") if r.get(k)]
            seen[canon_key(bs, maps, n)] = None
    have = {c: [] for c in classes}; allst = {c: Counter() for c in classes}
    t00 = time.time()
    with ProcessPoolExecutor(a.workers) as ex:
        for rnd in range(a.max_rounds):
            todo = [c for c in classes if len(have[c]) < a.per_class]
            if not todo: break
            for c in todo:
                for _, out, st in ex.map(worker, [(c, n, a.stars, a.chunk_seconds, random.randrange(10**9), a.size_bias) for _ in range(a.workers)]):
                    allst[c].update(st)
                    for boards, sol in out:
                        k = canon_key(boards, maps, n)
                        if k not in seen: seen[k] = None; have[c].append((boards, sol))
            print(f"round {rnd+1} ({time.time()-t00:.0f}s): " + ", ".join(f"{c}={len(have[c])}" for c in classes), flush=True)
    for c in classes: print(f"  {c}: {dict(allst[c])}")
    with open(a.out, "w", newline="") as f:
        w = csv.writer(f, lineterminator="\n"); w.writerow(["name", "N", "board_1", "board_2", "board_3", "board_4", "solution"])
        i = 0
        for c in classes:
            for boards, sol in have[c]:
                i += 1; w.writerow([f"puzzle_{i}_{c}", n] + boards + [sol])
    print(f"wrote {sum(len(v) for v in have.values())} puzzles to {a.out}")


if __name__ == "__main__":
    main()
