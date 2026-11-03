package main
import (
 "encoding/json"
 "net/http"
 "net/http/httptest"
 "strings"
 "testing"
)
func TestNativeUpdateVersionOrdering(t *testing.T){
 table:=[]struct{tag string;updated bool}{
  {"v1.0.5",true},{"v1.1.0",true},{"v2.0.0",true},
  {"v1.0.4",false},{"v1.0.3",false},{"v1.0.2",false},{"1.0.1",false},
  {"v1.0.5-rc1",false},{"not-a-version",false},
 }
 for _,x:=range table{if newerVersion(x.tag)!=x.updated{t.Errorf("%s: expected %t",x.tag,x.updated)}}
}
func TestRemoteTraceInvalidAndNoCredentials(t *testing.T){
 cases:=[]string{
  `{"host":"127.0.0.1","port":22,"user":"readonly","password":"never-log-me","fingerprint":"","path":"/var/log/server.log","maxBytes":524288}`,
  `{"host":"example;rm -rf","port":22,"user":"readonly","password":"never-log-me","fingerprint":"SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","path":"/logs/server.log","maxBytes":524288}`,
 }
 for _,body:=range cases{
  w:=httptest.NewRecorder();r:=httptest.NewRequest(http.MethodPost,"/api/remote-trace",strings.NewReader(body))
  remoteTrace(w,r)
  if w.Code!=200{t.Fatalf("unexpected trace HTTP %d: %s",w.Code,w.Body.String())}
  if !strings.Contains(w.Body.String(),`"level":"error"`){t.Errorf("error frame missing: %s",w.Body.String())}
  if strings.Contains(w.Body.String(),"never-log-me"){t.Fatal("credential was leaked in SFTP trace")}
  for _,line:=range strings.Split(strings.TrimSpace(w.Body.String()),"\n"){
   var record map[string]any
   if err:=json.Unmarshal([]byte(line),&record);err!=nil{t.Errorf("invalid NDJSON: %v",err)}
  }
 }
}
func TestAutoUpdateRejectsMalformedTokenBeforeNetwork(t *testing.T){
 w:=httptest.NewRecorder();r:=httptest.NewRequest(http.MethodPost,"/api/update/check",strings.NewReader("{\"token\":\"bad\\ncontent\"}"))
 updateCheck(w,r)
 if w.Code==200{t.Fatal("malformed update request must be rejected")}
}
