import json, os, re
from collections import Counter

PAGES=[("23必刷题 1 直线运动",0),("23必刷题 1 直线运动",10),("23必刷题 4 曲线运动",8),
       ("物理_教材基础练机械能守恒定律",1),("物理_教材基础练机械能守恒定律",3),
       ("物理_教材基础练 电路",4),("教材基础练 磁场",0),("答案册-合订本",1)]

def load_parse(book,page):
    p=f"tmp/minicpm-p0p1/p1-parses/{book}-p{page}.json"
    if os.path.exists(p): return json.load(open(p))
    if book=="物理_教材基础练 电路" and page==4:
        return json.load(open("data/archive/2026-11-02/minicpm-probe/parse-page05.json"))
    raise FileNotFoundError(p)

def raw_layout(book,page):
    return json.load(open(f"data/out/{book}/layout.json"))["pdf_info"][page]

def content_numbers(content):
    nums=[]
    for line in content.splitlines():
        s=line.strip()
        s=re.sub(r'^#+\s*','',s); s=re.sub(r'^\*+\s*','',s)
        m=re.match(r'^(\d{1,3})(?:\s*[.．、\[\(（]|\s+(?=\S)|$)',s)
        if m: nums.append(m.group(1))
    return nums

def expected_numbers(book,page):
    qs=json.load(open(f"data/out/{book}/questions.json"))
    out=[]
    for q in qs:
        if q.get("source",{}).get("pageIndex")==page:
            n=str(q.get("number",""))
            if n.isdigit(): out.append(n)
    return out

rows=[]
for book,page in PAGES:
    d=load_parse(book,page)
    pg=d.get("pages",[d])[0]
    content=pg.get("choices",[{}])[0].get("message",{}).get("content","")
    blocks=pg.get("ocr",{}).get("blocks",[])
    raw=raw_layout(book,page)
    exp_nums=expected_numbers(book,page)
    got_nums=content_numbers(content)
    got_set=set(got_nums); exp_set=set(exp_nums)
    matched=sorted(exp_set & got_set, key=int)
    missing=sorted(exp_set - got_set, key=int)
    extra=sorted(got_set - exp_set, key=int)
    # order: first occurrence sequence of matched numbers
    seq=[]
    for n in got_nums:
        if n in exp_set and n not in seq: seq.append(n)
    inv=sum(1 for i in range(len(seq)) for j in range(i+1,len(seq)) if int(seq[i])>int(seq[j]))
    # expected formulas/tables/charts/images from raw layout
    fspans=0; tables=0; charts=0; images=0
    for pb in raw.get("para_blocks",[]):
        t=pb.get("type")
        if t=="table": tables+=1
        if t in ("image","chart"): images+=1
        if t=="chart": charts+=1
        for line in pb.get("lines",[]):
            for sp in line.get("spans",[]):
                if sp.get("type") in ("inline_equation","equation_inline") and str(sp.get("content","")).strip(): fspans+=1
    m_formulas=len(re.findall(r'(?<!\$)\$(?!\$)[^$]+\$(?!\$)',content))
    m_tables=content.count("<table>")
    m_charts=sum(1 for b in blocks if b.get("label")=="chart")
    m_chart_tables=sum(1 for b in blocks if b.get("label")=="chart" and "<table" in (b.get("content") or ""))
    skipped=sum(1 for b in blocks if b.get("status")=="skipped_no_vlm")
    failed=sum(1 for b in blocks if b.get("status")=="failed")
    # expected text chars from raw lines
    exp_text="".join((sp.get("content") or sp.get("text") or "") for pb in raw.get("para_blocks",[]) for line in pb.get("lines",[]) for sp in line.get("spans",[]))
    rows.append({"book":book,"page":page,"exp_nums":exp_nums,"got_nums":got_nums,"matched":matched,"missing":missing,"extra":extra,
                 "coverage":f"{len(matched)}/{len(exp_set)}" if exp_set else "n/a",
                 "seq":seq,"inversions":inv,
                 "expected_formula_spans":fspans,"minicpm_inline_math":m_formulas,
                 "expected_tables":tables,"minicpm_tables":m_tables,
                 "expected_charts":charts,"minicpm_charts":m_charts,"minicpm_chart_tables":m_chart_tables,
                 "expected_images":images,"minicpm_skipped_images":skipped,"failed_blocks":failed,
                 "content_chars":len(content),"raw_text_chars":len(exp_text),"elapsed":round(d.get("_elapsed",0),2)})
    print(f"{book} p{page}: nums {len(matched)}/{len(exp_set)} missing={missing} extra={extra} seq={seq} inv={inv} | f {fspans}->{m_formulas} t {tables}->{m_tables} chart {charts}->{m_charts} (tables {m_chart_tables}) img {images}->skip {skipped} failed {failed} | chars {len(content)}/{len(exp_text)} {d.get('_elapsed',0):.1f}s")

json.dump(rows,open("tmp/minicpm-p0p1/p1-compare.json","w"),ensure_ascii=False,indent=2)
print("\n=== aggregates ===")
print("pages",len(rows))
print("coverage sum",sum(len(r["matched"]) for r in rows),"/",sum(len(set(r["exp_nums"])) for r in rows))
print("pages with missing",sum(bool(r["missing"]) for r in rows))
print("pages with extra",sum(bool(r["extra"]) for r in rows))
print("chart blocks",sum(r["minicpm_charts"] for r in rows),"chart-as-table",sum(r["minicpm_chart_tables"] for r in rows))
