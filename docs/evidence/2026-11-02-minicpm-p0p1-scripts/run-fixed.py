import json,os,re,base64,time,urllib.request,urllib.error
D=json.load(open("tmp/minicpm-p0p1/replace-text-fixed.json"))
m=re.search(r'MiniCPM_API_KEY="?([^"\n]+)"?',open(os.path.expanduser("~/.zshrc")).read()); KEY=m.group(1).strip()
os.makedirs("tmp/minicpm-p0p1/jev-fixed",exist_ok=True)
def uri(p): return "data:image/png;base64,"+base64.b64encode(open(p,"rb").read()).decode()
def post(payload):
    req=urllib.request.Request("https://api.modelbest.cn/v1/chat/completions",data=json.dumps(payload).encode(),headers={"Authorization":"Bearer "+KEY,"Content-Type":"application/json"},method="POST")
    with urllib.request.urlopen(req,timeout=180) as r: return json.loads(r.read())
out={}
for x in D:
    fp=f"tmp/minicpm-p0p1/jev-fixed/{abs(hash(x['id']))%10**12}.json"
    if os.path.exists(fp): r=json.load(open(fp))
    else:
        payload={"model":"MiniCPM-OCR-Jev","messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":uri(x['cropPath'])}},{"type":"text","text":x['correct']+"\n\n"+x['wrong']}]}],"minicpm_ocr_jev":{"mode":"score_best","category":"text","candidates":[x['correct'],x['wrong']]},"stream":False}
        try:
            d=post(payload); r=json.loads(d["choices"][0]["message"]["content"]); open(fp,"w").write(json.dumps(r,ensure_ascii=False))
        except urllib.error.HTTPError as e:
            print("SKIP",e.code,x["id"],e.read().decode()[:200]); continue
    out[x["id"]]=r
    print(x["id"],"scores",r.get("scores"),"best",r.get("best_index"),"|",x["correct"][:50])
json.dump(out,open("tmp/minicpm-p0p1/replace-text-fixed-results.json","w"),ensure_ascii=False,indent=2)
# update real-results
R=json.load(open("tmp/minicpm-p0p1/real-results.json"))
for y in R["results"]:
    if y["id"] in out:
        r=out[y["id"]]; y["scores"]=r.get("scores"); y["verdicts"]=r.get("verdicts"); y["best_index"]=r.get("best_index"); y["fixed_crop"]=True
json.dump(R,open("tmp/minicpm-p0p1/real-results-fixed.json","w"),ensure_ascii=False,indent=2)
print("updated",len(out))
