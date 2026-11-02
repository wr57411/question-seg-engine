import json, os, re, hashlib
from PIL import Image

ROOT="."
M=json.load(open("tmp/minicpm-p0p1/manifest.json"))
OUT="tmp/minicpm-p0p1/crops"
os.makedirs(OUT, exist_ok=True)

def safe(s):
    h=hashlib.sha1(s.encode()).hexdigest()[:10]
    return h

def norm_table(html):
    html=re.sub(r"<eq>(.*?)</eq>", lambda m:"$"+m.group(1).strip()+"$", html, flags=re.S)
    html=re.sub(r"<img\b[^>]*>", "", html, flags=re.I)
    html=re.sub(r"&nbsp;", " ", html)
    return html.strip()

def mutate_text(t):
    rules=[
        (r'(?<!\d)(\d)(?!\d)', lambda m: str((int(m.group(1))+1)%10)),
        (r'增大', '减小'), (r'减小', '增大'),
        (r'正确', '错误'), (r'错误', '正确'),
        (r'大于', '小于'), (r'小于', '大于'),
        (r'左', '右'), (r'右', '左'),
        (r'上', '下'), (r'下', '上'),
        (r'正电', '负电'), (r'负电', '正电'),
        (r'\bV\b', 'A'), (r'\bA\b', 'V'),
        (r'Ω', 'A'), (r'kg', 'g'), (r'm/s', 'm/s²'),
    ]
    for pat,rep in rules:
        if callable(rep):
            t2=re.sub(pat, rep, t, count=1)
        else:
            t2=re.sub(pat, rep, t, count=1)
        if t2!=t: return t2
    # inline formula symbol swaps
    for a,b in [(r'\Delta x',r'\Delta t'),(r'\Delta v',r'\Delta x'),(r'\frac',r'\frac'),(r'\theta',r'\alpha')]:
        if a in t:
            t2=t.replace(a,b,1)
            if t2!=t: return t2
    # fallback: realistic OCR order/omission errors
    cjk=lambda ch: bool(re.match(r'[\u4e00-\u9fa5]',ch))
    for i in range(len(t)-1):
        if cjk(t[i]) and cjk(t[i+1]):
            return t[:i]+t[i+1]+t[i]+t[i+2:]
    for i in range(1,len(t)-1):
        if cjk(t[i]):
            return t[:i]+t[i+1:]
    return None

def mutate_formula(t):
    # digit in formula
    m=re.search(r'\d',t)
    if m:
        i=m.start(); d=t[i]; nd=str((int(d)+1)%10)
        return t[:i]+nd+t[i+1:]
    for a,b in [(r'\Delta x',r'\Delta t'),(r'\Delta v',r'\Delta x'),(r'\Delta t',r'\Delta v'),
                (r'\theta',r'\alpha'),(r'v',r'a'),(r'a',r'v'),(r'x',r't'),(r't',r'x'),
                (r'm',r'M'),(r'R',r'r'),(r'\frac',r'\frac')]:
        if a in t:
            t2=t.replace(a,b,1)
            if t2!=t: return t2
    for a,b in [('=',r'\ne'),('+','-'),('-','+'),('^2','^3'),('^3','^2'),
                (r'\times',r'\div'),(r'\div',r'\times'),(r'\le',r'\ge'),(r'\ge',r'\le')]:
        if a in t:
            t2=t.replace(a,b,1)
            if t2!=t: return t2
    return t+' + 1'

def mutate_table(html):
    # prefer a digit inside a cell
    m=re.search(r'>([^<]*\d[^<]*)<', html)
    if m:
        cell=m.group(1); d=re.search(r'\d',cell); i=d.start()
        new=cell[:i]+str((int(d.group(0))+1)%10)+cell[i+1:]
        return html[:m.start(1)]+new+html[m.end(1):]
    m=re.search(r'\\frac\{[^{}]*\}\{([^{}]*)\}', html)
    if m:
        den=m.group(1); d=re.search(r'\d',den)
        if d:
            newden=den[:d.start()]+str((int(d.group(0))+1)%10)+den[d.end():]
            return html[:m.start(1)]+newden+html[m.end(1):]
    # fallback: mutate a Chinese cell by swapping adjacent chars, or append 1
    m=re.search(r'>([^<]{2,})<', html)
    if m:
        cell=m.group(1)
        cjk=lambda ch: bool(re.match(r'[\u4e00-\u9fa5]',ch))
        for i in range(len(cell)-1):
            if cjk(cell[i]) and cjk(cell[i+1]):
                new=cell[:i]+cell[i+1]+cell[i]+cell[i+2:]
                return html[:m.start(1)]+new+html[m.end(1):]
        return html[:m.start(1)]+cell+'1'+html[m.end(1):]
    return None

cases=[]
skipped=[]
for c in M["candidates"]:
    img=Image.open(c["imagePath"])
    sx=img.width/c["pageWidth"]; sy=img.height/c["pageHeight"]
    pad=4 if c["category"]!="text" else 3
    x1=int(round(c["bbox"][0]*sx))-pad; y1=int(round(c["bbox"][1]*sy))-pad
    x2=int(round(c["bbox"][2]*sx))+pad; y2=int(round(c["bbox"][3]*sy))+pad
    x1=max(0,x1); y1=max(0,y1); x2=min(img.width,x2); y2=min(img.height,y2)
    if x2-x1<8 or y2-y1<8:
        skipped.append((c["id"],"crop too small")); continue
    crop=img.crop((x1,y1,x2,y2))
    fn=f'{safe(c["id"])}.png'
    cp=f"{OUT}/{fn}"
    crop.save(cp)
    text=c["text"]
    if c["category"]=="table":
        text=norm_table(text)
    wrong = mutate_table(text) if c["category"]=="table" else (mutate_formula(text) if c["category"]=="formula" else mutate_text(text))
    if not wrong or wrong==text:
        skipped.append((c["id"],"no mutation")); continue
    cases.append({**c,"cropPath":cp,"cropW":crop.width,"cropH":crop.height,"correct":text,"wrong":wrong})

json.dump({"cases":cases,"skipped":skipped},open("tmp/minicpm-p0p1/cases.json","w"),ensure_ascii=False,indent=2)
from collections import Counter
print("cases",len(cases),"skipped",len(skipped))
print("by category",Counter(x["category"] for x in cases))
print("by book",Counter(x["book"] for x in cases))
print("skipped reasons",Counter(r for _,r in skipped))
