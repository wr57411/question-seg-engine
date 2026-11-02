import json,os,re,difflib
from collections import Counter
PAGES=json.load(open("tmp/minicpm-round3/p1-30.json"))
def load(book,page):
    for d in ("tmp/minicpm-round3/p1-parses","tmp/minicpm-p0p1/p1-parses"):
        p=f"{d}/{book}-p{page}.json"
        if os.path.exists(p): return json.load(open(p))
    if book=="物理_教材基础练 电路" and page==4:
        return json.load(open("data/archive/2026-11-02/minicpm-probe/parse-page05.json"))
    raise FileNotFoundError((book,page))
def raw(book,page): return json.load(open(f"data/out/{book}/layout.json"))["pdf_info"][page]
def strip_html(h):
    h=re.sub(r'<eq>(.*?)</eq>',lambda m:'$'+m.group(1).strip()+'$',h,flags=re.S)
    h=re.sub(r'<br\s*/?>',' ',h,flags=re.I)
    h=re.sub(r'<[^>]+>',' ',h)
    h=re.sub(r'&nbsp;',' ',h); h=re.sub(r'&amp;','&',h); h=re.sub(r'&lt;','<',h); h=re.sub(r'&gt;','>',h)
    return re.sub(r'\s+',' ',h).strip()
def cells(html):
    out=[]
    for m in re.finditer(r'<(td|th)\b[^>]*>(.*?)</\1>',html,flags=re.I|re.S):
        t=strip_html(m.group(2))
        if t: out.append(t)
    return out
def fnum(s):
    s=s or ""; s=re.sub(r'\\(left|right|mathrm|text|scriptscriptstyle|displaystyle)','',s); s=re.sub(r'[\s${}\\^_]+','',s); return s.lower()
tables=[]; formulas=[]
for r in PAGES:
    book,page=r["book"],r["page"]; d=load(book,page); pg=d.get("pages",[d])[0]
    blocks=pg.get("ocr",{}).get("blocks",[]); content=pg.get("choices",[{}])[0].get("message",{}).get("content","")
    lay=raw(book,page)
    mt=[b for b in blocks if b.get("label")=="table" and "<table" in (b.get("content") or "")]
    lt=[]
    for pb in lay.get("para_blocks",[]):
        if pb.get("type")!="table": continue
        for sub in pb.get("blocks",[]):
            for line in sub.get("lines",[]):
                for sp in line.get("spans",[]):
                    h=sp.get("html") or ""
                    if "<table" in h: lt.append(h)
    for i,m in enumerate(mt):
        mc=cells(m["content"]); lc=cells(lt[i]) if i<len(lt) else []
        exact=0
        if mc and lc and len(mc)==len(lc):
            exact=sum(1 for a,b in zip(mc,lc) if re.sub(r'\s+','',a)==re.sub(r'\s+','',b))
        tables.append({"book":book,"page":page,"index":i,"mini_cells":len(mc),"mineru_cells":len(lc),
                       "ref_available":bool(lc),"exact_matches":exact,
                       "exact_rate":round(exact/len(mc),3) if mc else None,
                       "mini_first":mc[:3],"mineru_first":lc[:3]})
    fspan=[]
    for pb in lay.get("para_blocks",[]):
        for line in pb.get("lines",[]):
            for sp in line.get("spans",[]):
                if sp.get("type") in ("inline_equation","equation_inline") and str(sp.get("content","")).strip(): fspan.append(str(sp["content"]))
    mform=re.findall(r'(?<!\$)\$(?!\$)([^$]+)\$(?!\$)',content)
    used=set()
    for f in fspan:
        best=(0,None,None)
        for j,g in enumerate(mform):
            if j in used: continue
            ratio=difflib.SequenceMatcher(None,fnum(f),fnum(g)).ratio()
            if ratio>best[0]: best=(ratio,j,g)
        if best[1] is not None:
            used.add(best[1])
            formulas.append({"book":book,"page":page,"mineru":f,"minicpm":best[2],"fuzzy":round(best[0],3),
                             "exact":fnum(f)==fnum(best[2])})
json.dump({"tables":tables,"formulas":formulas},open("tmp/minicpm-round3/p1-gold.json","w"),ensure_ascii=False,indent=2)
print("tables",len(tables),"with_ref",sum(t["ref_available"] for t in tables),"exact_cells",sum(t["exact_matches"] for t in tables),"total_cells",sum(t["mini_cells"] for t in tables))
for t in tables: print(" TABLE",t["book"],t["page"],"mini",t["mini_cells"],"ref",t["mineru_cells"],"exact",t["exact_matches"],t["exact_rate"])
# sample 50 formulas stratified: take every nth
n=len(formulas); step=max(1,n//50); sample=formulas[::step][:50]
ex=sum(f["exact"] for f in sample); f9=sum(f["fuzzy"]>=0.9 for f in sample); f8=sum(f["fuzzy"]>=0.8 for f in sample); f7=sum(f["fuzzy"]>=0.7 for f in sample)
print("formulas total",n,"sample",len(sample),"exact",ex,"fuzzy>=.9",f9,">=.8",f8,">=.7",f7)
json.dump({"tables":tables,"formulas":formulas,"sample":sample,"sample_exact":ex,"sample_f9":f9,"sample_f8":f8,"sample_f7":f7},open("tmp/minicpm-round3/p1-gold-summary.json","w"),ensure_ascii=False,indent=2)
