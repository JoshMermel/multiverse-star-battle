import random, itertools, sys, time
def estimate(n,k,samples,seed=1):
    random.seed(seed)
    rows=[c for c in itertools.combinations(range(n),k) if all(b-a>1 for a,b in zip(c,c[1:]))]
    compat={}  # prev row cols -> allowed rows
    def ok(p,q): return all(abs(a-b)>1 for a in p for b in q)
    tot=0.0; t0=time.time()
    for _ in range(samples):
        cnt=[0]*n; prev=None; w=1.0
        for r in range(n):
            opts=[c for c in rows if all(cnt[x]<k for x in c) and (prev is None or ok(prev,c))]
            if not opts: w=0; break
            w*=len(opts); c=random.choice(opts)
            for x in c: cnt[x]+=1
            prev=c
        if w and any(x!=k for x in cnt): w=0
        tot+=w
    return tot/samples
if __name__=='__main__':
    n=int(sys.argv[1]); k=int(sys.argv[2]); S=int(sys.argv[3])
    print(n,k,f'{estimate(n,k,S):.3e}')
