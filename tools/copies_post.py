"""copies_post.py n K out.csv in1.pkl [in2.pkl ...] [--kind NAME] [--stars K] [--only-class CLASS ...]  -- distinct (up to global rotation/reflection + relabeling) verified K-copy puzzles from probe hits"""
import sys, os, pickle, csv, random, collections
TOOLS = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, TOOLS); os.chdir(TOOLS)
from board_utils import ALPHABET, get_transformation_maps, canonical_relabel
import fast_solve
from filter import board_contains_swastika
args=sys.argv[1:]; kind=''
if '--kind' in args:                     # board-symmetry kind of these hits (translate, 180, ...): names become puzzle_<id>_<kind>_<class>
    i=args.index('--kind'); kind=args[i+1]+'_'; del args[i:i+2]
stars=2
if '--stars' in args:
    i=args.index('--stars'); stars=int(args[i+1]); del args[i:i+2]
n=int(args[0]); K=int(args[1]); out=args[2]
maps=[m[0] for m in get_transformation_maps(n)]
def tb(b,m):
    r=[""]*(n*n)
    for i,ch in enumerate(b): r[m[i]]=ch
    return "".join(r)
# exact verification + solution; boards are written as the original board followed by its transforms (board_1 = original), names follow the
# library convention puzzle_<id>_<transform names relative to board_1>
from board_utils import TRANSFORM_NAMES
import numpy as np
_idx={tuple(m):g for g,m in enumerate(maps)}
_np_maps=[np.array(m) for m in maps]
def _comp(a,b): return _idx[tuple(_np_maps[a][_np_maps[b]])]
_inv={g:next(h for h in range(8) if _comp(g,h)==0) for g in range(8)}
_class_cache={}
def class_name(M):
    M=tuple(M)
    if M not in _class_cache: _class_cache[M]=_class_name(M)
    return _class_cache[M]
def _class_name(M):
    """canonical puzzle class of a transform set M (contains identity): the same puzzle seen from another base board (M x^-1) or after a
    global rotation/reflection h (h M h^-1) is the same class. Named like the library's suffixes, e.g. rot90_rot180_rot270."""
    best=None
    for h in range(8):
        for x in M:
            cand=tuple(sorted(_comp(h,_comp(_comp(m,_inv[x]),_inv[h])) for m in M))
            if best is None or cand<best: best=cand
    return "_".join(TRANSFORM_NAMES[g] for g in best if g!=0)
only=set()
while '--only-class' in args:                 # keep only hits of these puzzle classes (skips deduping/verifying the rest)
    i=args.index('--only-class'); only.add(args[i+1]); del args[i:i+2]
hits=[]
for f in args[3:]: hits+=pickle.load(open(f,'rb'))
print(len(hits),'raw hits (board, transform-set)')
seen={}; 
if only: hits=[h for h in hits if class_name(h[1]) in only]; print(len(hits),'hits in classes',sorted(only))
for b,members in hits:
    T=[tb(b,maps[g]) for g in members]
    best=min(tuple(sorted(canonical_relabel(tb(t,maps[h])) for t in T)) for h in range(8))
    if best not in seen: seen[best]=(b,members)
print(len(seen),'distinct puzzles after canonical dedupe')
keys=list(seen); random.Random(1).shuffle(keys)
rows=[]; bad=0; swast=0
for key in keys:
    b,members=seen[key]
    boards=[canonical_relabel(tb(b,maps[g])) for g in members]
    if any(board_contains_swastika(x,n) for x in boards): swast+=1; continue
    grids=[[ALPHABET.index(c) for c in x] for x in boards]
    full=fast_solve.joint_solutions(grids,n,stars,cap=2)
    if full is None or len(full)!=1: bad+=1; continue
    if any(len(fast_solve.joint_solutions(grids[:i]+grids[i+1:],n,stars,cap=2) or [])<2 for i in range(K)): bad+=1; continue
    rows.append((boards,full[0],class_name(members)))
print('verified',len(rows),'failed',bad,'dropped for swastika-shaped boards',swast)
with open(out,'w',newline='') as f:
    w=csv.writer(f,lineterminator='\n'); w.writerow(['name','N']+[f'board_{i+1}' for i in range(K)]+['solution'])
    for i,(bs,sol,nm) in enumerate(rows): w.writerow([f'puzzle_{i+1}_{kind}{nm}',n]+bs+[sol])
