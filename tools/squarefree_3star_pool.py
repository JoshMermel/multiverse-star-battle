"""squarefree_3star_pool.py seconds workers out.pkl [seed_off] [max_steps=300] [grow_target=0]
13x13 3-star square-free board pool via repair-descent against the enumerated placement table.
Each worker: take a structural square-free board (SquareFreeDeboxGenerator), then random single-cell moves (keeping regions
contiguous, >=5 cells, 2x2-free) accepted when min-over-placements deviation does not increase, until some placement satisfies
every region quota.  Solution set = placements with zero deviation (exact, no CP-SAT).
Output pickle: {'boards': {board_str: np.array of placement idx}, 'stats': {...}}"""
import sys, os, time, random, pickle
import numpy as np
CWD=os.getcwd(); HERE=os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0,os.path.dirname(os.path.abspath(__file__)))
from concurrent.futures import ProcessPoolExecutor
from board_utils import get_neighbors_4, ALPHABET
from filter import board_contains_swastika
from square_free_debox_generator import SquareFreeDeboxGenerator
N=13; K=3; MINSIZE=2*K-1
NB4=[get_neighbors_4(i,N) for i in range(N*N)]

class G(SquareFreeDeboxGenerator):
    def _make_result(self,grid,*a,**k): return list(grid)

def evaluate(P,grid):
    R=np.zeros((N*N,N),dtype=np.float32); R[np.arange(N*N),grid]=1
    dev=np.abs(P@R-K).sum(1)
    return dev

def block_violation(grid,cell,dest):
    r,c=divmod(cell,N)
    for dr in (-1,0):
        for dc in (-1,0):
            r0,c0=r+dr,c+dc
            if not(0<=r0<N-1 and 0<=c0<N-1): continue
            b=(r0*N+c0,r0*N+c0+1,(r0+1)*N+c0,(r0+1)*N+c0+1)
            if all((dest if x==cell else grid[x])==dest for x in b): return True
    return False

def contiguous_without(grid,src,cell):
    cells=[i for i in range(N*N) if grid[i]==src and i!=cell]
    if len(cells)<=1: return True
    seen={cells[0]}; st=[cells[0]]; cs=set(cells)
    while st:
        u=st.pop()
        for v in NB4[u]:
            if v in cs and v not in seen: seen.add(v); st.append(v)
    return len(seen)==len(cs)

def random_move(grid,sizes):
    cells=list(range(N*N)); random.shuffle(cells)
    for cell in cells:
        src=grid[cell]
        if sizes[src]<=MINSIZE: continue
        dests=list({grid[nb] for nb in NB4[cell] if grid[nb]!=src}); random.shuffle(dests)
        for d in dests:
            if block_violation(grid,cell,d): continue
            if not contiguous_without(grid,src,cell): continue
            return cell,d
    return None

def directed_move(P,grid,sizes,dev):
    """move a star cell of a best-so-far placement out of an over-full region into an under-full neighbour region"""
    best=np.flatnonzero(dev==dev.min()); pl=P[random.choice(best)]
    stars=np.flatnonzero(pl); cnt=[0]*N
    for c in stars: cnt[grid[c]]+=1
    cands=[]
    for c in stars:
        src=grid[c]
        if cnt[src]<=K or sizes[src]<=MINSIZE: continue
        for nb in NB4[c]:
            d=grid[nb]
            if d!=src and cnt[d]<K: cands.append((c,d))
    random.shuffle(cands)
    for cell,d in cands:
        if block_violation(grid,cell,d): continue
        if not contiguous_without(grid,grid[cell],cell): continue
        return cell,d
    return None

def repair(P,grid,max_steps):
    grid=list(grid); sizes=[0]*N
    for v in grid: sizes[v]+=1
    dev=evaluate(P,grid); cost=dev.min()
    for step in range(max_steps):
        if cost==0: return grid,step
        mv=directed_move(P,grid,sizes,dev) if random.random()<0.7 else None
        if mv is None: mv=random_move(grid,sizes)
        if mv is None: return None
        cell,d=mv; src=grid[cell]; grid[cell]=d; sizes[src]-=1; sizes[d]+=1
        dev2=evaluate(P,grid); c2=dev2.min()
        if c2<=cost: cost=c2; dev=dev2
        else: grid[cell]=src; sizes[src]+=1; sizes[d]-=1
    return None

def grow(P,grid,target,max_steps):
    """After repair: keep making random moves that leave the board solvable and do not lose solutions, until it has
    >= target solutions (or steps run out).  More solutions per board -> far more pair overlaps (hits ~ s_A * s_B)."""
    grid=list(grid); sizes=[0]*N
    for v in grid: sizes[v]+=1
    cur=int((evaluate(P,grid)==0).sum())
    for _ in range(max_steps):
        if cur>=target: break
        mv=random_move(grid,sizes)
        if mv is None: break
        cell,d=mv; src=grid[cell]; grid[cell]=d; sizes[src]-=1; sizes[d]+=1
        s2=int((evaluate(P,grid)==0).sum())
        if s2>=cur: cur=s2
        else: grid[cell]=src; sizes[src]+=1; sizes[d]-=1
    return grid

def worker(job):
    secs,seed,max_steps,target=job
    random.seed(seed); P=np.load(os.path.join(HERE,'library','playground','placements13_3.npy')).astype(np.float32)
    g=G(N,stars_per_unit=K); st=dict(starts=0,viable=0,failed=0,swast=0,steps=0)
    boards={}; t0=time.time()
    while time.time()-t0<secs:
        grid=None
        while grid is None: grid=g._try_generate()
        st['starts']+=1
        r=repair(P,grid,max_steps)
        if r is None: st['failed']+=1; continue
        grid,steps=r; st['viable']+=1; st['steps']+=steps
        if target: grid=grow(P,grid,target,max_steps)
        bs="".join(ALPHABET[v] for v in grid)
        if board_contains_swastika(bs,N): st['swast']+=1; continue
        boards[bs]=np.nonzero(evaluate(P,grid)==0)[0].astype(np.int32)
    return st,boards

if __name__=='__main__':
    secs=float(sys.argv[1]); W=int(sys.argv[2]); out=sys.argv[3]; off=int(sys.argv[4]) if len(sys.argv)>4 else 0
    max_steps=int(sys.argv[5]) if len(sys.argv)>5 else 300
    target=int(sys.argv[6]) if len(sys.argv)>6 else 0
    with ProcessPoolExecutor(W) as ex: res=list(ex.map(worker,[(secs,7000+off+i,max_steps,target) for i in range(W)]))
    tot={}; boards={}
    for st,b in res:
        for k,v in st.items(): tot[k]=tot.get(k,0)+v
        boards.update(b)
    cnt=sorted(len(v) for v in boards.values())
    print(f'{secs}s x {W}: {tot}; distinct viable boards {len(boards)}; unique-solution {sum(1 for c in cnt if c==1)}')
    if cnt: print(f'  solution counts: min {cnt[0]} p25 {cnt[len(cnt)//4]} median {cnt[len(cnt)//2]} p75 {cnt[3*len(cnt)//4]} max {cnt[-1]}')
    pickle.dump(boards,open(os.path.join(CWD,out),'wb'))
