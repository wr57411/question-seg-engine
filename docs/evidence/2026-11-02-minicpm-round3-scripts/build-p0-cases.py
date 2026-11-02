import json, os, re, glob, hashlib
from PIL import Image
from collections import Counter, defaultdict

ROOT="."
blocks=json.load(open("tmp/minicpm-round3/logical-blocks.json"))["blocks"]
bybook=defaultdict(list)
for b in blocks: bybook[b["book"]].append(b)
OUT="tmp/minicpm-round3/p0-cases"
os.makedirs(OUT,exist_ok=True)
def norm(s): return re.sub(r'\s+','',s or '')
def clean(s): return re.sub(r'\s+',' ',s or '').strip()
def safe(s): return hashlib.sha1(s.encode()).hexdigest()[:10]

def find_block(book,pageIndex,target,tokens=None):
    cands=[b for b in bybook.get(book,[]) if b["pageIndex"]==pageIndex]
    if not cands: return None
    nt=norm(target); toks=[norm(t) for t in (tokens or []) if t]
    best=None
    for b in cands:
        hay=norm(b.get("blockText","")+"\n"+b.get("qaText",""))
        score=0
        if nt and nt in hay: score=len(nt)
        elif toks and any(t in hay for t in toks): score=max(len(t) for t in toks if t in hay)
        if score and (best is None or score>best[0]): best=(score,b)
    return best[1] if best else None

def apply_replace_reverse(text, frm, to):
    # correct has `to`; wrong has `from` (e.g., O->0)
    fs=frm.split("/"); ts=to.split("/")
    out=text
    for a,b in zip(fs,ts):
        if b and b in out: out=out.replace(b,a)
    return out

def classify(kind,it,text):
    if kind=="replace":
        frm=it.get("from",""); to=it.get("to","")
        return "o_to_zero" if ("0" in frm+to and "O" in frm+to) else "char"
    if kind=="replace_text": return "prefix_missing"
    if kind=="insert":
        t=it.get("text","")
        if len(t)<=3 and t in "甲乙丙丁戊己庚辛": return "insert_line"
        if "$" in t or "\\frac" in t or "\\sqrt" in t: return "formula_fragment"
        return "insert_line"
    return "other"

corr_by_book=defaultdict(list)
for fp in glob.glob("corrections/*.json"):
    d=json.load(open(fp)); corr_by_book[d["docId"]]=d.get("items",[])

def apply_one(correct, it):
    kind=it.get("kind")
    if kind=="replace":
        w=apply_replace_reverse(correct,it.get("from",""),it.get("to",""))
        return w if w!=correct else None
    if kind=="replace_text":
        to=clean(it.get("to","")); bt=clean(it.get("blockText",""))
        if to and to in correct: return correct.replace(to,bt,1)
        return None
    if kind=="insert":
        t=clean(it.get("text",""))
        if t and t in correct: return correct.replace(t,"",1)
        return None
    return None

cases=[]; skipped=[]; unmapped=[]; unique_blocks=set()
for fp in glob.glob("corrections/*.json"):
    d=json.load(open(fp)); book=d["docId"]
    for idx,it in enumerate(d.get("items",[])):
        if not it.get("verified"): continue
        page1=it.get("page"); kind=it.get("kind")
        if not isinstance(page1,int) or kind not in ("replace","replace_text","insert"): continue
        pi=page1-1
        target=""; tokens=[]
        if kind=="replace": tokens=it.get("to","").split("/")
        elif kind=="replace_text": target=it.get("to","")
        else: target=it.get("text","")
        b=find_block(book,pi,target,tokens)
        if not b: unmapped.append((book,page1,kind,target[:60])); continue
        correct=clean(b.get("qaText",""))
        if not correct: skipped.append((book,page1,"empty qaText")); continue
        wrong=apply_one(correct,it)
        if not wrong or norm(wrong)==norm(correct): skipped.append((book,page1,"cannot apply")); continue
        typ=classify(kind,it,wrong)
        bb=b.get("textBbox") or b.get("bbox")
        if not bb: skipped.append((book,page1,"no bbox")); continue
        img=Image.open(b["imagePath"]); W,H=img.size; pw,ph=b["pageWidth"],b["pageHeight"]
        sx=W/pw; sy=H/ph; pad=4
        xs=[x["bbox"][0] for x in bybook.get(book,[]) if x["pageIndex"]==b["pageIndex"]]
        col_left=0
        if xs:
            lefts=[x for x in xs if x<pw*0.5]; rights=[x for x in xs if x>=pw*0.5]
            col_left=(min(lefts) if lefts else 0) if bb[0]<pw*0.5 else (min(rights) if rights else 0)
        x1=max(0,int(round(min(col_left,bb[0])*sx))-pad); y1=max(0,int(round(bb[1]*sy))-pad)
        x2=min(W,int(round(bb[2]*sx))+pad); y2=min(H,int(round(bb[3]*sy))+pad)
        if x2-x1<20 or y2-y1<15: skipped.append((book,page1,"crop too small")); continue
        key=f"{b['id']}:c{idx}"
        crop=img.crop((x1,y1,x2,y2)); cp=f"{OUT}/{safe(key)}.png"; crop.save(cp)
        cases.append({"id":key,"block_id":b["id"],"book":book,"pageIndex":b["pageIndex"],"page1":b["pageIndex"]+1,
                      "number":b.get("number"),"error_type":typ,"verified":True,
                      "correct":correct,"wrong":wrong,"bbox":bb,"cropPath":cp,"cropW":crop.width,"cropH":crop.height,
                      "imagePath":b["imagePath"],"pageWidth":pw,"pageHeight":ph,
                      "correction":{"kind":kind,"from":it.get("from"),"to":it.get("to"),"text":it.get("text")}})
        unique_blocks.add(b["id"])
json.dump({"cases":cases,"skipped":skipped,"unmapped":unmapped},open("tmp/minicpm-round3/p0-cases-all.json","w"),ensure_ascii=False,indent=2)
print("cases",len(cases),"unique_blocks",len(unique_blocks),"skipped",len(skipped),"unmapped",len(unmapped))
print("types",Counter(c["error_type"] for c in cases))
print("books",Counter(c["book"] for c in cases))
print("skipped reasons",Counter(s[2] for s in skipped).most_common(8))
