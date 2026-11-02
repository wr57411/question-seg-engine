import json, os, re
from statistics import mean, median

PAGES=[("23必刷题 1 直线运动",0),("23必刷题 1 直线运动",10),("23必刷题 4 曲线运动",8),
       ("物理_教材基础练机械能守恒定律",1),("物理_教材基础练机械能守恒定律",3),
       ("物理_教材基础练 电路",4),("教材基础练 磁场",0),("答案册-合订本",1)]

def norm(s):
    s=s or ""
    s=re.sub(r'\\[a-zA-Z]+\*?','',s)
    s=re.sub(r'[\s$\\{}^_]+','',s)
    s=re.sub(r'[，。；：、（）()\[\]【】“”"\'.,;:!?·—\-]','',s)
    return s

def ngrams(s,n=4):
    return {s[i:i+n] for i in range(max(0,len(s)-n+1))}

def load_parse(book,page):
    p=f"tmp/minicpm-p0p1/p1-parses/{book}-p{page}.json"
    if os.path.exists(p): return json.load(open(p))
    return json.load(open("data/archive/2026-11-02/minicpm-probe/parse-page05.json"))

rows=[]; allrec=[]
for book,page in PAGES:
    d=load_parse(book,page); pg=d.get("pages",[d])[0]
    content=pg["choices"][0]["message"]["content"]
    blocks=pg.get("ocr",{}).get("blocks",[])
    cn=norm(content); cg=ngrams(cn)
    qs=[q for q in json.load(open(f"data/out/{book}/questions.json")) if q.get("source",{}).get("pageIndex")==page]
    recs=[]
    for q in qs:
        base=" ".join([q.get("stem","")]+[o.get("text","") for o in q.get("options",[])])
        bn=norm(base); bg=ngrams(bn)
        if not bg: continue
        rec=len(bg & cg)/len(bg)
        recs.append((q.get("number"),rec,len(bn)))
        allrec.append(rec)
    # table/chart blocks
    tbl=[b for b in blocks if b.get("label")=="table"]
    chart=[b for b in blocks if b.get("label")=="chart"]
    chart_tbl=[b for b in chart if "<table" in (b.get("content") or "")]
    vals=[r for _,r,_ in recs]
    rows.append({"book":book,"page":page,"questions":len(recs),"recall_mean":round(mean(vals),3) if vals else None,
                 "recall_median":round(median(vals),3) if vals else None,"recall_min":round(min(vals),3) if vals else None,
                 "below_0.5":sum(r<0.5 for r in vals),"table_blocks":len(tbl),"chart_blocks":len(chart),"chart_as_table":len(chart_tbl),
                 "per_question":[{"number":n,"recall":round(r,3),"baseline_chars":l} for n,r,l in recs]})
    print(f"{book} p{page}: q={len(recs)} recall mean={mean(vals):.2f} med={median(vals):.2f} min={min(vals):.2f} <0.5={sum(r<0.5 for r in vals)} | table={len(tbl)} chart={len(chart)} chart_as_table={len(chart_tbl)}")

json.dump(rows,open("tmp/minicpm-p0p1/p1-fidelity.json","w"),ensure_ascii=False,indent=2)
print("\nall questions",len(allrec),"mean recall",round(mean(allrec),3),"median",round(median(allrec),3),"below0.5",sum(r<0.5 for r in allrec))
