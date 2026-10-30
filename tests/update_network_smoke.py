#!/usr/bin/env python3
"""GitHub-connected private release check for both compiled Go and Rust servers.
The read-only CI token is sent only in a local POST body; it is never logged.
"""
import json,os,pathlib,subprocess,sys,tempfile,urllib.request,urllib.error
def invoke(binary,root,token):
    root.mkdir()
    env=os.environ.copy();env["JEUS_LENS_DATA_DIR"]=str(root);env["JEUS_ANALYZER_NO_BROWSER"]="1"
    proc=subprocess.Popen([str(pathlib.Path(binary).resolve())],cwd=root,env=env,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True)
    base=proc.stdout.readline().strip().rstrip("/")
    assert base.startswith("http://127.0.0.1:"),base
    try:
        req=urllib.request.Request(base+"/api/update/check",method="POST",
          data=json.dumps({"token":token}).encode(),headers={"Content-Type":"application/json","Origin":base})
        with urllib.request.urlopen(req,timeout=25) as resp:
            value=json.loads(resp.read())
        assert value["currentVersion"]=="1.0.2",value
        assert value["asset"].endswith(".exe"),value
        assert value["size"]>0,value
        assert value["runtime"] in ("go","rust")
        print("UPDATE_PRIVATE_GITHUB_READONLY_CHECK_PASS",value["runtime"],value["latestVersion"],flush=True)
    finally:
        proc.terminate()
        try:proc.wait(timeout=5)
        except subprocess.TimeoutExpired:proc.kill()
def main():
    token=os.environ.get("GH_TOKEN","")
    if not token:raise SystemExit("CI GitHub read token missing")
    with tempfile.TemporaryDirectory() as path:
        for n,binary in enumerate(sys.argv[1:3]):
            invoke(binary,pathlib.Path(path)/str(n),token)
if __name__=="__main__":main()
