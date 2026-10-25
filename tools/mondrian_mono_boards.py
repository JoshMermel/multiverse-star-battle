"""mondrian_mono_boards.py n stars seconds workers out.csv [--known FILE ...] [--min-region M] [--balanced B] [--degenerate D]
Time-boxed search for single Mondrian (all-rectangle) boards with EXACTLY ONE solution -- complete 1-board puzzles.
Boards come from SubdivisionGenerator; uniqueness is checked with the C joint solver stopping at 2 solutions, so no solution sets are stored.
Output rows (name,N,board_1,solution) are distinct up to rotation/reflection/relabeling and also distinct from any --known file."""
import sys, os, time, random, csv, argparse
TOOLS = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, TOOLS)
from concurrent.futures import ProcessPoolExecutor
from subdivision_generator import SubdivisionGenerator
from board_utils import ALPHABET, get_transformation_maps, canonical_relabel
from filter import board_contains_swastika
import fast_solve
csv.field_size_limit(10**9)


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
    n, stars, secs, seed, minreg, bal, deg = job
    random.seed(seed)
    class G(SubdivisionGenerator):
        BALANCED_WEIGHT = bal
        DEGENERATE_WEIGHT = deg
    g = G(n, stars_per_unit=stars, min_region_size=minreg)
    maps = [m[0] for m in get_transformation_maps(n)]
    st = dict(draws=0, dup=0, swast=0, many=0, zero=0, unique=0)
    found, seen = {}, set()
    t0 = time.time()
    while time.time() - t0 < secs:
        st['draws'] += 1
        cap = []
        g._make_result = lambda grid, *a, **k: cap.append(grid) or None
        g._try_generate()
        if not cap:
            continue
        grid = cap[0]
        bs = "".join(ALPHABET[v] for v in grid)
        sols = fast_solve.joint_solutions([grid], n, stars, cap=2)
        if len(sols) == 0:
            st['zero'] += 1; continue
        if len(sols) > 1:
            st['many'] += 1; continue
        if board_contains_swastika(bs, n):
            st['swast'] += 1; continue
        cs = canon(bs, maps)
        if cs in seen:
            st['dup'] += 1; continue
        seen.add(cs)
        st['unique'] += 1
        found[cs] = None            # solution is recomputed for the canonical (transformed) board at output time
    return st, found


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("n", type=int); ap.add_argument("stars", type=int); ap.add_argument("seconds", type=float)
    ap.add_argument("workers", type=int); ap.add_argument("out")
    ap.add_argument("--known", nargs="*", default=[])
    ap.add_argument("--min-region", type=int, default=None); ap.add_argument("--balanced", type=float, default=1.0)
    ap.add_argument("--degenerate", type=float, default=0.2); ap.add_argument("--seed", type=int, default=None)
    a = ap.parse_args()
    minreg = a.min_region if a.min_region is not None else (3 if a.stars == 2 else 1)
    seed0 = a.seed if a.seed is not None else int(time.time()) % 100000 * 100
    with ProcessPoolExecutor(a.workers) as ex:
        res = list(ex.map(worker, [(a.n, a.stars, a.seconds, seed0 + i, minreg, a.balanced, a.degenerate) for i in range(a.workers)]))
    maps = [m[0] for m in get_transformation_maps(a.n)]
    known = set()
    for f in a.known:
        for r in csv.DictReader(open(f, newline="")):
            known.add(canon(r["board_1"] if "board_1" in r else r["board"], maps))
    tot, found = {}, {}
    for st, fd in res:
        for k, v in st.items(): tot[k] = tot.get(k, 0) + v
        for cs, sol in fd.items():
            if cs not in known: found.setdefault(cs, None)
    print(f"n={a.n} stars={a.stars} minreg={minreg} bal={a.balanced} deg={a.degenerate}: {tot}")
    print(f"  distinct new unique-solution boards: {len(found)} (also excluded {sum(1 for st, fd in res for cs in fd if cs in known)} already known)")
    with open(a.out, "w", newline="") as f:
        w = csv.writer(f, lineterminator="\n"); w.writerow(["name", "N", "board_1", "solution"])
        for k, cs in enumerate(found):
            sol = fast_solve.joint_solutions([[ALPHABET.index(c) for c in cs]], a.n, a.stars, cap=2)
            assert len(sol) == 1
            w.writerow([f"mono_mond_{a.stars}s_{a.n}_{k}", a.n, cs, sol[0]])


if __name__ == "__main__":
    main()
