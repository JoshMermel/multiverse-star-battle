"""venn2star_pairs.py n out.csv in1.pkl [in2.pkl...]  -- pair boards (8 variants of board j vs board i), emit exact-1-common-solution puzzles; also 1-board and 3-board counts"""
import sys, pickle, itertools, random, csv
import os; sys.path.insert(0,os.path.dirname(os.path.abspath(__file__)))
from board_utils import get_transformation_maps, canonical_relabel
n=int(sys.argv[1]); out=sys.argv[2]
boards={}
for f in sys.argv[3:]: boards.update(pickle.load(open(f,'rb')))
maps=[m[0] for m in get_transformation_maps(n)]
def tb(b,m):
    r=[""]*(n*n)
    for i,ch in enumerate(b): r[m[i]]=ch
    return "".join(r)
def tsol(s,m):
    v=0
    for i,ch in enumerate(s):
        if ch=='x': v|=1<<m[i]
    return v
names=list(boards)
V=[]  # per board: list of 8 (board_str, frozenset(solint))
for b in names:
    V.append([(tb(b,m), frozenset(tsol(s,m) for s in boards[b])) for m in maps])
print(f'{len(names)} boards; unique-solution boards (1-board puzzles): {sum(1 for b in names if len(boards[b])==1)}')
def intcsv(v): return ''.join('x' if v>>i&1 else '.' for i in range(n*n))
amb=[i for i in range(len(names)) if len(V[i][0][1])>1]
rows=[]; pairs_tested=0
for a,b in itertools.combinations(amb,2):
    sa=V[a][0][1]
    for vb,sb in V[b]:
        pairs_tested+=1
        c=sa&sb
        if len(c)==1: rows.append((names[a],vb,intcsv(next(iter(c))),len(sa),len(sb)))
print(f'ambiguous boards {len(amb)}; pair-variants tested {pairs_tested}; exact-1 hits {len(rows)}')
seen=set(); uniq=[]
for r in rows:
    k=frozenset([canonical_relabel(r[0]),canonical_relabel(r[1])])
    if k in seen: continue
    seen.add(k); uniq.append(r)
print(f'2-board puzzles after dedupe: {len(uniq)}')
with open(out,'w',newline='') as f:
    w=csv.writer(f,lineterminator='\n'); w.writerow(['name','N','board_1','board_2','solution'])
    for i,r in enumerate(uniq): w.writerow([f'venn2_{n}_{i}',n,canonical_relabel(r[0]),canonical_relabel(r[1]),r[2]])
# 3-board: a,b-variant,c-variant; every board ambiguous, each pair ambiguous (>1), trio exactly 1
import time; t0=time.time(); tri=[]; seen3=set()
for a,b in itertools.combinations(amb,2):
    sa=V[a][0][1]
    for vb,sb in V[b]:
        I=sa&sb
        if not (2<=len(I)<=40): continue
        for c in amb:
            if c==a or c==b: continue
            for vc,sc in V[c]:
                if len(I&sc)==1 and len(sa&sc)>1 and len(sb&sc)>1:
                    k=frozenset([canonical_relabel(names[a]),canonical_relabel(vb),canonical_relabel(vc)])
                    if k not in seen3: seen3.add(k); tri.append((names[a],vb,vc,intcsv(next(iter(I&sc)))))
    if time.time()-t0>120: print('  (3-board search time-capped)'); break
print(f'3-board puzzles (each pair ambiguous): {len(tri)}')
with open(out.replace('.csv','_3.csv'),'w',newline='') as f:
    w=csv.writer(f,lineterminator='\n'); w.writerow(['name','N','board_1','board_2','board_3','solution'])
    for i,r in enumerate(tri): w.writerow([f'venn3_{n}_{i}',n,canonical_relabel(r[0]),canonical_relabel(r[1]),canonical_relabel(r[2]),r[3]])
