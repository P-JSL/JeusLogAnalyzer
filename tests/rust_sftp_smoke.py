#!/usr/bin/env python3
"""Exercise Rust-only pinned-hostkey SFTP against ephemeral localhost OpenSSH."""
import base64
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request


def post(base,payload):
    b=json.dumps(payload).encode()
    req=urllib.request.Request(base+"/api/remote-tail",data=b,method="POST",
         headers={"Origin":base,"Content-Type":"application/json"})
    try:
        with urllib.request.urlopen(req,timeout=30) as res:
            return res.status,json.loads(res.read())
    except urllib.error.HTTPError as e:
        return e.code,json.loads(e.read())


def trace(base,payload):
    req=urllib.request.Request(base+"/api/remote-trace",
        data=json.dumps(payload).encode(),method="POST",
        headers={"Origin":base,"Content-Type":"application/json"})
    with urllib.request.urlopen(req,timeout=30) as resp:
        assert resp.status==200,resp.status
        return [json.loads(line) for line in resp.read().splitlines() if line.strip()]


def main():
    binary=pathlib.Path(sys.argv[1]).resolve()
    port=int(sys.argv[2])
    fingerprint=sys.argv[3]
    log_path=sys.argv[4]
    user=sys.argv[5]
    password=sys.argv[6]
    with tempfile.TemporaryDirectory() as tmp:
        env=os.environ.copy()
        env["JEUS_LENS_DATA_DIR"]=tmp
        env["JEUS_ANALYZER_NO_BROWSER"]="1"
        env["JEUS_LENS_TEST_PORT"]="28733"
        base="http://127.0.0.1:28733"
        p=subprocess.Popen([str(binary)],env=env,cwd=tmp,
                           stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True)
        announced=p.stdout.readline().strip()
        assert announced.startswith("http://127.0.0.1:"),announced
        base=announced.rstrip("/")
        try:
            for _ in range(80):
                if p.poll() is not None:
                    raise RuntimeError("Rust app exited while starting")
                try:
                    urllib.request.urlopen(base+"/api/archives",timeout=2)
                    break
                except Exception:
                    time.sleep(.15)
            else:
                raise RuntimeError("Rust app unavailable")
            q={"host":"127.0.0.1","port":port,"user":user,"password":password,
               "fingerprint":fingerprint,"path":log_path,"maxBytes":512}
            frames=trace(base,q)
            codes=[f["code"] for f in frames]
            assert "DONE" in codes,codes
            assert "AUTHENTICATED" in codes,codes
            assert "READY" in codes,codes
            assert "FILE_VERIFIED" in codes,codes
            assert base64.b64decode(frames[-1]["data"])==pathlib.Path(log_path).read_bytes()[-512:]
            status,data=post(base,q)
            assert status==200,(status,data)
            decoded=base64.b64decode(data["data"])
            expected=pathlib.Path(log_path).read_bytes()
            assert decoded==expected[-512:],(len(decoded),len(expected),data)
            assert data["size"]==len(expected)
            assert data["offset"]==len(expected)-len(decoded)
            assert data["partial"]==(len(expected)>512)
            bad_frames=trace(base,{**q,"fingerprint":"SHA256:"+("A"*43)})
            assert any(f.get("code") in ("HOSTKEY_MISMATCH","HOST_KEY_MISMATCH") for f in bad_frames),bad_frames
            status,data=post(base,{**q,"fingerprint":"SHA256:"+("A"*43)})
            assert status!=200,(status,data)
            bad_frames=trace(base,{**q,"password":"incorrect-test-password"})
            assert any(f.get("code")=="AUTH_FAILED" for f in bad_frames),bad_frames
            assert "incorrect-test-password" not in json.dumps(bad_frames)
            status,data=post(base,{**q,"password":"incorrect-test-password"})
            assert status!=200,(status,data)
            symlink=str(pathlib.Path(log_path).with_name("server-link.log"))
            status,data=post(base,{**q,"path":symlink})
            assert status!=200,(status,data)
            assert pathlib.Path(log_path).read_bytes()==expected
            # File rotation between polls must pick up the new file on the next read.
            old=pathlib.Path(log_path)
            rotated=old.with_name(old.name+".1")
            old.rename(rotated)
            replacement=b"[2026-10-30][INFO] rotated log now active\\n"
            old.write_bytes(replacement)
            status,data=post(base,q)
            assert status==200,(status,data)
            assert base64.b64decode(data["data"])==replacement,(status,data)
            assert rotated.read_bytes()==expected
            print("GO_RUST_SFTP_LIVE_TRACE_READONLY_HOSTKEY_AUTH_SYMLINK_ROTATION_PASS",flush=True)
        finally:
            p.terminate()
            try:p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                p.kill()
                p.wait(timeout=5)


if __name__=="__main__":
    main()
