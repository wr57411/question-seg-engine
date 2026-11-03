import json,re,difflib
from collections import Counter
W=json.load(open("tmp/minicpm-round3/word-omml.json"))["formulas"]
G=json.load(open("tmp/minicpm-round3/p1-gold.json"))["formulas"]  # MinerU -> MiniCPM pairs
def fnum(s):
    s=re.sub(r'\\(left|right|mathrm|text|scriptscriptstyle|displaystyle)','',s or '')
    s=re.sub(r'[\s${}\\^_]+','',s); return s.lower()
def covered(a,b):
    a=fnum(a); b=fnum(b)
    if not a or not b: return False
    if a in b or b in a: return True
    A=set(a); B=set(b); return len(A&B)/len(A|B)>=0.8 if A|B else False
word=[(fnum(x["latex"]),x["latex"],x.get("context","")) for x in W if len(fnum(x["latex"]))>=4]
# dedupe normalized, prefer longer context
seen={}
for n,l,c in word:
    if n not in seen or len(c)>len(seen[n][1]): seen[n]=(l,c)
word=[(n,l,c) for n,(l,c) in seen.items()]
print("word pool",len(word))
pairs=[]; used=set()
for g in G:
    mf=fnum(g["mineru"]); best=None
    for i,(wn,wl,wc) in enumerate(word):
        if i in used: continue
        r=difflib.SequenceMatcher(None,mf,wn).ratio()
        if best is None or r>best[0]: best=(r,i,wl,wc)
    if best and best[0]>=0.75:
        used.add(best[1])
        pairs.append({"book":g["book"],"page":g["page"],"word":best[2],"minicpm":g["minicpm"],"mineru":g["mineru"],
                      "word_match":round(best[0],3),"word_context":best[3][:80]})
# sample 50 spread
step=max(1,len(pairs)//50); sample=pairs[::step][:50]
for p in sample:
    p["exact"]=fnum(p["word"])==fnum(p["minicpm"])
    p["fuzzy"]=round(difflib.SequenceMatcher(None,fnum(p["word"]),fnum(p["minicpm"])).ratio(),3)
    p["covered"]=covered(p["word"],p["minicpm"])
ex=sum(p["exact"] for p in sample); f7=sum(p["fuzzy"]>=0.7 for p in sample); f8=sum(p["fuzzy"]>=0.8 for p in sample); cov=sum(p["covered"] for p in sample)
print("pairs",len(pairs),"sample",len(sample),"exact",ex,"f7",f7,"f8",f8,"covered",cov)
for p in sample[:10]:
    print("---",p["book"],p["page"],"match",p["word_match"],"fuzzy",p["fuzzy"],p["exact"],p["covered"])
    print(" W:",p["word"][:160])
    print(" M:",p["minicpm"][:160])
json.dump({"pairs":pairs,"sample":sample,"exact":ex,"f7":f7,"f8":f8,"covered":cov},open("tmp/minicpm-round3/formula-word-50.json","w"),ensure_ascii=False,indent=2)
