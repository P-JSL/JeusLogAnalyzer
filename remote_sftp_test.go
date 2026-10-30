package main

import (
 "net/http"
 "net/http/httptest"
 "strings"
 "testing"
)

func remoteRequestForTest() remoteTailRequest{
 return remoteTailRequest{Host:"127.0.0.1",Port:22,User:"readonly",Password:"test",
  Fingerprint:"SHA256:AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefg",Path:"/logs/jeus-server.log",MaxBytes:512*1024}
}

func TestRemoteSFTPRejectsInvalidInputsBeforeConnecting(t *testing.T){
 base:=remoteRequestForTest()
 if e:=validateRemoteTail(base);e!=nil{t.Fatal(e)}
 cases:=[]struct{label string;edit func(*remoteTailRequest)}{
  {"host",func(v *remoteTailRequest){v.Host="localhost; rm -rf /"}},
  {"user",func(v *remoteTailRequest){v.User="a\nroot"}},
  {"host key missing",func(v *remoteTailRequest){v.Fingerprint=""}},
  {"host key invalid",func(v *remoteTailRequest){v.Fingerprint="SHA256:fake"}},
  {"traversal",func(v *remoteTailRequest){v.Path="/logs/../etc/passwd.log"}},
  {"relative path",func(v *remoteTailRequest){v.Path="../../test.log"}},
  {"remote non-log file",func(v *remoteTailRequest){v.Path="/etc/shadow"}},
  {"symlink style",func(v *remoteTailRequest){v.Path="/logs/./server.log"}},
  {"too large tail",func(v *remoteTailRequest){v.MaxBytes=1<<30}},
  {"zero tail",func(v *remoteTailRequest){v.MaxBytes=0}},
 }
 for _,c:=range cases {
  t.Run(c.label,func(t *testing.T){v:=base;c.edit(&v);if validateRemoteTail(v)==nil{t.Fatal("input must be rejected")}})
 }
}

func TestRemoteTailNeverConnectsForInvalidRequest(t *testing.T){
 r:=httptest.NewRequest(http.MethodPost,"/api/remote-tail",strings.NewReader(`{"host":"127.0.0.1","port":22,"user":"x","password":"x","fingerprint":"","path":"/tmp/server.log","maxBytes":524288}`))
 w:=httptest.NewRecorder()
 remoteTail(w,r)
 if w.Code!=http.StatusBadRequest {t.Fatalf("unexpected status %d",w.Code)}
}

func TestRemoteLogFileNamePortableMiddleware(t *testing.T){
 accepted:=[]string{
  "/opt/jeus/logs/JeusServer.log",
  "/opt/webtob/log/access_20261030.log",
  "/opt/webtob/log/error_20261030.log",
  "/opt/webtob/log/system_20261030.log",
  "/opt/webtob/webtob_system.log",
  "/var/log/nginx/access.log.1",
  "/var/log/httpd/access_log",
  "/var/log/httpd/error_log.2",
  "/var/log/syslog",
  "/var/log/messages.1",
  "/opt/tomcat/logs/catalina.out",
  "/opt/apps/gc.log.0.current",
  "/opt/apps/access.log-2026-10-30",
  "/opt/apps/server.jsonl",
 }
 rejected:=[]string{
  "/etc/shadow","/etc/passwd",
  "/var/log/archive.tar.gz",
  "/var/log/server.log.gz",
  "/var/log/server.log.1.gz",
  "/var/log/server.zip",
  "/var/log/../etc/server.log",
  "/var/log//server.log",
  "relative/access_log",
 }
 for _,p:=range accepted{v:=remoteRequestForTest();v.Path=p;if err:=validateRemoteTail(v);err!=nil{t.Errorf("should allow %q: %s",p,err)}}
 for _,p:=range rejected{v:=remoteRequestForTest();v.Path=p;if err:=validateRemoteTail(v);err==nil{t.Errorf("should reject %q",p)}}
}

func TestRemoteHostnameGoRustParity(t *testing.T){
 for _,host:=range []string{"localhost","server-01.example.com","127.0.0.1","::1","2001:db8::1","a..b"}{
  q:=remoteRequestForTest();q.Host=host;if err:=validateRemoteTail(q);err!=nil{t.Errorf("Go must allow %q: %v",host,err)}
 }
 for _,host:=range []string{"","-bad","bad_name","bad:host","a:22","host/path","bad host"}{
  q:=remoteRequestForTest();q.Host=host;if err:=validateRemoteTail(q);err==nil{t.Errorf("Go must reject %q",host)}
 }
}
