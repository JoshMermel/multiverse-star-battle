"""venn2star_boards.py n seconds workers out.pkl [draws=60] [stars=2] [min_region=3]
Time-boxed generation of venn boards (structural -> solved), with stats.  Pair them with venn2star_pairs.py."""
import sys, time, random, pickle, os
CWD=os.getcwd(); TOOLS=os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0,TOOLS)
os.chdir(TOOLS)
from concurrent.futures import ProcessPoolExecutor
from venn_generator import VennGenerator
from board_solver import get_solutions_capped
from board_utils import ALPHABET
from filter import board_contains_swastika

CAP=4000
def worker(job):
    n,secs,seed,draws,stars,minreg=job
    random.seed(seed)
    g=VennGenerator(n,stars_per_unit=stars,min_region_size=minreg,max_draws=draws)
    st=dict(draws=0,struct=0,swast=0,toomany=0,zero=0)
    boards={}  # board -> list of solution strings
    t0=time.time()
    while time.time()-t0<secs:
        st['draws']+=1
        captured=[]
        g._make_result=lambda grid,*a,**k:captured.append(grid) or None
        g._try_generate()
        if not captured: continue
        grid=captured[0]; st['struct']+=1
        bs="".join(ALPHABET[v] for v in grid)
        if board_contains_swastika(bs,n): st['swast']+=1; continue
        sols=get_solutions_capped(grid,n,cap=CAP,stars_per_unit=stars,time_limit_seconds=20)
        if sols is None or len(sols)>=CAP: st['toomany']+=1; continue
        if len(sols)==0: st['zero']+=1; continue
        boards[bs]=sorted(sols)
    return st,boards

if __name__=='__main__':
    n=int(sys.argv[1]); secs=float(sys.argv[2]); W=int(sys.argv[3]); out=sys.argv[4]
    draws=int(sys.argv[5]) if len(sys.argv)>5 else 60
    stars=int(sys.argv[6]) if len(sys.argv)>6 else 2
    minreg=int(sys.argv[7]) if len(sys.argv)>7 else 3
    with ProcessPoolExecutor(W) as ex:
        res=list(ex.map(worker,[(n,secs,100*n+i,draws,stars,minreg) for i in range(W)]))
    tot={}; boards={}
    for st,b in res:
        for k,v in st.items(): tot[k]=tot.get(k,0)+v
        boards.update(b)
    cnts=sorted(len(v) for v in boards.values())
    import statistics
    print(f'n={n} stars={stars} draws={draws} minreg={minreg}: {tot}')
    print(f'  distinct solvable boards: {len(boards)}  unique-solution: {sum(1 for c in cnts if c==1)}')
    if cnts: print(f'  solution counts: min {cnts[0]} p25 {cnts[len(cnts)//4]} median {statistics.median(cnts)} p75 {cnts[3*len(cnts)//4]} max {cnts[-1]}')
    pickle.dump(boards,open(os.path.join(CWD,out),'wb'))
