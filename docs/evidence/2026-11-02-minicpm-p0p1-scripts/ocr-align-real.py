import json,re,subprocess,difflib
from collections import Counter,defaultdict
D=json.load(open("tmp/minicpm-p0p1/real-cases-all.json")); cases=D["cases"]
def norm(s):
    s=re.sub(r'\s+','',s or '')
    s=re.sub(r'[，。；：、（）()\[\]【】“”"\'.,;:!?·—\-]','',s)
    return s
def ocr(p,psm):
    r=subprocess.run(["tesseract",p,"stdout","-l","chi_sim+eng","--psm",str(psm)],capture_output=True,text=True,timeout=30)
    return r.stdout.strip()
for x in cases:
    psm=7 if len(x["correct"])<=40 else 6
    try: o=ocr(x["cropPath"],psm)
    except Exception: o=""
    x["ocrText"]=o; x["ocrSim"]=difflib.SequenceMatcher(None,norm(o),norm(x["correct"])).ratio()
json.dump(cases,open("tmp/minicpm-p0p1/real-cases-all-aligned.json","w"),ensure_ascii=False,indent=2)
for thr in (0.15,0.2,0.25,0.3,0.4,0.5):
    ok=[x for x in cases if x["ocrSim"]>=thr]
    print("thr",thr,"keep",len(ok),"/",len(cases),"insert",sum(x["kind"]=="insert" for x in ok),"replace",sum(x["kind"]=="replace" for x in ok),"replace_text",sum(x["kind"]=="replace_text" for x in ok))
print("\nby book @0.2:")
by=defaultdict(lambda:[0,0])
for x in cases:
    by[x["book"]][0]+=1
    if x["ocrSim"]>=0.2: by[x["book"]][1]+=1
for k,v in by.items(): print(f"{k:30s} {v[1]}/{v[0]}")
print("\nlowest:")
for x in sorted(cases,key=lambda z:z["ocrSim"])[:15]:
    print(round(x["ocrSim"],2),x["kind"],x["book"],x["page1"],"|OCR",x["ocrText"][:50].replace("\n"," "),"|COR",x["correct"][:50].replace("\n"," / "))
