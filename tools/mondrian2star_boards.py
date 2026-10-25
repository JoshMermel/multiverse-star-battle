"""mondrian2star_boards.py n seconds workers out.pkl [stars=2] [min_region=3] [balanced=1.0] [degenerate=0.2]
Time-boxed generation of Mondrian (all-rectangle, 2-star) boards, with stats.  Solves with the C enumerator (fast_solve.py), not CP-SAT.
Pickle: {board string: int16 array (num_solutions, 2n) of star cell indices}; pair them with mondrian2star_pairs.py."""
import sys, time, random, pickle, os, statistics
CWD = os.getcwd(); TOOLS = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, TOOLS)
os.chdir(TOOLS)
from concurrent.futures import ProcessPoolExecutor
from subdivision_generator import SubdivisionGenerator
import fast_solve
from board_utils import ALPHABET, get_transformation_maps, canonical_relabel
from filter import board_contains_swastika

CAP = 4000


def canon(bs, maps):
    best = None
    for m in maps:
        r = [""] * len(bs)
        for i, ch in enumerate(bs):
            r[m[i]] = ch
        s = canonical_relabel("".join(r))
        if best is None or s < best:
            best = s
    return best


def worker(job):
    n, secs, seed, stars, minreg, bal, deg = job
    random.seed(seed)
    class G(SubdivisionGenerator):
        BALANCED_WEIGHT = bal
        DEGENERATE_WEIGHT = deg
    g = G(n, stars_per_unit=stars, min_region_size=minreg)
    maps = [m[0] for m in get_transformation_maps(n)]
    st = dict(draws=0, struct=0, dup=0, swast=0, toomany=0, zero=0)
    boards, seen = {}, set()
    t0 = time.time()
    while time.time() - t0 < secs:
        st['draws'] += 1
        cap = []
        g._make_result = lambda grid, *a, **k: cap.append(grid) or None
        g._try_generate()
        if not cap:
            continue
        grid = cap[0]; st['struct'] += 1
        bs = "".join(ALPHABET[v] for v in grid)
        if board_contains_swastika(bs, n):
            st['swast'] += 1; continue
        cs = canon(bs, maps)
        if cs in seen:
            st['dup'] += 1; continue
        seen.add(cs)
        sols = fast_solve.solution_cells(grid, n, CAP)
        if sols is None:
            st['toomany'] += 1; continue
        if len(sols) == 0:
            st['zero'] += 1; continue
        boards[bs] = sols
    return st, boards


if __name__ == '__main__':
    n = int(sys.argv[1]); secs = float(sys.argv[2]); W = int(sys.argv[3]); out = sys.argv[4]
    stars = int(sys.argv[5]) if len(sys.argv) > 5 else 2
    minreg = int(sys.argv[6]) if len(sys.argv) > 6 else 3
    bal = float(sys.argv[7]) if len(sys.argv) > 7 else 1.0
    deg = float(sys.argv[8]) if len(sys.argv) > 8 else 0.2
    seed0 = int(time.time()) % 100000 * 100
    with ProcessPoolExecutor(W) as ex:
        res = list(ex.map(worker, [(n, secs, seed0 + i, stars, minreg, bal, deg) for i in range(W)]))
    tot, boards = {}, {}
    for st, b in res:
        for k, v in st.items(): tot[k] = tot.get(k, 0) + v
        boards.update(b)
    maps = [m[0] for m in get_transformation_maps(n)]
    canon_seen = {}
    for b, s in boards.items():                 # cross-worker dedupe
        canon_seen.setdefault(canon(b, maps), (b, s))
    boards = {b: s for b, s in canon_seen.values()}
    cnts = sorted(len(v) for v in boards.values())
    print(f'n={n} stars={stars} minreg={minreg} bal={bal} deg={deg}: {tot}')
    print(f'  distinct solvable boards (cross-worker deduped): {len(boards)}  unique-solution: {sum(1 for c in cnts if c == 1)}')
    if cnts: print(f'  solution counts: min {cnts[0]} p25 {cnts[len(cnts)//4]} median {statistics.median(cnts)} p75 {cnts[3*len(cnts)//4]} max {cnts[-1]}')
    pickle.dump(boards, open(os.path.join(CWD, out), 'wb'))
    # boards with exactly one solution are already complete 1-board puzzles: set them aside (name,N,board,solution)
    uniq = [(b, s) for b, s in boards.items() if len(s) == 1]
    if uniq:
        import csv
        with open(os.path.join(CWD, out.replace('.pkl', '') + '_unique.csv'), 'w', newline='') as f:
            w = csv.writer(f, lineterminator='\n'); w.writerow(['name', 'N', 'board', 'solution'])
            for k, (b, s) in enumerate(uniq):
                cells = set(s[0].tolist())
                w.writerow([f'mond2_unique_{n}_{k}', n, canonical_relabel(b), ''.join('x' if c in cells else '.' for c in range(n * n))])
        print(f'  set aside {len(uniq)} unique-solution boards -> {out.replace(".pkl", "")}_unique.csv')
