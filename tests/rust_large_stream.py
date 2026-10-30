#!/usr/bin/env python3
"""Go/Rust true 1 GiB HTTP streaming parity without constructing/storing a 1 GiB file."""
import hashlib
import http.client
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request

SIZE=1<<30
CHUNK=1024*1024
PREFIX=b"[2026.10.30 00:00:00][2] huge valid synthetic log\n  "
PAD=b"Q"*CHUNK

def start(binary,root):
    root.mkdir(parents=True,exist_ok=True)
    env=os.environ.copy()
    env["JEUS_LENS_DATA_DIR"]=str(root)
    env["JEUS_ANALYZER_NO_BROWSER"]="1"
    process=subprocess.Popen([str(pathlib.Path(binary).resolve())],cwd=root,
        env=env,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True)
    url=process.stdout.readline().strip()
    assert url.startswith("http://127.0.0.1:") and url.endswith("/"),url
    return process,url

def post_stream(url,id):
    parsed=urllib.parse.urlsplit(url)
    conn=http.client.HTTPConnection(parsed.hostname,parsed.port,timeout=900)
    route="/api/import?"+urllib.parse.urlencode({"id":id,"name":"synthetic_1GiB.log","encoding":"auto"})
    conn.putrequest("POST",route)
    conn.putheader("Origin",url.rstrip("/"))
    conn.putheader("Content-Type","application/octet-stream")
    conn.putheader("Content-Length",str(SIZE))
    conn.endheaders()
    sha=hashlib.sha256()
    conn.send(PREFIX)
    sha.update(PREFIX)
    remaining=SIZE-len(PREFIX)
    while remaining:
        block=PAD if remaining>=CHUNK else PAD[:remaining]
        conn.send(block)
        sha.update(block)
        remaining-=len(block)
    response=conn.getresponse()
    result=response.read()
    assert response.status==200,(response.status,result[:800])
    conn.close()
    summary=json.loads(result)
    assert summary["size"]==SIZE
    assert summary["sourceHash"]==sha.hexdigest()
    assert summary["stats"]["all"]==1,summary["stats"]
    return summary

def main():
    with tempfile.TemporaryDirectory() as tmp:
        roots=pathlib.Path(tmp)
        a=start(sys.argv[1],roots/"go")
        b=start(sys.argv[2],roots/"rust")
        try:
            summaries=[]
            for process,url in (a,b):
                app="go" if len(summaries)==0 else "rust"
                id=hashlib.sha256((app+" synthetic 1GiB").encode()).hexdigest()[:32]
                meta=post_stream(url,id)
                content=urllib.request.urlopen(url+f"api/index?id={id}&start=0&count=1",timeout=15).read()
                assert len(content)==24
                assert int.from_bytes(content[:8],"little")==0
                assert int.from_bytes(content[8:12],"little")==SIZE
                assert not (roots/app/id/"original.log").exists()
                summaries.append((meta,content))
                print("RUST_1GIB_STREAM_APP_PASS",app,"events",meta["stats"]["all"],flush=True)
            g,r=summaries
            for key in ("stats","lines","top","sqlTop","sqlTypes","hourly","issues","hotspots","errorSurges"):
                assert g[0].get(key)==r[0].get(key),(key,g[0].get(key),r[0].get(key))
            assert g[1]==r[1],"1GiB metadata binary difference"
            print("RUST_GO_1GIB_STREAMING_HASH_INDEX_PARITY_PASS",flush=True)
        finally:
            for p,_ in (a,b):
                p.terminate()
                try:p.wait(timeout=5)
                except subprocess.TimeoutExpired:p.kill()

if __name__=="__main__":
    main()
