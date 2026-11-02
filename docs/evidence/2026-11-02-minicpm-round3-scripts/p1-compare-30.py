import json,os,re,subprocess,difflib
from collections import Counter
from statistics import mean,median
PAGES=[("23必刷题 1 直线运动",0),("23必刷题 1 直线运动",10),("23必刷题 4 曲线运动",8),
       ("物理_教材基础练机械能守恒定律",1),("物理_教材基础练机械能守恒定律",3),
       ("物理_教材基础练 电路",4),("教材基础练 磁场",0),("答案册-合订本",1),
       ("23必刷题 1 直线运动",2),("23必刷题 1 直线运动",12),
       ("23必刷题 4 曲线运动",4),("23必刷题 4 曲线运动",9),("23必刷题 4 曲线运动",12),
       ("物理_教材基础练机械能守恒定律",0),("物理_教材基础练机械能守恒定律",4),("物理_教材基础练机械能守恒定律",7),
       ("物理_教材基础练 电路",0),("物理_教材基础练 电路",1),
       ("教材基础练 磁场",2),("教材基础练 磁场",5),
       ("答案册-合订本",47),("答案册-合订本",170),
       ("23必刷题 1 直线运动",1),("23必刷题 1 直线运动",3),
       ("23必刷题 4 曲线运动",10),("23必刷题 4 曲线运动",13),
       ("物理_教材基础练机械能守恒定律",2),("物理_教材基础练 电路",11),
       ("教材基础练 磁场",7),("答案册-合订本",2)]
def img_path(book,page):
    for w in (2,3):
        p=f"data/out/{book}/pages/page-{page+1:0{w}d}.png"
        if os.path.exists(p): return p
    return None
def load(book,page):
    for d in ("tmp/minicpm-round3/p1-parses","tmp/minicpm-p0p1/p1-parses"):
        p=f"{d}/{book}-p{page}.json"
        if os.path.exists(p): return json.load(open(p))
    if book=="物理_教材基础练 电路" and page==4:
        return json.load(open("data/archive/2026-11-02/minicpm-probe/parse-page05.json"))
    raise FileNotFoundError((book,page))
def raw(book,page): return json.load(open(f"data/out/{book}/layout.json"))["pdf_info"][page]
def norm(s):
    s=s or ""; s=re.sub(r'\\[a-zA-Z]+\*?','',s); s=re.sub(r'[\s$\\{}^_]+','',s); s=re.sub(r'[，。；：、（）()\[\]【】“”"\'.,;:!?·—\-]','',s); return s
def ng(s,n=4): return {s[i:i+n] for i in range(max(0,len(s)-n+1))}
def nums(content):
    out=[]
    for line in content.splitlines():
        s=re.sub(r'^#+\s*','',line.strip()); s=re.sub(r'^\*+\s*','',s)
        m=re.match(r'^(\d{1,3})(?:\s*[.．、\[\(（]|\s+(?=\S)|$)',s)
        if m: out.append(m.group(1))
    return out
def tess(book,page):
    fp=f"tmp/minicpm-round3/page-ocr/{book}-p{page}.txt"
    if os.path.exists(fp): return open(fp).read()
    for d in ("tmp/minicpm-p0p1/page-ocr",):
        old=f"{d}/{book}-p{page}.txt"
        if os.path.exists(old): return open(old).read()
    img=img_path(book,page)
    r=subprocess.run(["tesseract",img,"stdout","-l","chi_sim+eng","--psm","6"],capture_output=True,text=True,timeout=120)
    t=r.stdout; open(fp,"w").write(t); return t
def fnum(s):
    s=s or ""; s=re.sub(r'\\(left|right|mathrm|text|scriptscriptstyle|displaystyle)','',s); s=re.sub(r'[\s${}\\^_]+','',s); return s.lower()
def cells(html): return len(re.findall(r'<(td|th)\b',html,flags=re.I))
rows=[]
for book,page in PAGES:
    d=load(book,page); pg=d.get("pages",[d])[0]
    content=pg.get("choices",[{}])[0].get("message",{}).get("content",""); blocks=pg.get("ocr",{}).get("blocks",[])
    lay=raw(book,page); qs=[q for q in json.load(open(f"data/out/{book}/questions.json")) if q.get("source",{}).get("pageIndex")==page]
    exp=[str(q.get("number")) for q in qs if str(q.get("number","")).isdigit()]
    got=nums(content); E=set(exp); M=set(got); ocr=tess(book,page); T=set(nums(ocr))
    ec=Counter(exp); gc=Counter(got)
    cg=ng(norm(content)); rec=[]
    for q in qs:
        base=" ".join([q.get("stem","")]+[o.get("text","") for o in q.get("options",[])])
        bg=ng(norm(base))
        if bg: rec.append(len(bg&cg)/len(bg))
    fspan=[]
    for pb in lay.get("para_blocks",[]):
        for line in pb.get("lines",[]):
            for sp in line.get("spans",[]):
                if sp.get("type") in ("inline_equation","equation_inline") and str(sp.get("content","")).strip(): fspan.append(str(sp["content"]))
    mform=re.findall(r'(?<!\$)\$(?!\$)([^$]+)\$(?!\$)',content)
    fmatch=0; fr=[]
    for f in fspan:
        fn=fnum(f); best=0
        for g in mform: best=max(best,difflib.SequenceMatcher(None,fn,fnum(g)).ratio())
        fr.append(best); fmatch+=best>=0.7
    mtab=[b for b in blocks if b.get("label")=="table" and "<table" in (b.get("content") or "")]
    mcell=sum(cells(b["content"]) for b in mtab)
    ltab=[]; lcell=0
    for pb in lay.get("para_blocks",[]):
        if pb.get("type")!="table": continue
        for sub in pb.get("blocks",[]):
            for line in sub.get("lines",[]):
                for sp in line.get("spans",[]):
                    h=sp.get("html") or ""
                    if "<table" in h: ltab.append(h); lcell+=cells(h)
    charts=[b for b in blocks if b.get("label")=="chart"]
    ctab=sum(1 for b in charts if "<table" in (b.get("content") or ""))
    skipped=sum(1 for b in blocks if b.get("status")=="skipped_no_vlm")
    rows.append({"book":book,"page":page,"unique_expected":len(E),"unique_matched":len(E&M),"unique_extra":len(M-E),
                 "occ_expected":sum(ec.values()),"occ_matched":sum(min(ec[n],gc[n]) for n in ec),
                 "mini_missing":sorted(E-M,key=int),"tess_only":sorted((E&T)-M,key=int),"mini_only":sorted((E&M)-T,key=int),
                 "tess_coverage":f"{len(E&T)}/{len(E)}" if E else "n/a",
                 "recall_mean":round(mean(rec),3) if rec else None,"recall_median":round(median(rec),3) if rec else None,"recall_min":round(min(rec),3) if rec else None,
                 "formula_expected":len(fspan),"formula_mini":len(mform),"formula_match":fmatch,
                 "table_mini":len(mtab),"table_mineru":len(ltab),"cell_mini":mcell,"cell_mineru":lcell,
                 "chart":len(charts),"chart_table":ctab,"skipped":skipped,"chars":len(content),"elapsed":round(d.get("_elapsed",0),2)})
    print(f"{book} p{page}: cov {len(E&M)}/{len(E)} extra {len(M-E)} occ {rows[-1]['occ_matched']}/{rows[-1]['occ_expected']} | rec {rows[-1]['recall_mean']} | f {fmatch}/{len(fspan)} | tab {len(mtab)}/{len(ltab)} cells {mcell}/{lcell} | chart {len(charts)}->{ctab} | tess {len(E&T)}/{len(E)} tess-only {sorted((E&T)-M,key=int)} | {d.get('_elapsed',0):.1f}s")
json.dump(rows,open("tmp/minicpm-round3/p1-30.json","w"),ensure_ascii=False,indent=2)
agg={"pages":len(rows),"unique_expected":sum(r["unique_expected"] for r in rows),"unique_matched":sum(r["unique_matched"] for r in rows),
     "unique_extra":sum(r["unique_extra"] for r in rows),"occ_expected":sum(r["occ_expected"] for r in rows),"occ_matched":sum(r["occ_matched"] for r in rows),
     "pages_missing":sum(bool(r["mini_missing"]) for r in rows),"pages_tess_only":sum(bool(r["tess_only"]) for r in rows),
     "recall_mean":round(mean([r["recall_mean"] for r in rows if r["recall_mean"] is not None]),3),
     "recall_median":round(median([r["recall_mean"] for r in rows if r["recall_mean"] is not None]),3),
     "recall_min":min(r["recall_min"] for r in rows if r["recall_min"] is not None),
     "table_pages":sum(r["table_mini"]>0 for r in rows),"cell_mini":sum(r["cell_mini"] for r in rows),"cell_mineru":sum(r["cell_mineru"] for r in rows),
     "chart":sum(r["chart"] for r in rows),"chart_table":sum(r["chart_table"] for r in rows),
     "formula_expected":sum(r["formula_expected"] for r in rows),"formula_match":sum(r["formula_match"] for r in rows),
     "elapsed_min":min(r["elapsed"] for r in rows if r["elapsed"]),"elapsed_max":max(r["elapsed"] for r in rows)}
json.dump(agg,open("tmp/minicpm-round3/p1-30-summary.json","w"),ensure_ascii=False,indent=2)
print("\nAGG",json.dumps(agg,ensure_ascii=False,indent=2))
