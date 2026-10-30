#!/usr/bin/env python3
"""Black-box Go vs native Rust API parity: actual independent server processes."""
import hashlib, json, os, pathlib, subprocess, sys, tempfile, time
import urllib.request, urllib.error

def http(url, route, method="GET", data=None, as_json=True):
    req=urllib.request.Request(url.rstrip('/')+route, data=data, method=method)
    if method=="POST":req.add_header("Origin",url[:-1])
    if as_json and data is not None:req.add_header("Content-Type","application/json")
    try:
        with urllib.request.urlopen(req,timeout=25) as response:
            body=response.read()
            return json.loads(body) if as_json else body
    except urllib.error.HTTPError as e:
        raise AssertionError((route, e.code,e.read()[:300])) from e

def run(app,root):
    env=os.environ.copy()
    env["JEUS_LENS_DATA_DIR"]=str(root)
    env["JEUS_ANALYZER_NO_BROWSER"]="1"
    root.mkdir(parents=True,exist_ok=True)
    app=subprocess.Popen([str(pathlib.Path(app).resolve())],cwd=root,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env)
    line=app.stdout.readline().strip()
    assert line.startswith("http://127.0.0.1:") and line.endswith("/"),(line,app.poll())
    return app,line

def fixture():
    lines=[
    "[2026.10.23 09:01:01][2] [ms1-1] [SERVER-0001] ready",
    "[2026.10.23 09:01:02][0] [ms1-1] [APP-0002] transaction failed",
    "java.lang.RuntimeException: wrapped",
    "  at demo.Thing.execute(Thing.java:24)",
    "Caused by: org.springframework.jdbc.BadSqlGrammarException: SQL error",
    "Caused by: java.sql.SQLSyntaxErrorException: ORA-00904: invalid column",
    "  at oracle.jdbc.ThinDriver.getConnection(ThinDriver.java:1)",
    "[2026.10.23 09:01:03][1] [ms1-1] [APP-0003] slow response",
    "2026-10-23 10:00:02,500 ERROR java.lang.NullPointerException",
    "[2026-10-23 10:00:03.000][INFO][W-1][102][TRACE001][Request][SQLService] - failed",
    "Caused by: java.sql.SQLException: ORA-12899",
    "[2026-10-23 10:00:04.000][ERROR][W-1][102][TRACE001][Request][SQLService] - fatal",
    ""]
    return "\n".join(lines).encode()

def surge():
    logs=[]
    for i in range(12):
        for j in range(25):
            typ="0" if j==0 else "2"
            logs.append(f"[2026.10.23 10:{i*5:02}:{j%60:02}][{typ}] event trace marker=TEST")
    for j in range(30):
        typ="0" if j<15 else "2"
        logs.append(f"[2026.10.23 11:00:{j:02}][{typ}] event marker=TEST")
    return ("\n".join(logs)+"\n").encode()

def utf16():
    log="[2026.10.23 10:00:00][2] prepared\n[2026.10.23 10:00:01][0] java.sql.SQLException: ORA-00001\nCaused by: java.sql.SQLIntegrityConstraintViolationException\n"
    return b"\xff\xfe"+log.encode("utf-16le")
def check_one(name,blob,encoding,go,rust):
    id=hashlib.md5((name+str(len(blob))).encode()).hexdigest()
    entries=[]
    for app,url in [go,rust]:
        import urllib.parse
        route="/api/import?"+urllib.parse.urlencode({"id":id,"name":name+".log","encoding":encoding})
        meta=http(url,route,method="POST",data=blob,as_json=False)
        meta=json.loads(meta)
        assert meta["sourceHash"]==hashlib.sha256(blob).hexdigest()
        assert meta["size"]==len(blob)
        assert meta["storageMode"]=="metadata-only"
        stored=http(url,"/api/archives")
        assert stored["items"][0]["id"]==id
        n=meta["stats"]["all"]
        raw=http(url,f"/api/index?id={id}&start=0&count={n}",as_json=False)
        assert len(raw)==n*24
        allpage=http(url,f"/api/page?id={id}&filterId=all&page=1")
        assert allpage["total"]==n
        for g in ["sql","sql:1","sql:2","error","review","warning","info","otherError"]:
            fid=http(url,"/api/filter",method="POST",data=json.dumps({"id":id,"group":g,"query":""}).encode())
            page=http(url,f"/api/page?id={id}&filterId={fid['filterId']}&page=1")
            assert page["total"]==fid["total"]
            assert all(row["index"]<n for row in page["rows"])
        indices=[0,n-1] if n>1 else [0]
        rows=http(url,"/api/page-by-ids",method="POST",data=json.dumps({"id":id,"indices":indices}).encode())
        assert [v["index"] for v in rows["rows"]]==indices
        verified=http(url,"/api/verify?id="+id,method="POST",data=blob,as_json=False)
        assert json.loads(verified)["sourceHash"]==meta["sourceHash"]
        entries.append((meta,raw,allpage))
    g,r=entries
    keys=["stats","lines","sqlTop","sqlTypes","top","hourly","issues","hotspots","hotspotLimited","errorSurges","issueVersion"]
    for k in keys:
        if g[0].get(k)!=r[0].get(k):
            raise AssertionError(f"{name} mismatch {k}\nGo: {json.dumps(g[0].get(k),ensure_ascii=False)[:700]}\nRust: {json.dumps(r[0].get(k),ensure_ascii=False)[:700]}")
    if g[1]!=r[1]:
        idx=next((i for i,(x,y) in enumerate(zip(g[1],r[1])) if x!=y),None)
        raise AssertionError(f"{name} incompatible 24-byte index, offset {idx}, Go {g[1][idx:idx+32]!r}, Rust {r[1][idx:idx+32]!r}")
    if g[2]["rows"]!=r[2]["rows"]:
        raise AssertionError(f"{name} incompatible page rows")
    print("RUST_GO_PARITY_PASS", name, "events",g[0]["stats"]["all"],"bytes",len(blob),flush=True)

def main():
    with tempfile.TemporaryDirectory() as d:
        root=pathlib.Path(d)
        a=run(sys.argv[1],root/"go")
        b=run(sys.argv[2],root/"rust")
        try:
            for test in [("nested",fixture(),"auto"),("surge",surge(),"auto"),("utf16",utf16(),"auto")]:
                check_one(*test,a,b)
            cp=(pathlib.Path(__file__).resolve().parent/"sample_cp949.log").read_bytes()
            check_one("cp949",cp,"euc-kr",a,b)
        finally:
            for proc,_ in (a,b):
                proc.terminate()
                try:proc.wait(timeout=5)
                except subprocess.TimeoutExpired:proc.kill()
if __name__=="__main__":
    main()
