"""score_csv.py in.csv out.csv [workers=10] -- shard, score with gen_puzzles.py score --skip-dedup in parallel, merge"""
import sys, os, csv, subprocess, tempfile
csv.field_size_limit(10**9)
TOOLS=os.path.dirname(os.path.abspath(__file__))
inp,out=sys.argv[1],sys.argv[2]; W=int(sys.argv[3]) if len(sys.argv)>3 else 10
rows=list(csv.DictReader(open(inp))); hdr=list(rows[0].keys())
td=tempfile.mkdtemp(); procs=[]
for k in range(W):
    p=os.path.join(td,f's{k}.csv')
    with open(p,'w',newline='') as f:
        w=csv.DictWriter(f,fieldnames=hdr,lineterminator='\n'); w.writeheader(); w.writerows(rows[k::W])
    procs.append(subprocess.Popen([os.path.join(TOOLS,'venv/bin/python'),os.path.join(TOOLS,'gen_puzzles.py'),'score','--input',p,'--output',p+'.out','--skip-dedup'],cwd=TOOLS,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL))
for pr in procs: pr.wait()
res=[]
for k in range(W):
    res+=list(csv.DictReader(open(os.path.join(td,f's{k}.csv.out'))))
with open(out,'w',newline='') as f:
    w=csv.DictWriter(f,fieldnames=list(res[0].keys()),lineterminator='\n'); w.writeheader(); w.writerows(res)
import collections
c=collections.Counter(r['tier'] for r in res); n=len(res)
sc=sorted(int(float(r['score'])) for r in res if r['tier']!='UNSOLVED')
print(f"{os.path.basename(inp)}: {n} puzzles", {k:f"{100*v/n:.0f}%" for k,v in c.most_common()}, 'score p10/50/90:', [sc[int(len(sc)*q)] for q in (.1,.5,.9)] if sc else None)
