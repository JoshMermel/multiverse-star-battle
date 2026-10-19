"""Enumerate all n x n k-star placements (k per row/col, no touching incl. diagonal) by row-wise DFS. Saves uint8 [N, n*n]."""
import sys, time, itertools, numpy as np
n=int(sys.argv[1]); k=int(sys.argv[2]); out=sys.argv[3]
rows=[c for c in itertools.combinations(range(n),k) if all(b-a>1 for a,b in zip(c,c[1:]))]
def touch(p,q): return any(abs(a-b)<=1 for a in p for b in q)
compat=[[j for j,q in enumerate(rows) if not touch(p,q)] for p in rows]
sols=[]; cnt=[0]*n
sys.setrecursionlimit(10000)
cur=[]
def dfs(r,prev):
    if r==n:
        if all(c==k for c in cnt): sols.append(tuple(cur))
        return
    left=n-r
    cands = range(len(rows)) if prev is None else compat[prev]
    for j in cands:
        p=rows[j]
        if any(cnt[c]>=k for c in p): continue
        for c in p: cnt[c]+=1
        # prune: every column needs (k - cnt) more stars from the remaining rows-1 rows (max 1 per row per column)
        ok=all(k-cnt[c] <= left-1 for c in range(n))
        if ok:
            cur.append(j); dfs(r+1,j); cur.pop()
        for c in p: cnt[c]-=1
t0=time.time(); dfs(0,None)
P=np.zeros((len(sols),n*n),dtype=np.uint8)
for i,s in enumerate(sols):
    for r,j in enumerate(s):
        for c in rows[j]: P[i,r*n+c]=1
np.save(out,P); print(P.shape, f'{time.time()-t0:.0f}s')
