import zipfile,xml.etree.ElementTree as ET,re,json,os
from collections import Counter
WORD="/Users/john/.zcode/workspace/default/question-seg-engine/books/物理_教材基础练.docx"
ns={'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
root=ET.fromstring(zipfile.ZipFile(WORD).read("word/document.xml"))
tables=root.findall('.//w:tbl',ns)
def cell_text(c): return ''.join(t.text or '' for t in c.findall('.//w:t',ns)).strip()
def word_rows(i):
    out=[]
    for r in tables[i].findall('./w:tr',ns):
        out.append([cell_text(c) for c in r.findall('./w:tc',ns)])
    return out
def norm(s):
    s=re.sub(r'\\[a-zA-Z]+\*?','',s or ''); s=re.sub(r'[\s$\\{}^_]+','',s)
    s=re.sub(r'[，。；：、（）()\[\]【】“”"\'.,;:!?·—\-]','',s); return s
def load(book,page):
    for d in ("tmp/minicpm-round3/p1-parses","tmp/minicpm-p0p1/p1-parses"):
        p=f"{d}/{book}-p{page}.json"
        if os.path.exists(p): return json.load(open(p))
    return json.load(open("data/archive/2026-11-02/minicpm-probe/parse-page05.json"))
def table_html(book,page):
    d=load(book,page); pg=d.get("pages",[d])[0]
    for b in pg.get("ocr",{}).get("blocks",[]):
        if b.get("label")=="table" and "<table" in (b.get("content") or ""): return b["content"]
    return ""
def strip_html(h):
    h=re.sub(r'<eq>(.*?)</eq>',lambda m:'$'+m.group(1).strip()+'$',h,flags=re.S)
    h=re.sub(r'<[^>]+>',' ',h); h=re.sub(r'&nbsp;',' ',h)
    return re.sub(r'\s+',' ',h).strip()
def mini_cells(h):
    out=[]
    for m in re.finditer(r'<(td|th)\b[^>]*>(.*?)</\1>',h,flags=re.I|re.S):
        t=strip_html(m.group(2))
        if t: out.append(t)
    return out
pairs=[(111,"物理_教材基础练机械能守恒定律",1),(112,"物理_教材基础练机械能守恒定律",3),(138,"物理_教材基础练 电路",4)]
out=[]
for ti,book,page in pairs:
    wr=word_rows(ti); wt=[c for row in wr for c in row if c]
    mc=mini_cells(table_html(book,page))
    wn=[norm(x) for x in wt if norm(x)]; mn=[norm(x) for x in mc if norm(x)]
    inter=Counter(wn)&Counter(mn); matched=sum(inter.values())
    out.append({"word_table":ti,"book":book,"page":page,"word_rows":len(wr),"word_text_cells":len(wn),"mini_text_cells":len(mn),
                "matched":matched,"word_recall":round(matched/len(wn),3) if wn else None,"mini_precision":round(matched/len(mn),3) if mn else None,
                "word_unmatched":[x for x in wt if norm(x) and norm(x) not in inter][:10],
                "mini_unmatched":[x for x in mc if norm(x) and norm(x) not in {norm(y) for y in wt}][:10]})
    print("TABLE",ti,book,page,"word",len(wn),"mini",len(mn),"matched",matched,"recall",out[-1]["word_recall"],"precision",out[-1]["mini_precision"])
    print("  word unmatched",out[-1]["word_unmatched"])
    print("  mini unmatched",out[-1]["mini_unmatched"])
json.dump(out,open("tmp/minicpm-round3/p1-word-tables.json","w"),ensure_ascii=False,indent=2)
# formula coverage
g=json.load(open("tmp/minicpm-round3/p1-gold-summary.json"))
def fnum(s):
    s=re.sub(r'\\(left|right|mathrm|text|scriptscriptstyle|displaystyle)','',s or ''); s=re.sub(r'[\s${}\\^_]+','',s); return s.lower()
def covered(a,b):
    a=fnum(a); b=fnum(b)
    if not a or not b: return False
    if a in b or b in a: return True
    A=set(a); B=set(b); return len(A&B)/len(A|B)>=0.8 if A|B else False
for name,arr in [("all",g["formulas"]),("sample",g["sample"])]:
    ex=sum(x["exact"] for x in arr); f7=sum(x["fuzzy"]>=0.7 for x in arr); cov=sum(covered(x["mineru"],x["minicpm"]) for x in arr)
    print("FORMULA",name,"n",len(arr),"exact",ex,"f7",f7,"covered",cov,"rates",round(ex/len(arr),3),round(f7/len(arr),3),round(cov/len(arr),3))
json.dump({"tables":out,"formula_all":{"n":len(g["formulas"]),"exact":sum(x["exact"] for x in g["formulas"]),"f7":sum(x["fuzzy"]>=0.7 for x in g["formulas"]),"covered":sum(covered(x["mineru"],x["minicpm"]) for x in g["formulas"])},
           "formula_sample":{"n":len(g["sample"]),"exact":sum(x["exact"] for x in g["sample"]),"f7":sum(x["fuzzy"]>=0.7 for x in g["sample"]),"covered":sum(covered(x["mineru"],x["minicpm"]) for x in g["sample"])}},
          open("tmp/minicpm-round3/p1-gold-word.json","w"),ensure_ascii=False,indent=2)
