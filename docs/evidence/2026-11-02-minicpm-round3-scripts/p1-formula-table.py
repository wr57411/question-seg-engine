import json,re,difflib
from collections import Counter
WORD=json.load(open("tmp/minicpm-round3/word-omml.json"))["formulas"]
def load(book,page):
    for d in ("tmp/minicpm-round3/p1-parses","tmp/minicpm-p0p1/p1-parses"):
        p=f"{d}/{book}-p{page}.json"
        if __import__("os").path.exists(p): return json.load(open(p))
    return json.load(open("data/archive/2026-11-02/minicpm-probe/parse-page05.json"))
def table_html(book,page):
    d=load(book,page); pg=d.get("pages",[d])[0]
    return next((b["content"] for b in pg["ocr"]["blocks"] if b.get("label")=="table" and "<table" in (b.get("content") or "")),"")
def mini_formulas(html):
    out=[]
    for m in re.finditer(r'<(td|th)\b[^>]*>(.*?)</\1>',html,flags=re.I|re.S):
        cell=re.sub(r'<[^>]+>',' ',m.group(2))
        for f in re.findall(r'\$([^$]+)\$',cell):
            if f.strip(): out.append(f.strip())
    return out
def fnum(s):
    s=re.sub(r'\\(left|right|mathrm|text|scriptscriptstyle|displaystyle)','',s or '')
    s=re.sub(r'[\s${}\\^_]+','',s); return s.lower()
def covered(a,b):
    a=fnum(a); b=fnum(b)
    if not a or not b: return False
    if a in b or b in a: return True
    A=set(a); B=set(b); return len(A&B)/len(A|B)>=0.8 if A|B else False
targets=[(111,"物理_教材基础练机械能守恒定律",1),(112,"物理_教材基础练机械能守恒定律",3),(138,"物理_教材基础练 电路",4),(145,"教材基础练 磁场",0)]
rows=[]
for ti,book,page in targets:
    wf=[x for x in WORD if x.get("table")==ti and len(fnum(x["latex"]))>=2]
    mf=mini_formulas(table_html(book,page))
    # dedupe word fragments
    seen=set(); wf2=[]
    for x in wf:
        k=fnum(x["latex"])
        if k and k not in seen: seen.add(k); wf2.append(x)
    wf=wf2
    pairs=[]
    for w in wf:
        best=(0,None)
        for m in mf:
            r=difflib.SequenceMatcher(None,fnum(w["latex"]),fnum(m)).ratio()
            if r>best[0]: best=(r,m)
        pairs.append({"word":w["latex"],"mini":best[1],"fuzzy":round(best[0],3),
                      "exact":fnum(w["latex"])==fnum(best[1]) if best[1] else False,
                      "covered":covered(w["latex"],best[1]) if best[1] else False})
    rows.append({"table":ti,"book":book,"page":page,"word_formulas":len(wf),"mini_formulas":len(mf),"pairs":pairs})
    print("TABLE",ti,book,page,"word",len(wf),"mini",len(mf),"exact",sum(p["exact"] for p in pairs),"f7",sum(p["fuzzy"]>=0.7 for p in pairs),"covered",sum(p["covered"] for p in pairs))
allp=[p for r in rows for p in r["pairs"]]
# sample 50 evenly
step=max(1,len(allp)//50); sample=allp[::step][:50]
print("all pairs",len(allp),"sample",len(sample),"exact",sum(p["exact"] for p in sample),"f7",sum(p["fuzzy"]>=0.7 for p in sample),"covered",sum(p["covered"] for p in sample))
print("rates",round(sum(p["exact"] for p in sample)/len(sample),3),round(sum(p["fuzzy"]>=0.7 for p in sample)/len(sample),3),round(sum(p["covered"] for p in sample)/len(sample),3))
for p in sample[:12]: print(" W",p["word"][:100],"| M",(p["mini"] or "")[:100],"|",p["fuzzy"],p["exact"],p["covered"])
json.dump({"tables":rows,"sample":sample,"all_n":len(allp),"sample_exact":sum(p["exact"] for p in sample),"sample_f7":sum(p["fuzzy"]>=0.7 for p in sample),"sample_covered":sum(p["covered"] for p in sample)},open("tmp/minicpm-round3/formula-table-50.json","w"),ensure_ascii=False,indent=2)
