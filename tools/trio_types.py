#!/usr/bin/env python3
"""trio_types.py pool.csv [ntypes] -- tally a symmetric-triplets pool by type (name suffix) x tier (in the 10x10 score bands) vs equal-share targets.
Targets: a 100/400/400/100 book split equally over the types."""
import csv, sys, collections
csv.field_size_limit(10**9)
BANDS = {'Beginner': (70, 205), 'Medium': (190, 380), 'Hard': (310, 500), 'Expert': (335, 795)}
QUOTA = {'Beginner': 100, 'Medium': 400, 'Hard': 400, 'Expert': 100}
rows = list(csv.DictReader(open(sys.argv[1])))
typ = lambda r: r['name'].split('_', 2)[2]
types = sorted({typ(r) for r in rows})
inb = collections.defaultdict(collections.Counter); gm = collections.Counter(); un = collections.Counter(); tot = collections.Counter()
for r in rows:
    t = typ(r); tot[t] += 1
    if r['tier'] == 'Grandmaster': gm[t] += 1
    if r['tier'] == 'UNSOLVED': un[t] += 1
    if r['tier'] in BANDS and BANDS[r['tier']][0] <= float(r['score']) <= BANDS[r['tier']][1]: inb[t][r['tier']] += 1
k = len(types)
print(f"{len(rows)} rows, {k} types; per-type target = " + ", ".join(f"{t[0]}{QUOTA[t]/k:.0f}" for t in QUOTA))
print(f"{'type':32s}{'rows':>7s}" + "".join(f"{t:>10s}" for t in BANDS) + f"{'GM':>6s}{'UNSOLVED':>10s}")
for t in types:
    cells = []
    for tier in BANDS:
        have = inb[t][tier]; need = QUOTA[tier] / k
        cells.append(f"{have:>7d}{'*' if have < need else ' ':<3s}")
    print(f"{t:32s}{tot[t]:7d}" + "".join(cells) + f"{gm[t]:6d}{un[t]:10d}")
print("(* = fewer in-band candidates than the equal-share target)")
