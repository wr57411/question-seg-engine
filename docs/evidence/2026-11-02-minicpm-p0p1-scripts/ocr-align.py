import json, re, subprocess, difflib
from collections import Counter
cases=json.load(open("tmp/minicpm-p0p1/jev-results-enriched.json"))
def norm(s):
    s=re.sub(r'\s+','',s or '')
    s=re.sub(r'[，。；：、（）()\[\]【】“”"\'.,;:!?·—\-]','',s)
    return s
def ocr(p,psm):
    r=subprocess.run(["tesseract",p,"stdout","-l","chi_sim+eng","--psm",str(psm)],capture_output=True,text=True,timeout=30)
    return r.stdout.strip()
for x in cases:
    if x["category"]!="text": continue
    psm=7 if "line block" in (x["source"] or "") else 6
    try: o=ocr(x["cropPath"],psm)
    except Exception as e: o=""
    x["ocrText"]=o
    x["ocrSim"]=difflib.SequenceMatcher(None,norm(o),norm(x["correct"])).ratio()
json.dump(cases,open("tmp/minicpm-p0p1/jev-results-aligned.json","w"),ensure_ascii=False,indent=2)
xs=[x for x in cases if x["category"]=="text"]
print("text cases",len(xs))
print("sim buckets",Counter((round(x["ocrSim"]*10)/10) for x in xs))
for thr in (0.2,0.25,0.3,0.4,0.5):
    ok=[x for x in xs if x["ocrSim"]>=thr]
    print(f"thr {thr}: keep {len(ok)}/{len(xs)}; kept short {sum('line block' in (x['source'] or '') for x in ok)} long {sum('lines ' in (x['source'] or '') for x in ok)}")
print("\nlowest sim:")
for x in sorted(xs,key=lambda z:z["ocrSim"])[:20]:
    print(round(x["ocrSim"],2),x["book"],x["id"],"|OCR",x["ocrText"][:50].replace("\n"," "),"|CAND",x["correct"][:50].replace("\n"," / "))
