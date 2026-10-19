"""squarefree_3star_pairs.py prefix pairs_out.csv unique_out.csv in1.pkl [in2.pkl ...]
Boards from sf3_fast.py (solution sets as indices into placements13_3.npy).  Boards with exactly one solution -> unique_out;
pairs of individually-ambiguous boards (8 orientations of the second) sharing exactly one placement -> pairs_out (rotation/reflection-deduped)."""
import sys, os, pickle, itertools, csv, collections
import numpy as np
HERE=os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0,os.path.dirname(os.path.abspath(__file__)))
from board_utils import get_transformation_maps, canonical_relabel
from puzzle_deduper import PuzzleDeduper
n=13
prefix,pout,uout=sys.argv[1:4]
boards={}
for f in sys.argv[4:]: boards.update(pickle.load(open(f,'rb')))
P=np.load(os.path.join(HERE,'library','playground','placements13_3.npy'))
maps=[m[0] for m in get_transformation_maps(n)]
key={P[i].tobytes():i for i in range(len(P))}
perm=[]
for m in maps:
    Q=np.zeros_like(P); Q[:,m]=P      # cell i -> m[i]
    perm.append(np.array([key[Q[i].tobytes()] for i in range(len(P))],dtype=np.int32))
def tb(b,m):
    r=[""]*(n*n)
    for i,ch in enumerate(b): r[m[i]]=ch
    return "".join(r)
def sol_str(i): return ''.join('x' if v else '.' for v in P[i])
names=list(boards)
uniq=[b for b in names if len(boards[b])==1]; amb=[b for b in names if len(boards[b])>1]
print(f'{len(names)} boards: {len(uniq)} unique-solution, {len(amb)} ambiguous (solution counts of ambiguous: median {int(np.median([len(boards[b]) for b in amb])) if amb else 0})')
with open(uout,'w',newline='') as f:
    w=csv.writer(f,lineterminator='\n'); w.writerow(['name','N','board_1','solution'])
    for i,b in enumerate(uniq): w.writerow([f'{prefix}_uniq_{i}',n,canonical_relabel(b),sol_str(boards[b][0])])
# Inverted index instead of testing every board pair: for each placement p, the boards containing p as-is (ident) and the
# (board, orientation) entries containing p after transforming (var).  Co-occurrences give every pair's overlap size.
ident=collections.defaultdict(list); var=collections.defaultdict(list)
for bi,b in enumerate(amb):
    sol=boards[b]
    for p in sol.tolist(): ident[p].append(bi)
    for jx in range(8):
        for p in perm[jx][sol].tolist(): var[p].append((bi,jx))
cnt=collections.Counter()
for p,As in ident.items():
    Es=var.get(p,())
    for a in As:
        for (b,jx) in Es:
            if a<b: cnt[(a,b,jx)]+=1
hist=collections.Counter(min(v,5) for v in cnt.values())
hist[0]=len(amb)*(len(amb)-1)//2*8-sum(hist.values())
print(f'pair-variants with overlap {sum(v for k,v in hist.items() if k)}; intersection size histogram (5 = 5+): {sorted(hist.items())}')
hits=[]
for (a,b,jx),v in cnt.items():
    if v!=1: continue
    c=set(boards[amb[a]].tolist())&set(perm[jx][boards[amb[b]]].tolist())
    hits.append((amb[a],tb(amb[b],maps[jx]),sol_str(next(iter(c)))))
ded=PuzzleDeduper(); out=[]
for a,b,s in hits:
    bs=[canonical_relabel(a),canonical_relabel(b)]
    if ded.is_duplicate(bs,n): continue
    ded.register(bs,n); out.append((bs,s))
print(f'exact-1 hits {len(hits)}; distinct puzzles after rotation/reflection dedupe: {len(out)}')
with open(pout,'w',newline='') as f:
    w=csv.writer(f,lineterminator='\n'); w.writerow(['name','N','board_1','board_2','solution'])
    for i,(bs,s) in enumerate(out): w.writerow([f'{prefix}_{i}',n,bs[0],bs[1],s])
