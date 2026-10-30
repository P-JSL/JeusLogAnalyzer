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
