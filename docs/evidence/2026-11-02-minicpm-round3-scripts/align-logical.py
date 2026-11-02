import json,re,subprocess,difflib
from collections import Counter
D=json.load(open("tmp/minicpm-round3/p0-cases-all.json"))["cases"]
def norm(s):
    s=re.sub(r'\s+','',s or '')
    s=re.sub(r'[，。；：、（）()\[\]【】“”"\'.,;:!?·—\-]','',s)
    return s
def ng(s,n=4): return {s[i:i+n] for i in range(max(0,len(s)-n+1))}
def ocr(p,psm):
    r=subprocess.run(["tesseract",p,"stdout","-l","chi_sim+eng","--psm",str(psm)],capture_output=True,text=True,timeout=30)
    return r.stdout.strip()
for x in D:
    try: o=ocr(x["cropPath"],6)
    except Exception: o=""
    x["ocrText"]=o
    x["ocrSim"]=difflib.SequenceMatcher(None,norm(o),norm(x["correct"])).ratio()
    bg=ng(norm(x["correct"])); og=ng(norm(o))
    x["ocrRecall"]=len(bg&og)/len(bg) if bg else 0
json.dump(D,open("tmp/minicpm-round3/p0-logical-aligned.json","w"),ensure_ascii=False,indent=2)
for t in (0.1,0.15,0.2,0.25,0.3):
    ok=[x for x in D if max(x["ocrSim"],x["ocrRecall"])>=t]
    print("thr",t,"keep",len(ok),"/",len(D),"types",Counter(x["error_type"] for x in ok),"books",len(set(x["book"] for x in ok)))
print("lowest:")
for x in sorted(D,key=lambda z:max(z["ocrSim"],z["ocrRecall"]))[:10]:
    print(round(x["ocrSim"],2),round(x["ocrRecall"],2),x["error_type"],x["book"],x["page1"],"|OCR",x["ocrText"][:50].replace("\n"," "))
