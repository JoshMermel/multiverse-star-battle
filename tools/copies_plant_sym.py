#!/usr/bin/env python3
"""copies_plant_sym.py -- solution-first ("planted") K-copy puzzles whose BOARD is itself symmetric under a transform sigma (default flip_diag).

Like copies_plant.py, but the annealing keeps the region layout sigma-invariant: lab[sigma(c)] = pi(lab[c]) for an involution pi on region ids
(a region is its own mirror image, or one of a mirror pair).  Every move shifts a cell AND its mirror together, so symmetry never breaks.  Start
layout: a diagonal-symmetric board from SymmetricGenerator.  Naive random generation almost never gives a diagonal-symmetric board a common
solution across copies (0 hits in 20k solvable boards), which is what this tries to fix.

    venv/bin/python copies_plant_sym.py M_CLASS n stars trials [iters]      e.g.  rot90_rot180 10 2 200
"""
import sys, os, math, random, time
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from board_utils import ALPHABET, get_transformation_maps, TRANSFORM_NAMES
import copies_plant as cp


def symmetric_start(n, sym_name, stars, rng_seed):
    import random as _r
    from symmetric_generator import SymmetricGenerator
    _r.seed(rng_seed)
    gen = SymmetricGenerator(n, symmetry_type=sym_name, translation_type='none', stars_per_unit=stars)
    for _ in range(2000):
        got = []
        gen._make_result = lambda grid, *a, **k: got.append(list(grid)) or None
        gen._try_generate()
        if got: return got[0]
    return None


def plant_sym(M, S0, n, stars, rng, maps, nb, sigma, lab0, iters=200000, t0=0.8, t1=0.05, size_bias=0.0):
    N = n * n
    T = [{u for u in range(N) if int(maps[g][u]) in S0} for g in M]
    inT = [[gi for gi, t in enumerate(T) if u in t] for u in range(N)]
    lab = list(lab0)
    pi = {}
    for c in range(N):                                   # region id mirror map
        a, b = lab[c], lab[sigma[c]]
        if pi.setdefault(a, b) != b: return None         # start layout not sigma-invariant
    if any(pi.get(pi[a]) != a for a in pi): return None
    members = {k: set() for k in range(n)}
    for c in range(N): members[lab[c]].add(c)
    cnt = [[0] * n for _ in M]
    for u in range(N):
        for gi in inT[u]: cnt[gi][lab[u]] += 1

    def local_E(regs):
        return sum(abs(cnt[gi][k] - stars) for gi in range(len(M)) for k in regs)

    def connected(k):
        mem = members[k]
        if not mem: return False
        start = next(iter(mem)); seen = {start}; stack = [start]
        while stack:
            x = stack.pop()
            for y in nb[x]:
                if y in mem and y not in seen: seen.add(y); stack.append(y)
        return len(seen) == len(mem)

    def move(c, k, k2):
        members[k].discard(c); members[k2].add(c); lab[c] = k2
        for gi in inT[c]: cnt[gi][k] -= 1; cnt[gi][k2] += 1

    E = sum(abs(cnt[gi][k] - stars) for gi in range(len(M)) for k in range(n))
    for it in range(iters):
        if E == 0: return lab
        T_ = t0 * (t1 / t0) ** (it / iters)
        c = rng.randrange(N); k = lab[c]
        ks = {lab[v] for v in nb[c] if lab[v] != k}
        if not ks: continue
        k2 = rng.choice(tuple(ks)); c2 = sigma[c]
        moves = [(c, k, k2)]
        if c2 != c:
            moves.append((c2, lab[c2], pi[k2]))
        else:
            if pi[k] != k or pi[k2] != k2: continue          # a diagonal cell can only live in a self-mirror region
        # a move set is only valid if it keeps all regions >= 3 cells (checked after applying)
        regs = {k, k2, pi[k], pi[k2]}
        before = local_E(regs); sq_before = sum(len(members[r]) ** 2 for r in regs)
        applied = []
        for (cc, a, b) in moves:
            if a != b: move(cc, a, b); applied.append((cc, a, b))
        ok = all(len(members[r]) >= 3 and connected(r) for r in regs)
        d = local_E(regs) - before
        dsz = -size_bias * (sum(len(members[r]) ** 2 for r in regs) - sq_before) if size_bias else 0.0   # prefer varied region sizes (easier puzzles)
        if ok and (d + dsz <= 0 or rng.random() < math.exp(-(d + dsz) / T_)):
            E += d
        else:
            for (cc, a, b) in reversed(applied): move(cc, b, a)
    return lab if E == 0 else None


def parse(cls):
    toks = cls.split('_'); parts = []; i = 0
    while i < len(toks):
        for L in (2, 1):
            c = "_".join(toks[i:i + L])
            if c in TRANSFORM_NAMES: parts.append(c); i += L; break
    return (0,) + tuple(TRANSFORM_NAMES.index(p) for p in parts)


if __name__ == "__main__":
    cls = sys.argv[1]; n = int(sys.argv[2]); stars = int(sys.argv[3]); trials = int(sys.argv[4])
    iters = int(sys.argv[5]) if len(sys.argv) > 5 else 200000
    sym_name = os.environ.get("SYM", "diagonal"); sig_t = {"diagonal": "flip_diag"}[sym_name]
    M = parse(cls)
    TARGET_SYM = TRANSFORM_NAMES.index(os.environ.get('TARGET_SYM', 'flip_antidiag'))
    maps = [np.array(m[0]) for m in get_transformation_maps(n)]
    sigma = [int(x) for x in maps[TRANSFORM_NAMES.index(sig_t)]]
    nb = cp.neighbours4(n); rng = random.Random(int(time.time() * 1000) ^ (os.getpid() << 8))
    t = time.time(); started = planted = valid = 0; hist = {}
    for tr in range(trials):
        lab0 = symmetric_start(n, sym_name, stars, rng.randrange(10**9))
        if lab0 is None: continue
        started += 1
        S0 = cp.random_solution_cp(n, stars, rng, maps, TARGET_SYM)   # a unique common solution must be invariant under the reflection that permutes the copies
        if S0 is None: continue
        lab = plant_sym(M, S0, n, stars, rng, maps, nb, sigma, lab0, iters, size_bias=float(os.environ.get('SIZE_BIAS', '0')))
        if lab is None: continue
        planted += 1
        c, ok = cp.evaluate(M, lab, S0, n, stars, maps); valid += ok; hist[min(c, 9)] = hist.get(min(c, 9), 0) + 1
        if ok and os.environ.get("OUT"):
            from board_utils import canonical_relabel
            boards = []
            for g in M:
                gr = [0] * (n * n)
                for u in range(n * n): gr[int(maps[g][u])] = lab[u]
                boards.append(canonical_relabel("".join(ALPHABET[v] for v in gr)))
            import csv
            new = not os.path.exists(os.environ["OUT"])
            with open(os.environ["OUT"], "a", newline="") as fh:
                w = csv.writer(fh, lineterminator="\n")
                if new: w.writerow(["name", "N"] + [f"board_{i+1}" for i in range(len(M))] + ["solution"])
                w.writerow([f"puzzle_{os.getpid() * 100000 + tr}_diag_{cls}", n] + boards + ["".join('x' if c2 in S0 else '.' for c2 in range(n * n))])
    print(f"{cls} {sym_name} n={n}: started {started}, planted {planted}, valid puzzles {valid} of {trials} trials in {time.time()-t:.0f}s; |I| hist {dict(sorted(hist.items()))}")
