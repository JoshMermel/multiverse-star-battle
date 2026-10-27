"""gen_quadrants_2star.py out.csv [--workers 10] [--seconds 1800] [--seed 0] [--known pool.csv ...] [--growth JSON]
    -- 16x16 / 2-star "Quadrants" puzzles: two boards whose four 8x8 quadrants are each cut into 4 connected regions that stay inside their
    quadrant (so every quadrant holds exactly 8 stars), with exactly ONE common solution.

Random pairs of such boards share tens of thousands of solutions at this size, so the 1-star book's tile-stitching (quad_aligned_generator.py)
cannot work.  Instead, per attempt:
  1. plant a random 2-star solution with 8 stars in every quadrant (CP-SAT, random objective);
  2. grow each board quadrant by quadrant around the planted stars (solution_first_core.seed_and_grow, biased toward some tiny regions);
  3. repair: ask CP-SAT for any OTHER common solution, then move one of its non-planted stars into a neighbouring region of the same
     quadrant (region stays connected, keeps >3 cells; planted stars never move), which invalidates that alternate; when no such move exists,
     reshape a cell nearby instead.  Repeat until CP-SAT proves the planted solution is the only one.
Finished puzzles are canonically relabelled, swastika-filtered and deduped up to rotation/reflection (and against any --known pools).
Unscored; score with score_csv_sharded.py."""
import sys, os, csv, time, random, json, argparse
import multiprocessing as mp
TOOLS = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, TOOLS); os.chdir(TOOLS)
from ortools.sat.python import cp_model
from board_utils import ALPHABET, canonical_relabel, get_transformation_maps
from filter import board_contains_swastika
from solution_first_core import seed_and_grow
csv.field_size_limit(10**9)

# QUADS_N / QUADS_QUOTA (environment, set before launching so spawned workers agree) change the board size and the number of stars each quadrant
# holds, in the order top-left, top-right, bottom-left, bottom-right; a quadrant with q stars gets q/2 regions.  E.g. the 10x10 variant whose
# quadrants hold 4, 6, 6, 4 stars (2, 3, 3, 2 regions):   QUADS_N=10 QUADS_QUOTA=4,6,6,4 python gen_quadrants_2star.py ...
# (Only the diagonal arrangement is possible: with the two 2-region quadrants side by side, their half of the board would hold 8 stars, not 10.)
N = int(os.environ.get('QUADS_N', 16)); H = N // 2
QUOTA = [int(q) for q in os.environ.get('QUADS_QUOTA', ','.join([str(N // 2)] * 4)).split(',')]
MIN_REGION = 4                      # a region keeps at least this many cells (its two stars are never adjacent)
# (small_region_frac, small_region_weight_max, size_variation), one drawn per board: the fraction of tiny regions is what steers difficulty.
# 2026-10-26 sweep (8 min x 10 workers per setting), share of Beginner / Medium in the resulting pool:
#   (0.75, 0.05, 0.5) 9% / 31%   (0.75, 0.02, 0.0) 18% / 31%   (0.75, 0.1, 1.0) 4% / 16%   (0.5, 0.05, 0.5) 3% / 19%   old mix (0.4-0.75, 0.1-0.2, 0.5-2) 1.4% / 13%
# The default repeats the Beginner-rich settings and keeps the others (plus two untested neighbours) for variety.
GROWTH = [(0.75, 0.02, 0.0)] * 3 + [(0.75, 0.05, 0.5)] * 2 + [(0.75, 0.1, 1.0), (0.5, 0.05, 0.5), (0.75, 0.03, 1.0), (0.6, 0.02, 0.0)]


def quad(i):
    r, c = divmod(i, N)
    return (r // H) * 2 + c // H


def nbrs(i):
    r, c = divmod(i, N)
    if r > 0: yield i - N
    if r < N - 1: yield i + N
    if c > 0: yield i - 1
    if c < N - 1: yield i + 1


def _no_touch(m, x):
    for r in range(N - 1):
        for c in range(N - 1):
            m.add(x[r * N + c] + x[r * N + c + 1] + x[(r + 1) * N + c] + x[(r + 1) * N + c + 1] <= 1)
            m.add(x[r * N + c] + x[(r + 1) * N + c + 1] <= 1)
            m.add(x[r * N + c + 1] + x[(r + 1) * N + c] <= 1)


def _base_model():
    m = cp_model.CpModel()
    x = [m.new_bool_var(f'x{i}') for i in range(N * N)]
    for r in range(N): m.add(sum(x[r * N + c] for c in range(N)) == 2)
    for c in range(N): m.add(sum(x[r * N + c] for r in range(N)) == 2)
    _no_touch(m, x)
    return m, x


def _solve(m, x, rnd, tl):
    m.maximize(sum(rnd.randint(0, 50) * v for v in x))          # random objective: varied solutions
    s = cp_model.CpSolver()
    s.parameters.max_time_in_seconds = tl; s.parameters.num_workers = 1; s.parameters.random_seed = rnd.randint(0, 10**6)
    st = s.solve(m)
    if st in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return [i for i in range(N * N) if s.value(x[i])]
    return 'none' if st == cp_model.INFEASIBLE else None


def planted_solution(rnd):
    m, x = _base_model()
    for qr in range(2):
        for qc in range(2):
            m.add(sum(x[(qr * H + r) * N + qc * H + c] for r in range(H) for c in range(H)) == QUOTA[qr * 2 + qc])
    sol = _solve(m, x, rnd, 10)
    return sol if isinstance(sol, list) else None


def other_solution(boards, planted, rnd):
    """a common solution different from the planted one, 'none' if there isn't any (= unique), None on timeout"""
    m, x = _base_model()
    for b in boards:
        for reg in set(b): m.add(sum(x[i] for i in range(N * N) if b[i] == reg) == 2)
    m.add(sum(x[i] for i in planted) <= len(planted) - 1)
    return _solve(m, x, rnd, 20)


def grow_board(stars, rnd):
    frac, wmax, var = rnd.choice(GROWTH)      # GROWTH can be overridden per run with --growth
    grid, nreg = [None] * (N * N), 0
    for qr in range(2):
        for qc in range(2):
            loc = [(r - qr * H) * H + (c - qc * H) for i in stars for r, c in [divmod(i, N)]
                   if qr * H <= r < (qr + 1) * H and qc * H <= c < (qc + 1) * H]
            res = seed_and_grow(loc, H, 2, size_variation=var, small_region_frac=frac, small_region_weight=0.02, small_region_weight_max=wmax)
            if res is None: return None
            g, _ = res
            for i, v in enumerate(g):
                r, c = divmod(i, H)
                grid[(qr * H + r) * N + qc * H + c] = nreg + v
            nreg += max(g) + 1
    return grid


def _connected_without(b, i):
    cells = {j for j in range(N * N) if b[j] == b[i] and j != i}
    if not cells: return False
    start = next(iter(cells)); seen = {start}; st = [start]
    while st:
        for y in nbrs(st.pop()):
            if y in cells and y not in seen: seen.add(y); st.append(y)
    return len(seen) == len(cells)


def moves(b, stars, i):
    """regions cell i could move to (same quadrant, source region stays connected and big enough)"""
    if i in stars: return []
    out = []
    for j in nbrs(i):
        if b[j] != b[i] and quad(j) == quad(i) and b[j] not in out: out.append(b[j])
    if not out or sum(1 for j in range(N * N) if b[j] == b[i]) <= MIN_REGION - 1 or not _connected_without(b, i): return []
    return out


def make_unique(seed, tmax=45):
    """(boards, planted star cells) with exactly one common solution, or None"""
    rnd = random.Random(seed)
    stars = planted_solution(rnd)
    if stars is None: return None
    S = set(stars)
    boards = [grow_board(stars, rnd) for _ in range(2)]
    if None in boards: return None
    t0 = time.time()
    while time.time() - t0 < tmax:
        alt = other_solution(boards, stars, rnd)
        if alt == 'none': return boards, stars
        if alt is None: return None
        diff = [i for i in alt if i not in S]; rnd.shuffle(diff)
        done = False
        for i in diff:                                           # kill the alternate: move one of its non-planted stars
            for bi in rnd.sample(range(2), 2):
                mv = moves(boards[bi], S, i)
                if mv: boards[bi][i] = rnd.choice(mv); done = True; break
            if done: break
        if not done:                                             # no star of it can move: reshape somewhere nearby so one can
            near = set()
            for i in diff:
                near |= set(nbrs(i))
                for j in list(near): near |= set(nbrs(j))
            near = [j for j in near if j not in S]; rnd.shuffle(near)
            for j in near:
                bi = rnd.randrange(2); mv = moves(boards[bi], S, j)
                if mv: boards[bi][j] = rnd.choice(mv); break
    return None


_maps = [m[0] for m in get_transformation_maps(N)]


def _transform(b, m):
    r = [''] * (N * N)
    for i, ch in enumerate(b): r[m[i]] = ch
    return ''.join(r)


def canonical_key(boards):
    """identical for puzzles equal up to global rotation/reflection, board order and region relabelling"""
    return min(tuple(sorted(canonical_relabel(_transform(b, m)) for b in boards)) for m in _maps)


def worker(args):
    wid, seed0, seconds, out, growth = args
    if growth: GROWTH[:] = [tuple(g) for g in growth]
    t_end = time.time() + seconds; seed = seed0 + wid * 10**6; n = 0
    with open(out, 'w', newline='') as f:
        w = csv.writer(f, lineterminator='\n')
        while time.time() < t_end:
            seed += 1
            r = make_unique(seed)
            if r is None: continue
            boards, stars = r; S = set(stars)
            strs = [''.join(ALPHABET[v] for v in b) for b in boards]
            sol = ''.join('x' if i in S else '.' for i in range(N * N))
            if len(set(QUOTA)) > 1:          # lopsided quadrants: show every orientation, not just the planted one
                m = random.Random(seed).choice(_maps)
                strs, sol = [_transform(t, m) for t in strs], _transform(sol, m)
            strs = [canonical_relabel(t) for t in strs]
            if any(board_contains_swastika(t, N) for t in strs): continue
            w.writerow([f'puzzle_{seed}', N] + strs + [sol]); f.flush(); n += 1
    return n


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('out'); ap.add_argument('--workers', type=int, default=10); ap.add_argument('--seconds', type=int, default=1800)
    ap.add_argument('--seed', type=int, default=0); ap.add_argument('--known', nargs='*', default=[])
    ap.add_argument('--growth', help='JSON list of [small_region_frac, weight_max, size_variation] to draw from instead of the default mix')
    a = ap.parse_args()
    parts = [f'{a.out}.part{k}' for k in range(a.workers)]
    with mp.Pool(a.workers) as pool:
        counts = pool.map(worker, [(k, a.seed, a.seconds, parts[k], json.loads(a.growth) if a.growth else None) for k in range(a.workers)])
    print('raw unique puzzles per worker:', counts, flush=True)
    seen = set()
    for kf in a.known:
        for r in csv.DictReader(open(kf)):
            if int(r['N']) == N: seen.add(canonical_key([r['board_1'], r['board_2']]))
    rows = []
    for p in parts:
        for r in csv.reader(open(p)):
            k = canonical_key(r[2:4])
            if k in seen: continue
            seen.add(k); rows.append(r)
        os.remove(p)
    with open(a.out, 'w', newline='') as f:
        w = csv.writer(f, lineterminator='\n'); w.writerow(['name', 'N', 'board_1', 'board_2', 'solution'])
        for i, r in enumerate(rows): r[0] = f'puzzle_{i + 1}'; w.writerow(r)
    print(f'{len(rows)} distinct puzzles written to {a.out}', flush=True)
