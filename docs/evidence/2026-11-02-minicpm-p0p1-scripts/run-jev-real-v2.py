import base64, json, os, time, urllib.request, urllib.error, re, hashlib

m=re.search(r'MiniCPM_API_KEY="?([^"\n]+)"?', open(os.path.expanduser("~/.zshrc")).read()); KEY=m.group(1).strip()
D=json.load(open("tmp/minicpm-p0p1/real-cases-all-aligned2.json"))
cases=[x for x in D if max(x.get("ocrSim",0),x.get("ocrSim2",0))>=0.2]
for x in cases: x["category"]="text"
os.makedirs("tmp/minicpm-p0p1/jev-real-single",exist_ok=True)
def data_uri(p): return "data:image/png;base64,"+base64.b64encode(open(p,"rb").read()).decode()
def safe(s): return hashlib.sha1(s.encode()).hexdigest()[:12]
def post(payload):
    req=urllib.request.Request("https://api.modelbest.cn/v1/chat/completions",data=json.dumps(payload).encode(),
        headers={"Authorization":"Bearer "+KEY,"Content-Type":"application/json"},method="POST")
    with urllib.request.urlopen(req,timeout=240) as r: return json.loads(r.read())

allr=[]; skipped=[]
# reuse first 7 batches (56 cases)
for bi in range(7):
    fp=f"tmp/minicpm-p0p1/jev-real-batches/batch-{bi:03d}.json"
    if not os.path.exists(fp): continue
    d=json.load(open(fp)); parsed=json.loads(d["choices"][0]["message"]["content"]); res=parsed.get("results",[])
    for c,r in zip(cases[bi*8:(bi+1)*8],res):
        allr.append({**{k:c.get(k) for k in ("id","book","page1","kind","verified","source","correct","wrong","cropPath","ocrSim","ocrSim2")},
                     "scores":r.get("scores"),"verdicts":r.get("verdicts"),"best_index":r.get("best_index")})
print("reused",len(allr))
# process rest individually
for idx,c in enumerate(cases):
    if idx<56: continue
    fp=f"tmp/minicpm-p0p1/jev-real-single/{safe(c['id'])}.json"
    if os.path.exists(fp):
        r=json.load(open(fp))
    else:
        img=data_uri(c["cropPath"])
        payload={"model":"MiniCPM-OCR-Jev","messages":[{"role":"user","content":[
            {"type":"image_url","image_url":{"url":img}},
            {"type":"text","text":c["correct"]+"\n\n"+c["wrong"]}]}],
            "minicpm_ocr_jev":{"mode":"score_best","category":"text","candidates":[c["correct"],c["wrong"]]},
            "stream":False}
        try:
            d=post(payload); r=json.loads(d["choices"][0]["message"]["content"])
            open(fp,"w").write(json.dumps(r,ensure_ascii=False,indent=2))
        except urllib.error.HTTPError as e:
            body=e.read().decode()[:300]
            if e.code==400:
                skipped.append({"id":c["id"],"reason":body}); print("SKIP policy",c["id"],c["book"],c["page1"]); continue
            if e.code in (429,500,502,503,504):
                time.sleep(3); 
                try:
                    d=post(payload); r=json.loads(d["choices"][0]["message"]["content"]); open(fp,"w").write(json.dumps(r,ensure_ascii=False,indent=2))
                except Exception as e2:
                    skipped.append({"id":c["id"],"reason":str(e2)}); continue
            else:
                skipped.append({"id":c["id"],"reason":body}); print("SKIP",e.code,c["id"]); continue
    allr.append({**{k:c.get(k) for k in ("id","book","page1","kind","verified","source","correct","wrong","cropPath","ocrSim","ocrSim2")},
                 "scores":r.get("scores"),"verdicts":r.get("verdicts"),"best_index":r.get("best_index")})
    if (idx-56)%10==0: print("progress",idx,"/",len(cases))
json.dump({"results":allr,"skipped":skipped},open("tmp/minicpm-p0p1/real-results.json","w"),ensure_ascii=False,indent=2)
print("results",len(allr),"skipped",len(skipped))
