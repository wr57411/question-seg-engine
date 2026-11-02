import json
from collections import Counter
from statistics import mean,median
D=json.load(open("tmp/minicpm-p0p1/real-results-fixed.json"))["results"]
# tag replace_text evaluability (same-line prefix cases fixed)
EVAL={"物理_教材基础练 曲线运动:p8:replace_text0","物理_教材基础练 曲线运动:p16:replace_text1","答案册-合订本:p176:replace_text2","第二章相互作用-答案与解析:p18:replace_text21"}
for x in D:
    if x["kind"]=="replace_text": x["evaluable"]=x["id"] in EVAL
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
    rs=[x for x in rows if len(x.get("scores") or [])==2 and all(v=="scored" for v in x["verdicts"])]
    if not rs: return {"n":0}
    pos=[x["scores"][0] for x in rs]; neg=[x["scores"][1] for x in rs]
    out={"n":len(rs),"auc":round(auc(pos,neg),4),"correct_mean":round(mean(pos),4),"correct_median":round(med(pos),4),
         "wrong_mean":round(mean(neg),5),"wrong_median":round(med(neg),5),
         "best_at_correct":round(sum(1 for x in rs if x["best_index"]==0)/len(rs),4)}
    out["thresholds"]={}
    for t in (0.005,0.01,0.02,0.05,0.1,0.2,0.5):
        cp=sum(p>=t for p in pos)/len(pos); wp=sum(n>=t for n in neg)/len(neg)
        out["thresholds"][str(t)]={"correct_pass":round(cp,4),"wrong_pass":round(wp,4),"false_review":round(1-cp,4)}
    return out
block=[x for x in D if x["kind"] in ("insert","replace")]
summary={
 "total_scored":len(D),"policy_skipped":1,
 "block_level":stats(block),
 "insert":stats([x for x in D if x["kind"]=="insert"]),
 "replace":stats([x for x in D if x["kind"]=="replace"]),
 "replace_text_all":stats([x for x in D if x["kind"]=="replace_text"]),
 "replace_text_evaluable":stats([x for x in D if x["kind"]=="replace_text" and x.get("evaluable")]),
 "replace_text_not_evaluable":[x["id"] for x in D if x["kind"]=="replace_text" and not x.get("evaluable")],
 "by_book":{b:stats([x for x in D if x["book"]==b and x["kind"] in ("insert","replace")]) for b in sorted(set(x["book"] for x in D))},
 "failures_block":[{"id":x["id"],"kind":x["kind"],"book":x["book"],"page":x["page1"],"scores":x["scores"],"best":x["best_index"],"correct":x["correct"][:100],"wrong":x["wrong"][:100]} for x in D if x["kind"] in ("insert","replace") and (x["scores"][0]<=x["scores"][1] or x["best_index"]!=0)],
}
json.dump(summary,open("tmp/minicpm-p0p1/p0-real-summary.json","w"),ensure_ascii=False,indent=2)
print(json.dumps(summary,ensure_ascii=False,indent=2))
