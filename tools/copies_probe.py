"""copies_probe.py kind n K seconds workers out.pkl [cap=30000] [stars=2]
Probe: boards of KIND (random | 180 | diag | mirror | translate | t180) at n x n, 2 stars; for each board look for K-board 'copy' puzzles
(board + K-1 of its rotations/reflections) whose full intersection has exactly one solution while every leave-one-out subset is ambiguous."""
import sys, os, time, random, pickle, itertools
import numpy as np
TOOLS = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, TOOLS); os.chdir(TOOLS)
from concurrent.futures import ProcessPoolExecutor
from board_utils import ALPHABET, get_transformation_maps
import fast_solve

KINDS = {'180': ('rot_180', 'none'), 'diag': ('diagonal', 'none'), 'mirror': ('mirror', 'none'),
         'translate': ('none', 'vsplit'), 'translate_h': ('none', 'hsplit'), 't180': ('rot_180', 'vsplit'), 't180_h': ('rot_180', 'hsplit'),
         'translate3': ('none', 'vsplit3'), 'translate3_h': ('none', 'hsplit3'), 't1803': ('rot_180', 'vsplit3'), 't1803_h': ('rot_180', 'hsplit3')}

def worker(job):
    kind, n, K, secs, seed, cap, stars = job
    random.seed(seed)
    if kind == 'random':
        from random_generator import RandomGenerator
        gen = RandomGenerator(n, stars_per_unit=stars)
    else:
        from symmetric_generator import SymmetricGenerator
        sym, tr = KINDS[kind]
        gen = SymmetricGenerator(n, symmetry_type=sym, translation_type=tr, stars_per_unit=stars)
    maps = [np.array(m[0]) for m in get_transformation_maps(n)]
    rng = np.random.default_rng(777)
    Z = rng.integers(0, 2**63, size=n * n, dtype=np.uint64) * np.uint64(2) + rng.integers(0, 2, size=n * n, dtype=np.uint64)
    st = dict(draws=0, struct=0, zero=0, one=0, toomany=0, solvable=0, hit_boards=0, hit_combos=0)
    hits = []   # (board, combo, solution cells)
    sizes = []
    t0 = time.time()
    while time.time() - t0 < secs:
        st['draws'] += 1
        cap_ = []
        gen._make_result = lambda grid, *a, **k: cap_.append(list(grid)) or None
        gen._try_generate()
        if not cap_: continue
        grid = cap_[0]; st['struct'] += 1
        cells = fast_solve.solution_cells(grid, n, cap) if stars == 2 else fast_solve.solution_cells_k(grid, n, stars, cap)
        if cells is None: st['toomany'] += 1; continue
        if len(cells) == 0: st['zero'] += 1; continue
        if len(cells) == 1: st['one'] += 1; continue
        st['solvable'] += 1; sizes.append(len(cells))
        keys = [np.unique(np.bitwise_xor.reduce(Z[m[cells]], axis=1)) for m in maps]
        P = {}
        def pair(i, j):
            if (i, j) not in P: P[(i, j)] = np.intersect1d(keys[i], keys[j], assume_unique=True)
            return P[(i, j)]
        found = 0
        for combo in itertools.combinations(range(1, 8), K - 1):
            members = (0,) + combo
            # leave-one-out subsets (size K-1) must be ambiguous; full must be exactly 1
            ok = True
            for skip in range(K):
                sub = [m for t, m in enumerate(members) if t != skip]
                common = keys[sub[0]]
                for m in sub[1:]:
                    common = np.intersect1d(common, keys[m], assume_unique=True)
                    if len(common) <= 1: break
                if len(common) <= 1: ok = False; break
            if not ok: continue
            full = keys[members[0]]
            for m in members[1:]:
                full = np.intersect1d(full, keys[m], assume_unique=True)
            if len(full) == 1:
                found += 1; hits.append(("".join(ALPHABET[v] for v in grid), members))
        if found: st['hit_boards'] += 1; st['hit_combos'] += found
    return st, hits, sizes

if __name__ == '__main__':
    kind = sys.argv[1]; n = int(sys.argv[2]); K = int(sys.argv[3]); secs = float(sys.argv[4]); W = int(sys.argv[5]); out = sys.argv[6]
    cap = int(sys.argv[7]) if len(sys.argv) > 7 else 30000
    stars = int(sys.argv[8]) if len(sys.argv) > 8 else 2
    seed0 = int(time.time()) % 100000 * 100
    with ProcessPoolExecutor(W) as ex:
        res = list(ex.map(worker, [(kind, n, K, secs, seed0 + i, cap, stars) for i in range(W)]))
    tot = {}; hits = []; sizes = []
    for st, h, s in res:
        for k, v in st.items(): tot[k] = tot.get(k, 0) + v
        hits += h; sizes += s
    sizes.sort()
    print(f"{kind} n={n} K={K} {secs:.0f}s x{W}: {tot}")
    if sizes: print(f"  solution counts of solvable boards: median {sizes[len(sizes)//2]}, p10 {sizes[len(sizes)//10]}, p90 {sizes[9*len(sizes)//10]}")
    if tot['solvable']: print(f"  hit boards per 100k solvable boards: {1e5*tot['hit_boards']/tot['solvable']:.1f}   boards/s: {tot['solvable']/(secs*W):.0f} per worker")
    pickle.dump(hits, open(out, 'wb'))
