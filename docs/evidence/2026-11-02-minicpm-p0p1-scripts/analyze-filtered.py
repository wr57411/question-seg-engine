import json, math
from collections import Counter
xs=json.load(open("tmp/minicpm-p0p1/jev-results-aligned.json"))

def keep(x):
    if x["category"]=="text": return (x.get("ocrSim") or 0)>=0.25
    if x["category"]=="table": return x["book"]!="教材基础练 磁场"
    return True
f=[x for x in xs if keep(x)]
print("filtered",len(f),Counter(x["category"] for x in f))
print("books",Counter(x["book"] for x in f))

def med(a):
    a=sorted(a); n=len(a)
    return None if not n else (a[n//2] if n%2 else (a[n//2-1]+a[n//2])/2)
def auc(pos,neg):
    if not pos or not neg: return None
    w=t=0
    for p in pos:
        for n in neg:
            if p>n: w+=1
            elif p==n: t+=1
    return (w+0.5*t)/(len(pos)*len(neg))
def summarize(rows,label):
    rs=[x for x in rows if len(x.get("scores") or [])==2 and all(v=="scored" for v in x["verdicts"])]
    if not rs: print(label,"n=0"); return
    pos=[x["scores"][0] for x in rs]; neg=[x["scores"][1] for x in rs]
    best=sum(1 for x in rs if x["best_index"]==0)
    print(f"{label:26s} n={len(rs):3d} corr_mean={sum(pos)/len(pos):.3f} corr_med={med(pos):.3f} wrong_mean={sum(neg)/len(neg):.4f} auc={auc(pos,neg):.3f} best@corr={best/len(rs):.1%}")
    for t in (0.005,0.01,0.02,0.05,0.1,0.2,0.3,0.5):
        cp=sum(p>=t for p in pos)/len(pos); wp=sum(p>=t for p in neg)/len(neg)
        print(f"   t={t:.3f} correct_pass={cp:.1%} wrong_pass={wp:.1%} wrong_caught={1-wp:.1%} false_review={1-cp:.1%}")

def kind(x): return "long" if x["category"]=="text" and "lines " in (x.get("source") or "") else ("short" if x["category"]=="text" else x["category"])
for k in ("short","long","formula","table"):
    summarize([x for x in f if kind(x)==k],k)
print("\nby book:")
for b in sorted(set(x["book"] for x in f)):
    summarize([x for x in f if x["book"]==b],b[:22])
print("\nfailures (correct<=wrong or best!=0):")
bad=[x for x in f if len(x.get("scores") or [])==2 and all(v=="scored" for v in x["verdicts"]) and (x["scores"][0]<=x["scores"][1] or x["best_index"]!=0)]
print(len(bad))
for x in bad:
    print(kind(x),x["book"],x["id"],"sc",round(x["scores"][0],4),"sw",round(x["scores"][1],4),"best",x["best_index"],"|",x["correct"][:70].replace("\n"," / "))
# save ids kept
json.dump({"kept":[x["id"] for x in f],"n":len(f)},open("tmp/minicpm-p0p1/kept-ids.json","w"),ensure_ascii=False,indent=2)
