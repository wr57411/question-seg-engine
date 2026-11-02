import json
from collections import Counter
from statistics import mean,median
L=json.load(open("tmp/minicpm-round3/logical-results.json"))["results"]
R=json.load(open("tmp/minicpm-p0p1/real-results-fixed.json"))["results"]
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
def stats(rows):
    rs=[x for x in rows if len(x.get("scores") or [])==2 and all(v=="scored" for v in (x.get("verdicts") or []))]
    if not rs: return {"n":0}
    pos=[x["scores"][0] for x in rs]; neg=[x["scores"][1] for x in rs]
    out={"n":len(rs),"auc":round(auc(pos,neg),4),"correct_mean":round(mean(pos),4),"correct_median":round(med(pos),4),
         "wrong_mean":round(mean(neg),5),"best_at_correct":round(sum(1 for x in rs if x.get("best_index")==0)/len(rs),4)}
    out["thresholds"]={}
    for t in (0.005,0.01,0.02,0.05,0.1,0.2,0.5):
        cp=sum(p>=t for p in pos)/len(pos); wp=sum(p>=t for p in neg)/len(neg)
        out["thresholds"][str(t)]={"correct_pass":round(cp,4),"wrong_pass":round(wp,4),"false_review":round(1-cp,4)}
    return out
# normalize line-level rows
for x in R: x["tier"]="line"
summary={
 "logical":stats(L),
 "logical_by_type":{k:stats([x for x in L if x["error_type"]==k]) for k in sorted(set(x["error_type"] for x in L))},
 "logical_by_book":{b:stats([x for x in L if x["book"]==b]) for b in sorted(set(x["book"] for x in L))},
 "line_block":stats([x for x in R if x["kind"] in ("insert","replace")]),
 "line_all":stats(R),
 "logical_unique_blocks":len(set(x["block_id"] for x in L)),
 "logical_unique_books":len(set(x["book"] for x in L)),
 "line_n":len(R),
 "logical_failures":[{"id":x["id"],"book":x["book"],"page":x["page1"],"type":x["error_type"],"scores":x["scores"],"best":x["best_index"],"correct":x["correct"][:80],"wrong":x["wrong"][:80]} for x in L if x.get("best_index")!=0 or (x.get("scores") and x["scores"][0]<=x["scores"][1])],
}
json.dump(summary,open("tmp/minicpm-round3/p0-round3-summary.json","w"),ensure_ascii=False,indent=2)
print(json.dumps(summary,ensure_ascii=False,indent=2)[:7000])
