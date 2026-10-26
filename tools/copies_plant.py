#!/usr/bin/env python3
"""copies_plant.py -- prototype "planted" generator for K-copy puzzles (a board plus K-1 of its rotations/reflections whose only common solution is
a chosen S0).  For a transform set M, board B must accept T_g = g^-1(S0) (every region holds exactly `stars` cells of every T_g); that is found
by simulated annealing over contiguous region labelings.  Random boards almost never have a common solution for non-group sets, so planting
is what makes those classes reachable.

    venv/bin/python copies_plant.py CLASS n stars trials   # quick convergence/uniqueness probe on one core
"""
import sys, os, math, random, time
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from board_utils import ALPHABET, get_transformation_maps, TRANSFORM_NAMES, flood_fill
import fast_solve


def random_solution(n, stars, rng):
    """random valid placement: `stars` per row/col, no two touching (8-neighbourhood)"""
    for _ in range(1000):
        cols = [0] * n; placed = []; ok = True
        def rec(r, colcnt):
            if r == n: return all(c == stars for c in colcnt)
            cand = [c for c in range(n) if colcnt[c] < stars]
            rng.shuffle(cand)
            for combo in _pairs(cand, stars):
                if any(abs(a - b) <= 1 for a in combo for b in combo if a != b): continue
                if r > 0 and any(abs(a - b) <= 1 for a in combo for b in placed[r - 1]): continue
                if (n - r - 1) * stars < sum(stars - colcnt[c] for c in range(n)) - stars: continue
                for c in combo: colcnt[c] += 1
                placed.append(combo)
                if rec(r + 1, colcnt): return True
                placed.pop()
                for c in combo: colcnt[c] -= 1
            return False
        def _pairs(cand, k):
            import itertools
            return itertools.islice(itertools.combinations(cand, k), 60)
        if rec(0, [0] * n):
            return {r * n + c for r, row in enumerate(placed) for c in row}
    raise RuntimeError("no random solution")


def random_solution_cp(n, stars, rng, maps=None, sym=None):
    """random valid placement via CP-SAT with a random objective; `sym` = index of a transform the solution must be invariant under"""
    from ortools.sat.python import cp_model
    m = cp_model.CpModel(); x = [m.new_bool_var(f'x{i}') for i in range(n * n)]
    for r in range(n):
        m.add(sum(x[r * n + c] for c in range(n)) == stars); m.add(sum(x[c * n + r] for c in range(n)) == stars)
    for i in range(n * n):
        r, c = divmod(i, n)
        for dr, dc in ((0, 1), (1, 0), (1, 1), (1, -1)):
            rr, cc = r + dr, c + dc
            if 0 <= rr < n and 0 <= cc < n: m.add(x[i] + x[rr * n + cc] <= 1)
    for k in ([sym] if isinstance(sym, int) else (sym or [])):
        if k:
            for i in range(n * n): m.add(x[i] == x[int(maps[k][i])])
    m.maximize(sum(rng.randrange(1000) * x[i] for i in range(n * n)))
    s = cp_model.CpSolver(); s.parameters.max_time_in_seconds = 5; s.parameters.random_seed = rng.randrange(10**6); s.parameters.num_workers = 1
    st = s.solve(m)
    if st not in (cp_model.OPTIMAL, cp_model.FEASIBLE): return None
    return {i for i in range(n * n) if s.value(x[i])}


def neighbours4(n):
    nb = []
    for i in range(n * n):
        r, c = divmod(i, n); l = []
        if r > 0: l.append(i - n)
        if r < n - 1: l.append(i + n)
        if c > 0: l.append(i - 1)
        if c < n - 1: l.append(i + 1)
        nb.append(l)
    return nb


def plant(M, S0, n, stars, rng, maps, nb, iters=300000, t0=0.8, t1=0.05, size_bias=0.0):
    """returns a labeling (list of region ids) that accepts T_g for all g in M, or None"""
    N = n * n
    T = []
    for g in M:                                   # T_g = cells u whose image maps[g][u] is a star of S0
        T.append({u for u in range(N) if int(maps[g][u]) in S0})
    inT = [[gi for gi, t in enumerate(T) if u in t] for u in range(N)]
    for _ in range(50):                            # random contiguous start
        seeds = rng.sample(range(N), n)
        grid = [None] * N
        for rid, cell in enumerate(seeds): grid[cell] = rid
        g0 = flood_fill(grid, n)
        if g0 is not None: break
    else:
        return None
    lab = list(g0)
    size = [0] * n
    cnt = [[0] * n for _ in M]
    for u in range(N):
        size[lab[u]] += 1
        for gi in inT[u]: cnt[gi][lab[u]] += 1
    E = sum(abs(cnt[gi][k] - stars) for gi in range(len(M)) for k in range(n))
    for it in range(iters):
        if E == 0: return lab
        T_ = t0 * (t1 / t0) ** (it / iters)
        c = rng.randrange(N); k = lab[c]
        ks = {lab[v] for v in nb[c] if lab[v] != k}
        if not ks or size[k] <= 3: continue
        k2 = rng.choice(tuple(ks))
        d = 0
        for gi in inT[c]:
            d += abs(cnt[gi][k] - 1 - stars) - abs(cnt[gi][k] - stars) + abs(cnt[gi][k2] + 1 - stars) - abs(cnt[gi][k2] - stars)
        # optional preference for varied region sizes (easier puzzles have more tiny and more huge regions): moving a cell from a smaller to a
        # larger region raises the sum of squared sizes by 2*(size_k2 - size_k) + 2
        dsz = -size_bias * (2 * (size[k2] - size[k]) + 2) if size_bias else 0.0
        if d + dsz > 0 and rng.random() >= math.exp(-(d + dsz) / T_): continue
        # source region must stay connected without c
        same = [v for v in nb[c] if lab[v] == k]
        if len(same) > 1:
            seen = {same[0]}; stack = [same[0]]
            while stack:
                x = stack.pop()
                for y in nb[x]:
                    if y != c and lab[y] == k and y not in seen: seen.add(y); stack.append(y)
            if any(v not in seen for v in same): continue
        lab[c] = k2; size[k] -= 1; size[k2] += 1
        for gi in inT[c]: cnt[gi][k] -= 1; cnt[gi][k2] += 1
        E += d
    return lab if E == 0 else None


if __name__ == "__main__":
    cls = sys.argv[1]; n = int(sys.argv[2]); stars = int(sys.argv[3]); trials = int(sys.argv[4])
    iters = int(sys.argv[5]) if len(sys.argv) > 5 else 300000
    M = (0,) + tuple(TRANSFORM_NAMES.index(x) for x in cls.split('_', 1)[0:0] or []) if False else None
    names = [x for x in cls.split('_')]
    # class names are underscore-joined transform names, some of which contain underscores (flip_h): greedy match
    parts = []; i = 0; toks = names
    while i < len(toks):
        for L in (2, 1):
            cand = "_".join(toks[i:i + L])
            if cand in TRANSFORM_NAMES: parts.append(cand); i += L; break
        else: raise SystemExit("bad class " + cls)
    M = (0,) + tuple(TRANSFORM_NAMES.index(p) for p in parts)
    maps = [np.array(m[0]) for m in get_transformation_maps(n)]
    nb = neighbours4(n); rng = random.Random(int(time.time()))
    ok = uniq = 0; tt = time.time(); nsol = []
    for t in range(trials):
        S0 = random_solution(n, stars, rng)
        lab = plant(M, S0, n, stars, rng, maps, nb, iters)
        if lab is None: continue
        ok += 1
        grids = []
        for g in M:                              # board g(B): cell maps[g][u] gets label lab[u]
            gr = [0] * (n * n)
            for u in range(n * n): gr[int(maps[g][u])] = lab[u]
            grids.append(gr)
        sols = fast_solve.joint_solutions(grids, n, stars, cap=50)
        nsol.append(len(sols) if sols is not None else -1)
        if sols is not None and len(sols) == 1: uniq += 1
    print(f"{cls} n={n}: planted {ok}/{trials} in {time.time()-tt:.0f}s; unique at once {uniq}; common-solution counts (cap 50): {sorted(nsol)}")


def evaluate(M, lab, S0, n, stars, maps):
    """(common solution count capped at 50, valid?) -- valid = exactly S0 in common and every leave-one-out subset ambiguous"""
    grids = []
    for g in M:
        gr = [0] * (n * n)
        for u in range(n * n): gr[int(maps[g][u])] = lab[u]
        grids.append(gr)
    full = fast_solve.joint_solutions(grids, n, stars, cap=50)
    if full is None: return -1, False
    s0str = "".join('x' if c in S0 else '.' for c in range(n * n))
    if len(full) != 1 or full[0] != s0str: return len(full), False
    for i in range(len(M)):
        sub = fast_solve.joint_solutions(grids[:i] + grids[i + 1:], n, stars, cap=2)
        if sub is None or len(sub) < 2: return 1, False
    return 1, True
