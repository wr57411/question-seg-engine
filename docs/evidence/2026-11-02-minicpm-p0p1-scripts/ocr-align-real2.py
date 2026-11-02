import json,re,subprocess,difflib,os
from PIL import Image
D=json.load(open("tmp/minicpm-p0p1/real-cases-all-aligned.json"))
def norm(s):
    s=re.sub(r'\s+','',s or '')
    s=re.sub(r'[，。；：、（）()\[\]【】“”"\'.,;:!?·—\-]','',s)
    return s
def ocr(p,psm):
    r=subprocess.run(["tesseract",p,"stdout","-l","chi_sim+eng","--psm",str(psm)],capture_output=True,text=True,timeout=30)
    return r.stdout.strip()
changed=0
for x in D:
    if x["ocrSim"]>=0.2: continue
    # upscale 2x
    im=Image.open(x["cropPath"]); up=im.resize((im.width*2,im.height*2),Image.LANCZOS)
    p=x["cropPath"].replace(".png","-up2.png"); up.save(p)
    best=x["ocrSim"]; besttxt=x["ocrText"]
    for psm in (6,7,11):
        try: o=ocr(p,psm)
        except Exception: continue
        s=difflib.SequenceMatcher(None,norm(o),norm(x["correct"])).ratio()
        if s>best: best=s; besttxt=o
    if best>x["ocrSim"]:
        x["ocrSim2"]=best; x["ocrText2"]=besttxt; changed+=1
print("improved",changed)
json.dump(D,open("tmp/minicpm-p0p1/real-cases-all-aligned2.json","w"),ensure_ascii=False,indent=2)
for thr in (0.2,0.25,0.3):
    ok=[x for x in D if max(x["ocrSim"],x.get("ocrSim2",0))>=thr]
    print("thr",thr,"keep",len(ok),"verified",sum(x["verified"] for x in ok),"insert",sum(x["kind"]=="insert" for x in ok),"replace",sum(x["kind"]=="replace" for x in ok),"replace_text",sum(x["kind"]=="replace_text" for x in ok))
