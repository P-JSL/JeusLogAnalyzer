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
            # Each path represents a different middleware; same pinned SSH/SFTP
            # account and read-only protocol must work for all text-log names.
            middleware_fixtures={
                "access_20261030.log": b'10.0.0.1 [30/Oct/2026:12:30:00 +0900] "GET / HTTP/1.1" 200 123\\n',
                "webtob_access.log": b'10.0.0.1 [30/Oct/2026:12:30:00 +0900] "POST /api HTTP/1.1" 503 0\\n',
                "webtob_error.log": b'[2026/10/30 12:30:00] WebtoB ERROR service unavailable\\n',
                "webtob_system.log": b'[2026/10/30 12:30:01] WebtoB system restart\\n',
                "JeusServer.log": b'[2026.10.30 12:30:00][0] [ms1-1] [SERVER-0100] failure\\n[2026.10.30 12:30:01][1] [ms1-1] [SERVER-0101] warning\\n',
                "error_20261030.log": b'[2026/10/30 12:30] WebtoB ERROR request failed\\n',
                "system_20261030.log": b'[2026/10/30 12:30] WebtoB system start\\n',
                "access_log": b'192.168.0.1 - - [30/Oct/2026:12:30:00 +0900] "GET / HTTP/1.1" 404 0\\n',
                "syslog": b'Oct 30 12:30:00 host app[123]: warning\\n',
                "catalina.out": b'30-Oct-2026 12:30:00.123 SEVERE Tomcat startup failure\\n',
                "gc.log.0.current": b'[0.100s][info][gc] Synthetic GC event\\n'
            }
            for filename,content in middleware_fixtures.items():
                location=pathlib.Path(log_path).parent / filename
                assert not location.exists(),location
                location.write_bytes(content)
                try:
                    query={**q,"path":str(location)}
                    status,res=post(base,query)
                    assert status==200,(filename,status,res)
                    assert base64.b64decode(res["data"])==content[-512:],filename
                    stage_list=trace(base,query)
                    assert any(row.get("code")=="DONE" for row in stage_list),(filename,stage_list)
                    assert location.read_bytes()==content,filename
                finally:
                    location.unlink()
            # Bad hostnames must be rejected before SSH, identically for Go and Rust.
            for bad_host in ("-bad", "bad:host", "bad_name", "bad host"):
                status,res=post(base,{**q,"host":bad_host})
                assert status==400,(bad_host,status,res)
                events=trace(base,{**q,"host":bad_host})
                assert events[-1].get("code")=="INVALID_CONFIG",(bad_host,events)
            for filename in ("server.log.gz","server.log.1.gz","private.conf","../etc/server.log"):
                query={**q,"path":str(pathlib.Path(log_path).parent / filename)}
                status,res=post(base,query)
                assert status==400,(filename,status,res)
                events=trace(base,query)
                assert events[-1].get("code")=="INVALID_CONFIG",(filename,events)
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
