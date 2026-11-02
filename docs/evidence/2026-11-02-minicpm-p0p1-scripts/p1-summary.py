import json,re,os
from collections import Counter
from statistics import mean,median
cmp=json.load(open("tmp/minicpm-p0p1/p1-compare.json"))
fid=json.load(open("tmp/minicpm-p0p1/p1-fidelity.json"))
def load(book,page):
    p=f"tmp/minicpm-p0p1/p1-parses/{book}-p{page}.json"
    if os.path.exists(p): return json.load(open(p))
    return json.load(open("data/archive/2026-11-02/minicpm-probe/parse-page05.json"))
def nums(content):
    out=[]
    for line in content.splitlines():
        s=re.sub(r'^#+\s*','',line.strip()); s=re.sub(r'^\*+\s*','',s)
        m=re.match(r'^(\d{1,3})(?:\s*[.．、\[\(（]|\s+(?=\S)|$)',s)
        if m: out.append(m.group(1))
    return out
pages=[]
for c,f in zip(cmp,fid):
    assert (c["book"],c["page"])==(f["book"],f["page"])
    d=load(c["book"],c["page"]); pg=d.get("pages",[d])[0]; cont=pg["choices"][0]["message"]["content"]
    exp=Counter(c["exp_nums"]); got=Counter(nums(cont))
    occ_exp=sum(exp.values()); occ_match=sum(min(exp[n],got[n]) for n in exp)
    pages.append({"book":c["book"],"page":c["page"],
        "unique_expected":len(set(c["exp_nums"])),"unique_matched":len(c["matched"]),
        "occurrence_expected":occ_exp,"occurrence_matched":occ_match,
        "missing":c["missing"],"extra":c["extra"],"inversions":c["inversions"],
        "recall_mean":f["recall_mean"],"recall_median":f["recall_median"],"recall_min":f["recall_min"],"below_0.5":f["below_0.5"],
        "table_blocks":f["table_blocks"],"chart_blocks":f["chart_blocks"],"chart_as_table":f["chart_as_table"],
        "elapsed":c.get("elapsed",0)})
summary={"pages":pages,
 "aggregates":{"pages":len(pages),
   "unique_expected":sum(p["unique_expected"] for p in pages),"unique_matched":sum(p["unique_matched"] for p in pages),
   "occurrence_expected":sum(p["occurrence_expected"] for p in pages),"occurrence_matched":sum(p["occurrence_matched"] for p in pages),
   "pages_with_missing":sum(bool(p["missing"]) for p in pages),"pages_with_extra":sum(bool(p["extra"]) for p in pages),
   "inversions":sum(p["inversions"] for p in pages),
   "recall_mean":round(mean([p["recall_mean"] for p in pages]),3),
   "recall_median":round(median([p["recall_mean"] for p in pages]),3),
   "recall_min":min(p["recall_min"] for p in pages),
   "below_0.5":sum(p["below_0.5"] for p in pages),
   "chart_blocks":sum(p["chart_blocks"] for p in pages),"chart_as_table":sum(p["chart_as_table"] for p in pages),
   "elapsed_min":min(p["elapsed"] for p in pages if p["elapsed"]),"elapsed_max":max(p["elapsed"] for p in pages)}}
json.dump(summary,open("tmp/minicpm-p0p1/p1-summary.json","w"),ensure_ascii=False,indent=2)
print(json.dumps(summary,ensure_ascii=False,indent=2))
