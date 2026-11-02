import json
from collections import Counter
from statistics import mean, median

allr=json.load(open("tmp/minicpm-p0p1/jev-results-aligned.json"))
def keep(x):
    if x["category"]=="text": return (x.get("ocrSim") or 0)>=0.25
    if x["category"]=="table": return x["book"]!="教材基础练 磁场"
    return True
kept=[x for x in allr if keep(x)]
def kind(x): return "long" if x["category"]=="text" and "lines " in (x.get("source") or "") else ("short" if x["category"]=="text" else x["category"])
def auc(pos,neg):
    if not pos or not neg: return None
    w=t=0
    for p in pos:
        for n in neg:
            if p>n: w+=1
            elif p==n: t+=1
    return round((w+0.5*t)/(len(pos)*len(neg)),4)
def med(a):
    a=sorted(a); n=len(a)
    return None if not n else round(a[n//2] if n%2 else (a[n//2-1]+a[n//2])/2,4)
def stats(rows):
    rs=[x for x in rows if len(x.get("scores") or [])==2 and all(v=="scored" for v in x["verdicts"])]
    if not rs: return {"n":0}
    pos=[x["scores"][0] for x in rs]; neg=[x["scores"][1] for x in rs]
    out={"n":len(rs),"auc":auc(pos,neg),"correct_mean":round(mean(pos),4),"correct_median":med(pos),
         "wrong_mean":round(mean(neg),5),"wrong_median":med(neg),
         "best_at_correct":round(sum(1 for x in rs if x["best_index"]==0)/len(rs),4)}
    out["thresholds"]={}
    for t in (0.005,0.01,0.02,0.05,0.1,0.2,0.3,0.5):
        cp=sum(p>=t for p in pos)/len(pos); wp=sum(p>=t for p in neg)/len(neg)
        out["thresholds"][str(t)]={"correct_pass":round(cp,4),"wrong_pass":round(wp,4),"wrong_caught":round(1-wp,4),"false_review":round(1-cp,4)}
    return out

summary={
 "generatedAt":__import__("datetime").datetime.now().isoformat(timespec="seconds"),
 "candidates":len(allr),
 "kept":len(kept),
 "dropped":len(allr)-len(kept),
 "drop_rule":"text: tesseract chi_sim OCR 与候选文本 SequenceMatcher>=0.25；table: 排除《教材基础练 磁场》；formula 全部保留",
 "alignment_by_book":{},
 "categories":{k:stats([x for x in kept if kind(x)==k]) for k in ("short","long","formula","table")},
 "by_book":{b:stats([x for x in kept if x["book"]==b]) for b in sorted(set(x["book"] for x in kept))},
 "mutation_counts":dict(Counter(x.get("mut") for x in kept)),
 "verdict_counts":{str(k):v for k,v in Counter(tuple(x.get("verdicts") or []) for x in allr).items()},
 "precheck_rejects":[{"id":x["id"],"category":x["category"],"verdicts":x["verdicts"],"cropPath":x["cropPath"]} for x in allr if any(v!="scored" for v in (x.get("verdicts") or []))],
 "unfiltered":{k:stats([x for x in allr if kind(x)==k]) for k in ("short","long","formula","table")},
}
for b in sorted(set(x["book"] for x in allr if x["category"]=="text")):
    n=sum(1 for x in allr if x["category"]=="text" and x["book"]==b)
    k=sum(1 for x in kept if x["category"]=="text" and x["book"]==b)
    summary["alignment_by_book"][b]={"text_candidates":n,"kept":k,"keep_rate":round(k/n,3)}
json.dump(summary,open("tmp/minicpm-p0p1/p0-summary.json","w"),ensure_ascii=False,indent=2)
print(json.dumps(summary,ensure_ascii=False,indent=2)[:6000])
