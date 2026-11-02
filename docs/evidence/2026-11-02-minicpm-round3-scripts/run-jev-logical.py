import json,os,re,base64,time,urllib.request,urllib.error,hashlib
D=json.load(open("tmp/minicpm-round3/p0-logical-aligned.json"))
cases=[x for x in D if max(x.get("ocrSim",0),x.get("ocrRecall",0))>=0.1]
print("cases",len(cases),"unique_blocks",len(set(x["block_id"] for x in cases)))
m=re.search(r'MiniCPM_API_KEY="?([^"\n]+)"?',open(os.path.expanduser("~/.zshrc")).read()); KEY=m.group(1).strip()
os.makedirs("tmp/minicpm-round3/jev-logical",exist_ok=True)
def uri(p): return "data:image/png;base64,"+base64.b64encode(open(p,"rb").read()).decode()
def safe(s): return hashlib.sha1(s.encode()).hexdigest()[:12]
def post(payload):
    req=urllib.request.Request("https://api.modelbest.cn/v1/chat/completions",data=json.dumps(payload).encode(),headers={"Authorization":"Bearer "+KEY,"Content-Type":"application/json"},method="POST")
    with urllib.request.urlopen(req,timeout=240) as r: return json.loads(r.read())
out=[]; skipped=[]
for i,c in enumerate(cases):
    fp=f"tmp/minicpm-round3/jev-logical/{safe(c['id'])}.json"
    if os.path.exists(fp): r=json.load(open(fp))
    else:
        img=uri(c["cropPath"])
        payload={"model":"MiniCPM-OCR-Jev","messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":img}},{"type":"text","text":c["correct"]+"\n\n"+c["wrong"]}]}],"minicpm_ocr_jev":{"mode":"score_best","category":"text","candidates":[c["correct"],c["wrong"]]},"stream":False}
        try:
            d=post(payload); r=json.loads(d["choices"][0]["message"]["content"]); open(fp,"w").write(json.dumps(r,ensure_ascii=False))
        except urllib.error.HTTPError as e:
            body=e.read().decode()[:200]
            print("SKIP",e.code,c["id"],body); skipped.append({"id":c["id"],"reason":body}); continue
    out.append({**{k:c.get(k) for k in ("id","block_id","book","page1","number","error_type","correct","wrong","cropPath","ocrSim","ocrRecall")},
                "scores":r.get("scores"),"verdicts":r.get("verdicts"),"best_index":r.get("best_index")})
    if (i+1)%10==0: print("progress",i+1,"/",len(cases))
json.dump({"results":out,"skipped":skipped},open("tmp/minicpm-round3/logical-results.json","w"),ensure_ascii=False,indent=2)
print("results",len(out),"skipped",len(skipped))
