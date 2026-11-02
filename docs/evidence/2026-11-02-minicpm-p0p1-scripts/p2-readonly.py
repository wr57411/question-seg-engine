import json,os,re,base64,time,urllib.request,urllib.error
from PIL import Image
book="物理_教材基础练 电路"; page=4
mp=json.load(open("data/archive/2026-11-02/minicpm-probe/parse-page05.json")); pg=mp.get("pages",[mp])[0]
content=pg["choices"][0]["message"]["content"]; blocks=pg["ocr"]["blocks"]
lay=json.load(open(f"data/out/{book}/layout.json"))["pdf_info"][page]
img=Image.open(f"data/out/{book}/pages/page-05.png"); W,H=img.size
pw,ph=lay["page_size"]
# mineru lines
mlines=[]
for pb in lay.get("para_blocks",[]):
    for line in pb.get("lines",[]):
        txt="".join((sp.get("content") or sp.get("text") or "") for sp in line.get("spans",[]))
        bb=line.get("bbox")
        if txt.strip() and bb: mlines.append({"text":txt,"bbox":bb})
def overlap(a,b):
    x1=max(a[0],b[0]); y1=max(a[1],b[1]); x2=min(a[2],b[2]); y2=min(a[3],b[3])
    return max(0,x2-x1)*max(0,y2-y1)
def area(b): return max(0,b[2]-b[0])*max(0,b[3]-b[1])
# scale mini bbox -> layout coords
sx=pw/W; sy=ph/H
cases=[]
for b in blocks:
    if b.get("label") not in ("text","paragraph_title","doc_title"): continue
    t=(b.get("content") or "").strip()
    if len(t)<10: continue
    bb=b["bbox"]; lb=[bb[0]*sx,bb[1]*sy,bb[2]*sx,bb[3]*sy]
    parts=[l["text"] for l in mlines if overlap(l["bbox"],lb)>0.2*area(l["bbox"])]
    mt="\n".join(parts).strip()
    if not mt or mt==t: continue
    # crop
    x1,y1,x2,y2=map(int,bb); x1=max(0,x1-3); y1=max(0,y1-3); x2=min(W,x2+3); y2=min(H,y2+3)
    cp=f"tmp/minicpm-p0p1/p2-crop-{len(cases)}.png"; img.crop((x1,y1,x2,y2)).save(cp)
    cases.append({"id":f"p2:{len(cases)}","label":b.get("label"),"bbox":bb,"cropPath":cp,"mineru":mt,"minicpm":t})
print("cases",len(cases))
for c in cases[:5]: print(c["id"],c["label"],"| M:",c["mineru"][:60],"| C:",c["minicpm"][:60])
if not cases: raise SystemExit
m=re.search(r'MiniCPM_API_KEY="?([^"\n]+)"?',open(os.path.expanduser("~/.zshrc")).read()); KEY=m.group(1).strip()
def uri(p): return "data:image/png;base64,"+base64.b64encode(open(p,"rb").read()).decode()
content=[]; items=[]
for c in cases:
    im=uri(c["cropPath"]); content+=[{"type":"image_url","image_url":{"url":im}},{"type":"text","text":c["mineru"]+"\n\n"+c["minicpm"]}]
    items.append({"case_id":c["id"],"image":im,"category":"text","candidates":[c["mineru"],c["minicpm"]]})
payload={"model":"MiniCPM-OCR-Jev","messages":[{"role":"user","content":content}],"minicpm_ocr_jev":{"mode":"score_best_batch","items":items},"stream":False}
req=urllib.request.Request("https://api.modelbest.cn/v1/chat/completions",data=json.dumps(payload).encode(),headers={"Authorization":"Bearer "+KEY,"Content-Type":"application/json"},method="POST")
try:
    with urllib.request.urlopen(req,timeout=240) as r: d=json.loads(r.read())
except urllib.error.HTTPError as e:
    print("HTTP",e.code,e.read().decode()[:500]); raise
parsed=json.loads(d["choices"][0]["message"]["content"]); res=parsed.get("results",[])
out=[]
for c,r in zip(cases,res):
    scores=r.get("scores") or []; best=r.get("best_index"); margin=(scores[0]-scores[1]) if len(scores)==2 else None
    # block-level routing: high confidence only if best>=0.02 and margin>=0.2; else review
    if best==1: decision="prefer_minicpm"
    elif best==0 and scores and scores[0]>=0.02 and margin is not None and margin>=0.2: decision="auto_pass"
    else: decision="review"
    out.append({**c,"scores":scores,"best":best,"margin":margin,"decision":decision,"verdicts":r.get("verdicts")})
json.dump({"page":book+" p"+str(page+1),"cases":out,"usage":d.get("usage")},open("tmp/minicpm-p0p1/p2-readonly.json","w"),ensure_ascii=False,indent=2)
from collections import Counter
print("decisions",Counter(x["decision"] for x in out),"best",Counter(x["best"] for x in out),"usage",d.get("usage"))
for x in out:
    print(x["id"],"best",x["best"],"scores",x["scores"],"margin",x["margin"],"->",x["decision"])
