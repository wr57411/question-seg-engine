import json,os,re,hashlib,base64,time,urllib.request,urllib.error
from PIL import Image
D=json.load(open("tmp/minicpm-p0p1/real-cases-all-aligned2.json"))
out="tmp/minicpm-p0p1/real-cases-fixed"; os.makedirs(out,exist_ok=True)
def safe(s): return hashlib.sha1(s.encode()).hexdigest()[:10]
def col_left(book,pi,x1,pw):
    lay=json.load(open(f"data/out/{book}/layout.json"))["pdf_info"][pi]
    xs=[]
    for pb in lay.get("para_blocks",[]):
        for line in pb.get("lines",[]):
            bb=line.get("bbox")
            if bb and bb[2]-bb[0]>10: xs.append(bb[0])
    if not xs: return 0
    left=min(x for x in xs if x<pw*0.5) if any(x<pw*0.5 for x in xs) else 0
    right=min(x for x in xs if x>=pw*0.5) if any(x>=pw*0.5 for x in xs) else left
    return left if x1<pw*0.5 else right
fixed=[]
for x in D:
    if x["kind"]!="replace_text" or max(x.get("ocrSim",0),x.get("ocrSim2",0))<0.2: continue
    img=Image.open(x["imagePath"]); W,H=img.size; pw,ph=x["pageWidth"],x["pageHeight"]
    sx=W/pw; sy=H/ph; pad=4
    x1=col_left(x["book"],x["pageIndex"],x["bbox"][0],pw)
    y1=int(round(x["bbox"][1]*sy))-pad; y2=int(round(x["bbox"][3]*sy))+pad
    px1=max(0,int(round(x1*sx))-pad); px2=min(W,int(round(x["bbox"][2]*sx))+pad)
    crop=img.crop((px1,y1,px2,y2)); cp=f"{out}/{safe(x['id'])}.png"; crop.save(cp)
    y=dict(x); y.update({"bbox":[x1,x["bbox"][1],x["bbox"][2],x["bbox"][3]],"cropPath":cp,"cropW":crop.width,"cropH":crop.height,"fixed_crop":True})
    fixed.append(y)
json.dump(fixed,open("tmp/minicpm-p0p1/replace-text-fixed.json","w"),ensure_ascii=False,indent=2)
print("fixed",len(fixed))
for x in fixed: print(x["id"],x["cropW"],x["cropH"],x["cropPath"],"|",x["correct"][:50])
