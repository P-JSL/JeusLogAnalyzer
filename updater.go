package main

import (
 "context"
 "crypto/sha256"
 "encoding/base64"
 "encoding/hex"
 "encoding/json"
 "errors"
 "fmt"
 "io"
 "net/http"
 "os"
 "os/exec"
 "path/filepath"
 "runtime"
 "strconv"
 "strings"
 "time"
 "unicode/utf16"
)

const currentAppVersion="1.0.5"
const gitHubRepoAPI="https://api.github.com/repos/P-JSL/JeusLogAnalyzer"
const goReleaseAsset="JEUS_Lens_Windows_x64.exe"
const updateSizeLimit int64=120*1024*1024

type updateInput struct{Token string; Auto bool}
type updateAsset struct{Name string;Digest string;Size int64;ID int64}
type updateReleaseData struct{Version string;Tag string;Asset updateAsset}
func updateError(w http.ResponseWriter,code int,message string){apiError(w,message,code)}
func updateVersion(tag string)([3]int,bool){
 var out [3]int
 tag=strings.TrimPrefix(tag,"v")
 if strings.ContainsAny(tag,"+-") {return out,false}
 parts:=strings.Split(tag,".");if len(parts)!=3{return out,false}
 for i,p:=range parts{n,err:=strconv.Atoi(p);if err!=nil||n<0||n>9999{return out,false};out[i]=n}
 return out,true
}
func newerVersion(tag string)bool{
 latest,ok:=updateVersion(tag);if !ok{return false}
 current,_:=updateVersion(currentAppVersion)
 for i:=0;i<3;i++{if latest[i]>current[i]{return true};if latest[i]<current[i]{return false}}
 return false
}
func releaseLookup(ctx context.Context,token string)(updateReleaseData,error){
 var none updateReleaseData
 if len(token)>2048||strings.ContainsAny(token,"\r\n"){return none,errors.New("GitHub 인증 토큰 형식이 잘못되었습니다")}
 req,err:=http.NewRequestWithContext(ctx,"GET",gitHubRepoAPI+"/releases/latest",nil)
 if err!=nil{return none,errors.New("릴리즈 요청 생성 실패")}
 req.Header.Set("Accept","application/vnd.github+json");req.Header.Set("User-Agent","JEUS-Lens-LocalUpdater/1.0.5")
 req.Header.Set("X-GitHub-Api-Version","2022-11-28")
 if token!=""{req.Header.Set("Authorization","Bearer "+token)}
 client:=&http.Client{Timeout:18*time.Second}
 resp,err:=client.Do(req);if err!=nil{return none,errors.New("GitHub 연결 실패. 네트워크 또는 TLS 설정을 확인하세요")}
 defer resp.Body.Close()
 if resp.StatusCode==404||resp.StatusCode==401||resp.StatusCode==403{return none,errors.New("릴리즈 조회 권한이 없습니다. Private 저장소에 접근 가능한 Fine-grained GitHub 토큰(Contents: Read)을 입력하세요")}
 if resp.StatusCode!=200{return none,fmt.Errorf("GitHub 릴리즈 조회 실패 (HTTP %d)",resp.StatusCode)}
 var raw map[string]any
 if json.NewDecoder(io.LimitReader(resp.Body,2<<20)).Decode(&raw)!=nil{return none,errors.New("GitHub 릴리즈 응답 형식이 올바르지 않습니다")}
 if raw["draft"]==true||raw["prerelease"]==true{return none,errors.New("정식 릴리즈가 아닙니다")}
 tag,_:=raw["tag_name"].(string)
 if _,ok:=updateVersion(tag);!ok{return none,errors.New("릴리즈 태그 형식이 지원되지 않습니다")}
 assets,ok:=raw["assets"].([]any);if !ok{return none,errors.New("릴리즈 자산 목록이 없습니다")}
 var target updateAsset
 for _,value:=range assets{
  obj,ok:=value.(map[string]any);if !ok{continue}
  if obj["name"]!=goReleaseAsset{continue}
  target.Name=goReleaseAsset;target.Digest,_=obj["digest"].(string)
  size,_:=obj["size"].(float64);id,_:=obj["id"].(float64)
  target.Size=int64(size);target.ID=int64(id);break
 }
 if target.ID<=0||target.Size<=0||target.Size>updateSizeLimit{return none,errors.New("이 플랫폼에 적합한 릴리즈 실행 파일을 찾을 수 없습니다")}
 digest:=strings.TrimPrefix(target.Digest,"sha256:")
 if !strings.HasPrefix(target.Digest,"sha256:")||len(digest)!=64{return none,errors.New("업데이트 실행 파일의 GitHub SHA-256 무결성 정보가 없습니다")}
 if _,err:=hex.DecodeString(digest);err!=nil{return none,errors.New("잘못된 SHA-256 무결성 정보입니다")}
 return updateReleaseData{Tag:tag,Version:strings.TrimPrefix(tag,"v"),Asset:target},nil
}
func updateRequest(w http.ResponseWriter,r *http.Request)(updateInput,bool){
 if r.Method!="POST"{updateError(w,405,"POST only");return updateInput{},false}
 r.Body=http.MaxBytesReader(w,r.Body,4096)
 var q updateInput
 if json.NewDecoder(r.Body).Decode(&q)!=nil{updateError(w,400,"업데이트 요청이 올바르지 않습니다");return q,false}
 return q,true
}
func updateCheck(w http.ResponseWriter,r *http.Request){
 q,ok:=updateRequest(w,r);if !ok{return}
 ctx,cancel:=context.WithTimeout(r.Context(),20*time.Second);defer cancel()
 rel,err:=releaseLookup(ctx,q.Token)
 if err!=nil{updateError(w,502,err.Error());return}
 jsonReply(w,map[string]any{"currentVersion":currentAppVersion,"latestVersion":rel.Version,"updateAvailable":newerVersion(rel.Tag),"asset":rel.Asset.Name,"size":rel.Asset.Size,"runtime":"go","installSupported":runtime.GOOS=="windows"})
}
func updateApply(w http.ResponseWriter,r *http.Request){
 q,ok:=updateRequest(w,r);if !ok{return}
 if runtime.GOOS!="windows"{updateError(w,501,"자동 설치는 Windows 실행 파일에서만 지원합니다");return}
 ctx,cancel:=context.WithTimeout(r.Context(),90*time.Second);defer cancel()
 rel,err:=releaseLookup(ctx,q.Token)
 if err!=nil{updateError(w,502,err.Error());return}
 if !newerVersion(rel.Tag){updateError(w,409,"현재 버전이 최신 버전입니다");return}
 executable,err:=os.Executable();if err!=nil{updateError(w,500,"현재 실행 파일 경로를 확인할 수 없습니다");return}
 executable,err=filepath.EvalSymlinks(executable);if err!=nil{updateError(w,500,"실행 파일 경로를 검증하지 못했습니다");return}
 directory:=filepath.Dir(executable)
 temp,err:=os.CreateTemp(directory,".jeus-update-*.exe")
 if err!=nil{updateError(w,403,"프로그램 설치 폴더에 업데이트 파일을 만들 권한이 없습니다");return}
 stage:=temp.Name();defer func(){_ = temp.Close();_ = os.Remove(stage)}()
 req,err:=http.NewRequestWithContext(ctx,"GET",gitHubRepoAPI+"/releases/assets/"+strconv.FormatInt(rel.Asset.ID,10),nil)
 if err!=nil{updateError(w,500,"다운로드 요청 생성 실패");return}
 req.Header.Set("Accept","application/octet-stream");req.Header.Set("User-Agent","JEUS-Lens-LocalUpdater/1.0.5")
 if q.Token!=""{req.Header.Set("Authorization","Bearer "+q.Token)}
 resp,err:=(&http.Client{Timeout:75*time.Second}).Do(req)
 if err!=nil{updateError(w,502,"업데이트 실행 파일 다운로드에 실패했습니다");return}
 defer resp.Body.Close()
 if resp.StatusCode!=200{updateError(w,502,fmt.Sprintf("GitHub 실행 파일 다운로드 실패 (HTTP %d)",resp.StatusCode));return}
 hash:=sha256.New()
 copied,err:=io.Copy(io.MultiWriter(temp,hash),io.LimitReader(resp.Body,updateSizeLimit+1))
 if err!=nil||copied!=rel.Asset.Size||copied>updateSizeLimit{updateError(w,502,"업데이트 실행 파일이 불완전하거나 크기가 일치하지 않습니다");return}
 expected:=strings.TrimPrefix(rel.Asset.Digest,"sha256:")
 if !strings.EqualFold(hex.EncodeToString(hash.Sum(nil)),expected){updateError(w,409,"SHA-256 검증 실패: 업데이트를 취소했습니다");return}
 if err:=temp.Sync();err!=nil{updateError(w,500,"업데이트 파일 디스크 저장에 실패했습니다");return}
 if err:=temp.Close();err!=nil{updateError(w,500,"업데이트 파일 저장을 완료하지 못했습니다");return}
 file,err:=os.Open(stage)
 if err!=nil{updateError(w,500,"실행 파일 확인 실패");return}
 signature:=make([]byte,2);_,err=io.ReadFull(file,signature);_ = file.Close()
 if err!=nil||string(signature)!="MZ"{updateError(w,409,"다운로드 파일은 Windows 실행 파일 형식이 아닙니다");return}
 // The updater subprocess never receives the GitHub token. Literal paths are
 // PowerShell-escaped and all paths are from the current executable or TempFile.
 quote:=func(x string)string{return "'"+strings.ReplaceAll(x,"'","''")+"'"}
 pid:=os.Getpid()
 backup:=executable+".update-backup"
 script:=fmt.Sprintf("$ErrorActionPreference='Stop';$old=%s;$next=%s;$back=%s;$appId=%d; for($i=0;$i -lt 90;$i++){if(Get-Process -Id $appId -ErrorAction SilentlyContinue){Start-Sleep -Milliseconds 500;continue};try{if(Test-Path -LiteralPath $back){Remove-Item -LiteralPath $back -Force};Move-Item -LiteralPath $old -Destination $back -Force;try{Move-Item -LiteralPath $next -Destination $old -Force;Start-Process -FilePath $old;Remove-Item -LiteralPath $back -Force -ErrorAction SilentlyContinue;exit 0}catch{if(Test-Path -LiteralPath $back){Move-Item -LiteralPath $back -Destination $old -Force};throw}}catch{Start-Sleep -Milliseconds 500}};exit 1",quote(executable),quote(stage),quote(backup),pid)
 utf16script:=utf16.Encode([]rune(script));b:=make([]byte,2*len(utf16script))
 for i,n:=range utf16script{b[2*i]=byte(n);b[2*i+1]=byte(n>>8)}
 command:=exec.Command("powershell.exe","-NoProfile","-NonInteractive","-WindowStyle","Hidden","-EncodedCommand",base64.StdEncoding.EncodeToString(b))
 if err:=command.Start();err!=nil{updateError(w,500,"업데이트 적용 프로세스를 시작할 수 없습니다");return}
 // Stage must survive after this HTTP request finishes.
 stagePersist:=stage
 stage=""
 _=stagePersist
 jsonReply(w,map[string]any{"status":"installing","version":rel.Version,"message":"무결성 검증 완료. 현재 프로그램을 종료한 후 새 실행 파일로 교체해 재실행합니다."})
 time.AfterFunc(1400*time.Millisecond,func(){os.Exit(0)})
}
