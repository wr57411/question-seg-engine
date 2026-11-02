import json, os, re, glob, hashlib
from PIL import Image

CORR=glob.glob("corrections/*.json")
OUT="tmp/minicpm-p0p1/real-cases"
os.makedirs(OUT,exist_ok=True)

def norm(s): return re.sub(r'\s+','',s or '')
def clean(s): return re.sub(r'\s+',' ',s or '').strip()
def safe(s): return hashlib.sha1(s.encode()).hexdigest()[:10]
def image_path(book,pageIndex):
    for w in (2,3):
        p=f"data/out/{book}/pages/page-{pageIndex+1:0{w}d}.png"
        if os.path.exists(p): return p
    return None
def raw_lines(book,pageIndex):
    lay=json.load(open(f"data/out/{book}/layout.json"))["pdf_info"][pageIndex]
    out=[]
    for pb in lay.get("para_blocks",[]):
        for line in pb.get("lines",[]):
            txt="".join((sp.get("content") or sp.get("text") or "") for sp in line.get("spans",[]))
            bb=line.get("bbox")
            if txt.strip() and bb: out.append({"text":txt,"bbox":bb})
    return out,lay

def find_line(lines, blockText):
    n=norm(blockText); best=None
    for l in lines:
        ln=norm(l["text"])
        if not ln: continue
        if n and (n in ln or ln in n):
            score=abs(len(ln)-len(n))
            if best is None or score<best[0]: best=(score,l)
    return best[1] if best else None

def apply_replace(blockText, frm, to):
    fs=frm.split("/"); ts=to.split("/")
    out=blockText
    for a,b in zip(fs,ts):
        if a and a in out: out=out.replace(a,b)
    return out

def choose_wrong_insert(correct, bbox, lines, page_texts):
    # captions: use another short label on same page
    if len(correct)<=3:
        # 图注：只用同页另一个图注，避免拿“衡力/刷”这种碎片当错候选
        if correct in "甲乙丙丁戊己庚辛":
            for alt in "甲乙丙丁戊己庚辛":
                if alt!=correct and alt in page_texts: return alt
            # 同页没有另一个图注时，用固定的另一个图注（真实视觉混淆）
            for alt in "甲乙丙丁戊己庚辛":
                if alt!=correct: return alt
        m=re.match(r'图\s*(\d+)',correct)
        if m:
            for n in range(1,10):
                alt=f"图{n}"
                if alt!=correct: return alt
        if correct=="曲辕犁": return "直辕犁"
        if correct=="直辕犁": return "曲辕犁"
        return None
    cx=(bbox[0]+bbox[2])/2; cy=(bbox[1]+bbox[3])/2
    cands=[]
    for l in lines:
        t=clean(l["text"])
        if not t or t==correct: continue
        if len(t)<max(4,len(correct)*0.4) or len(t)>len(correct)*2.2: continue
        if norm(correct) in norm(t) or norm(t) in norm(correct): continue
        x=(l["bbox"][0]+l["bbox"][2])/2; y=(l["bbox"][1]+l["bbox"][3])/2
        cands.append((abs(x-cx)+abs(y-cy),t,l["bbox"]))
    if not cands: return None
    return sorted(cands)[0][1]

cases=[]; skipped=[]
for fp in CORR:
    d=json.load(open(fp)); book=d["docId"]
    try: data=json.load(open(f"data/out/{book}/layout.json"))
    except FileNotFoundError:
        skipped.append((book,"no layout")); continue
    for idx,it in enumerate(d.get("items",[])):
        kind=it.get("kind"); page1=it.get("page")
        if not isinstance(page1,int): continue
        pi=page1-1
        if pi<0 or pi>=len(data["pdf_info"]): continue
        lines,lay=raw_lines(book,pi); pageTexts=[clean(l["text"]) for l in lines]
        img=image_path(book,pi)
        if not img: skipped.append((book,page1,"no image")); continue
        bbox=None; correct=None; wrong=None
        if kind=="insert":
            bbox=it.get("bbox"); correct=clean(it.get("text",""))
            if not bbox or not correct: skipped.append((book,page1,"insert no bbox/text")); continue
            wrong=choose_wrong_insert(correct,bbox,lines,pageTexts)
        elif kind in ("replace","replace_text"):
            line=find_line(lines,it.get("blockText",""))
            if not line: skipped.append((book,page1,f"{kind} line not found")); continue
            bbox=line["bbox"]
            if kind=="replace":
                correct=apply_replace(it.get("blockText",""),it.get("from",""),it.get("to",""))
                wrong=it.get("blockText","")
            else:
                correct=clean(it.get("to","")); wrong=clean(it.get("blockText",""))
        elif kind=="split":
            line=find_line(lines,it.get("blockText",""))
            if not line: skipped.append((book,page1,"split line not found")); continue
            bbox=line["bbox"]; correct=clean(it.get("blockText","")); wrong=None
        else:
            continue
        if not bbox or not correct or not wrong or norm(correct)==norm(wrong):
            skipped.append((book,page1,f"{kind} no candidate")); continue
        # crop
        imgobj=Image.open(img); W,H=imgobj.size; pw,ph=lay["page_size"]
        sx=W/pw; sy=H/ph; pad=4
        x1=max(0,int(round(bbox[0]*sx))-pad); y1=max(0,int(round(bbox[1]*sy))-pad)
        x2=min(W,int(round(bbox[2]*sx))+pad); y2=min(H,int(round(bbox[3]*sy))+pad)
        if x2-x1<8 or y2-y1<8:
            skipped.append((book,page1,"crop too small")); continue
        fn=f"{safe(book+str(page1)+str(idx))}.png"; cp=f"{OUT}/{fn}"
        imgobj.crop((x1,y1,x2,y2)).save(cp)
        cases.append({"id":f"{book}:p{page1}:{kind}{idx}","book":book,"pageIndex":pi,"page1":page1,
                      "kind":kind,"verified":it.get("verified"),"source":it.get("source",""),
                      "bbox":bbox,"pageWidth":pw,"pageHeight":ph,"imagePath":img,
                      "cropPath":cp,"cropW":x2-x1,"cropH":y2-y1,
                      "correct":correct,"wrong":wrong,"evidence":it.get("evidence","")[:300]})
json.dump({"cases":cases,"skipped":skipped},open("tmp/minicpm-p0p1/real-cases-all.json","w"),ensure_ascii=False,indent=2)
from collections import Counter
print("cases",len(cases),"skipped",len(skipped))
print("by kind",Counter(c["kind"] for c in cases))
print("by book",Counter(c["book"] for c in cases))
print("skipped reasons",Counter(s[2] if len(s)>2 else s[1] for s in skipped).most_common(12))
