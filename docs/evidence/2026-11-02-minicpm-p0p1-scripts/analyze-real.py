import json
from collections import Counter
from statistics import mean,median
D=json.load(open("tmp/minicpm-p0p1/real-results.json"))["results"]
def med(a):
    a=sorted(a); n=len(a); return None if not n else (a[n//2] if n%2 else (a[n//2-1]+a[n//2])/2)
def auc(pos,neg):
    if not pos or not neg: return None
    w=t=0
    for p in pos:
        for n in neg:
            if p>n: w+=1
            elif p==n: t+=1
    return (w+0.5*t)/(len(pos)*len(neg))
def summ(rows,label):
    rs=[x for x in rows if len(x.get("scores") or [])==2 and all(v=="scored" for v in x.get("verdicts") or [])]
    if not rs: print(label,"n=0"); return
    pos=[x["scores"][0] for x in rs]; neg=[x["scores"][1] for x in rs]
    best=sum(1 for x in rs if x.get("best_index")==0)
    print(f"{label:26s} n={len(rs):3d} corr_mean={mean(pos):.3f} corr_med={med(pos):.3f} wrong_mean={mean(neg):.4f} wrong_med={med(neg):.4f} auc={auc(pos,neg):.3f} best={best/len(rs):.1%}")
    for t in (0.005,0.01,0.02,0.05,0.1,0.2,0.5):
        cp=sum(p>=t for p in pos)/len(pos); wp=sum(p>=t for p in neg)/len(neg)
        print(f"   t={t:.3f} pass={cp:.1%} wrong_pass={wp:.1%} false_review={1-cp:.1%}")
print("total",len(D),"verdicts",Counter(tuple(x.get("verdicts") or []) for x in D))
for k in ("insert","replace","replace_text"):
    summ([x for x in D if x["kind"]==k],k)
print("\nverified:")
for v in (True,False): summ([x for x in D if x["verified"]==v],f"verified={v}")
print("\nlength buckets:")
for name,lo,hi in [("short<=40",0,40),("mid41-120",41,120),("long>120",121,99999)]:
    summ([x for x in D if lo<=len(x["correct"])<=hi],name)
print("\nby book:")
for b in sorted(set(x["book"] for x in D)): summ([x for x in D if x["book"]==b],b[:22])
print("\nfailures:")
bad=[x for x in D if len(x.get("scores") or [])==2 and all(v=="scored" for v in x.get("verdicts") or []) and (x["scores"][0]<=x["scores"][1] or x.get("best_index")!=0)]
print("count",len(bad))
for x in bad[:40]: print(x["kind"],x["book"],x["page1"],"sc",round(x["scores"][0],4),"sw",round(x["scores"][1],4),"best",x["best_index"],"|",x["correct"][:60].replace("\n"," / "),"->",x["wrong"][:40].replace("\n"," / "))
