#!/usr/bin/env python3
"""Side-by-side reproducible Rust baseline/optimized HTTP benchmark (descriptive, not pass/fail timing)."""
import hashlib
import http.client
import json
import os
import pathlib
import statistics
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request

EVENTS=250_000
# Large-line fixture exposes byte-at-a-time scanner costs.
LONG_BYTES=128*1024*1024
SHORT_LOG=(b"[2026.10.23 09:00:00][0] SQLException ORA-00904 constant evidence\n"
           b"Caused by: java.sql.SQLException ORA-00904\n")
SHORT_SOURCE=SHORT_LOG*EVENTS
LONG_SOURCE=b"[2026.10.23 09:00:00][2] synthetic very long line\n"+b"x"*(LONG_BYTES-54)

def launch(binary,root):
    root.mkdir(parents=True,exist_ok=True)
    env=os.environ.copy()
    env["JEUS_LENS_DATA_DIR"]=str(root)
    env["JEUS_ANALYZER_NO_BROWSER"]="1"
    proc=subprocess.Popen([str(pathlib.Path(binary).resolve())],cwd=root,env=env,
                          stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True)
    base=proc.stdout.readline().strip()
    assert base.startswith("http://127.0.0.1:"),base
    return proc,base

def post(base,route,payload,content_type):
    parts=urllib.parse.urlsplit(base)
    con=http.client.HTTPConnection(parts.hostname,parts.port,timeout=300)
    con.request("POST",route,body=payload,
                headers={"Origin":base.rstrip("/"),"Content-Type":content_type})
    resp=con.getresponse()
    body=resp.read()
    if resp.status!=200:raise RuntimeError((resp.status,body[:1000]))
    con.close()
    return json.loads(body)

def get_bytes(base,path):
    with urllib.request.urlopen(base+path,timeout=120) as response:
        return response.read()

def run(binary,root):
    proc,base=launch(binary,root)
    results={}
    try:
        for label,data in [("dense",SHORT_SOURCE),("long",LONG_SOURCE)]:
            sid=hashlib.sha256((str(binary)+label).encode()).hexdigest()[:32]
            route="/api/import?"+urllib.parse.urlencode({"id":sid,"name":"fixture.log","encoding":"auto"})
            start=time.perf_counter()
            summary=post(base,route,data,"application/octet-stream")
            results[label+"_import_s"]=round(time.perf_counter()-start,4)
            assert summary["sourceHash"]==hashlib.sha256(data).hexdigest()
            results[label+"_stats"]=summary["stats"]
            if label=="dense":
                baseline=get_bytes(base,"api/index?id="+sid+"&start=0&count=50000")
                results["index_prefix_sha256"]=hashlib.sha256(baseline).hexdigest()
                for group in ["sql","error","review","warning","info"]:
                    request=json.dumps({"id":sid,"group":group,"query":""}).encode()
                    start=time.perf_counter()
                    filtered=post(base,"/api/filter",request,"application/json")
                    elapsed=time.perf_counter()-start
                    results[group+"_filter_s"]=round(elapsed,4)
                    results[group+"_count"]=filtered["total"]
                    if filtered["total"]:
                        first=json.loads(get_bytes(base,
                            "api/page?id="+sid+"&filterId="+filtered["filterId"]+"&page=1"))
                        results[group+"_first_row"]=first["rows"][0]
                start=time.perf_counter()
                for page in range(1,31):
                    json.loads(get_bytes(base,f"api/page?id={sid}&filterId=all&page={page}"))
                results["30_pages_s"]=round(time.perf_counter()-start,4)
        return results
    finally:
        proc.terminate()
        try:proc.wait(timeout=5)
        except subprocess.TimeoutExpired:proc.kill()

def main():
    with tempfile.TemporaryDirectory() as d:
        root=pathlib.Path(d)
        original=run(sys.argv[1],root/"baseline")
        improved=run(sys.argv[2],root/"optimized")
        for key in original:
            if key.endswith("_s"):continue
            assert original[key]==improved.get(key),(key,original[key],improved.get(key))
        print("RUST_SPEED_BENCHMARK_OPERATIONS",json.dumps({"events":EVENTS,"long_bytes":len(LONG_SOURCE)}),flush=True)
        print("RUST_SPEED_BENCHMARK_BASELINE",json.dumps(original,ensure_ascii=False),flush=True)
        print("RUST_SPEED_BENCHMARK_OPTIMIZED",json.dumps(improved,ensure_ascii=False),flush=True)
        for key in sorted(k for k in original if k.endswith("_s")):
            old,new=original[key],improved[key]
            if new>0:
                print(f"RUST_SPEED_RESULT {key}: before={old:.4f}s after={new:.4f}s speedup={old/new:.2f}x",flush=True)
        print("RUST_BENCHMARK_IDENTICAL_OUTPUTS_PASS",flush=True)

if __name__=="__main__":
    main()
