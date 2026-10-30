#!/usr/bin/env python3
"""Execute a real Rust Windows EXE and exercise its loopback HTTP API."""
import hashlib
import json
import os
import pathlib
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request


def req(base, route, method="GET", body=None, origin=True):
    headers={}
    if method=="POST" and origin:
        headers["Origin"]=base
    if body is not None:
        headers["Content-Type"]="application/octet-stream" if isinstance(body,bytes) else "application/json"
        if not isinstance(body,bytes):
            body=json.dumps(body).encode()
    request=urllib.request.Request(base+route, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request,timeout=15) as response:
            return response.status,dict(response.headers),response.read()
    except urllib.error.HTTPError as error:
        return error.code,dict(error.headers),error.read()


def main():
    exe=pathlib.Path(sys.argv[1]).resolve()
    assert exe.is_file(),exe
    with tempfile.TemporaryDirectory() as root:
        with socket.socket() as sock:
            sock.bind(("127.0.0.1",0))
            port=sock.getsockname()[1]
        env=os.environ.copy()
        env["JEUS_LENS_TEST_PORT"]=str(port)
        env["JEUS_ANALYZER_NO_BROWSER"]="1"
        env["JEUS_LENS_DATA_DIR"]=str(pathlib.Path(root)/"analysis")
        p=subprocess.Popen([str(exe)],env=env,cwd=root,
                           stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        base=f"http://127.0.0.1:{port}"
        try:
            for _ in range(100):
                if p.poll() is not None:
                    raise RuntimeError("Rust Windows process exited prematurely")
                try:
                    status,headers,raw=req(base,"/api/archives")
                    if status==200:
                        break
                except Exception:
                    time.sleep(.15)
            else:
                raise TimeoutError("Windows Rust loopback did not open")
            assert "X-Frame-Options" in headers,headers
            assert json.loads(raw)["items"]==[]
            status,_,html=req(base,"/")
            assert status==200 and b"JEUS" in html
            status,_,js=req(base,"/app.js")
            assert status==200 and b"function" in js
            status,_,_=req(base,"/api/archives",origin=False)
            assert status==200
            sample=("[2026.10.23 09:01:01][0] java.sql.SQLException: ORA-00904\n"
                    "Caused by: java.sql.SQLSyntaxErrorException: ORA-00904\n"
                    "[2026.10.23 09:01:02][2] healthy\n").encode()
            sid="aabbccddeeff00112233445566778899"
            status,_,raw=req(base,f"/api/import?id={sid}&name=test.log&encoding=auto",
                             method="POST",body=sample)
            assert status==200,(status,raw[:1500])
            summary=json.loads(raw)
            assert summary["stats"]["all"]==2,summary["stats"]
            assert summary["stats"]["sql"]==1,summary["stats"]
            assert summary["sourceHash"]==hashlib.sha256(sample).hexdigest()
            assert not (pathlib.Path(root)/"analysis"/sid/"original.log").exists()
            status,_,idx=req(base,f"/api/index?id={sid}&start=0&count=2")
            assert status==200 and len(idx)==48,(status,len(idx))
            status,_,body=req(base,"/api/filter",method="POST",body={"id":sid,"group":"sql","query":""})
            assert status==200,(status,body)
            filt=json.loads(body)
            assert filt["total"]==1
            status,_,body=req(base,f"/api/page?id={sid}&filterId={filt['filterId']}&page=1")
            assert status==200 and json.loads(body)["total"]==1
            status,_,body=req(base,f"/api/verify?id={sid}",method="POST",body=sample)
            assert status==200,(status,body)
            status,_,body=req(base,f"/api/page-by-ids",method="POST",body={"id":sid,"indices":[0,1]})
            assert status==200 and len(json.loads(body)["rows"])==2
            status,_,body=req(base,"/api/delete",method="POST",body={"id":sid})
            assert status==200 and json.loads(body)["deleted"] is True
            status,_,body=req(base,"/api/archives")
            assert status==200 and json.loads(body)["items"]==[]
            status,_,body=req(base,"/api/remote-tail",method="POST",
                body={"host":"127.0.0.1","port":22,"user":"readonly","password":"x",
                      "fingerprint":"","path":"/tmp/server.log","maxBytes":524288})
            assert status==400,(status,body[:400])
            # Prevent cross-site POST, verify no write on disallowed origin.
            request=urllib.request.Request(base+"/api/delete",method="POST",
                 headers={"Origin":"https://hostile.example","Content-Type":"application/json"},
                 data=json.dumps({"id":sid}).encode())
            try:
                urllib.request.urlopen(request,timeout=10)
                raise AssertionError("CSRF request accepted")
            except urllib.error.HTTPError as error:
                assert error.code==403,error.code
            print("RUST_WINDOWS_REAL_EXE_HTTP_UI_API_SHA_INDEX_SFTP_GUARDS_PASS",flush=True)
        finally:
            p.terminate()
            try:
                p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                p.kill()
                p.wait(timeout=5)


if __name__=="__main__":
    main()
