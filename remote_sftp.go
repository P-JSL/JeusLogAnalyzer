package main

import (
 "context"
 "crypto/subtle"
 "encoding/json"
 "errors"
 "io"
 "net"
 "net/http"
 "os"
 "path"
 "regexp"
 "strings"
 "time"

 "github.com/pkg/sftp"
 "golang.org/x/crypto/ssh"
)

// Remote SFTP access is strictly limited to SSH's SFTP subsystem and to
// Stat/Lstat/Open/ReadAt. No shell, exec, upload, modify, chmod or delete API
// is exposed. Remote OS privileges must still be restricted by the server admin.
type remoteTailRequest struct {
 Host string `json:"host"`
 Port int `json:"port"`
 User string `json:"user"`
 Password string `json:"password"`
 Fingerprint string `json:"fingerprint"`
 Path string `json:"path"`
 MaxBytes int64 `json:"maxBytes"`
}

var remoteHostname = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$`)
var remoteFingerprint = regexp.MustCompile(`^SHA256:[A-Za-z0-9+/]{35,50}$`)

// Allow common middleware text logs, dated rotations, and extensionless syslogs.
// Do not expose arbitrary configuration or compressed/binary files.
var remoteLogFilename = regexp.MustCompile(`(?i)^(?:[^/]+\.(?:log|out|txt|trace|err|error|audit|jsonl|ndjson)(?:[._-][0-9][0-9A-Za-z._-]{0,31})?|(?:access_log|error_log|syslog|messages|secure|maillog)(?:[._-][0-9][0-9A-Za-z._-]{0,31})?)$`)

func validateRemoteTail(v remoteTailRequest) error {
 if !remoteHostname.MatchString(v.Host) && net.ParseIP(v.Host)==nil {return errors.New("잘못된 서버 주소입니다")}
 if v.Port<1 || v.Port>65535 {return errors.New("SSH 포트가 올바르지 않습니다")}
 if len(v.User)==0 || len(v.User)>128 || strings.ContainsAny(v.User,"\r\n\x00") {return errors.New("잘못된 사용자명입니다")}
 if len(v.Password)==0 || len(v.Password)>1024 {return errors.New("비밀번호를 확인해 주세요")}
 if !remoteFingerprint.MatchString(v.Fingerprint) {return errors.New("서버 SSH 호스트키의 SHA256 지문을 입력해야 합니다")}
 if len(v.Path)==0 || len(v.Path)>2048 || !strings.HasPrefix(v.Path,"/") || strings.ContainsAny(v.Path,"\\\x00\r\n") {return errors.New("절대 로그 경로를 입력해 주세요")}
 for _,segment:=range strings.Split(v.Path,"/"){if segment==".." || segment=="." {return errors.New("경로 이동은 허용하지 않습니다")}}
 if path.Clean(v.Path)!=v.Path {return errors.New("정규화된 절대 경로를 입력해 주세요")}
 name:=strings.ToLower(path.Base(v.Path))
 for _,compressed:=range []string{".gz",".zip",".bz2",".xz",".zst",".7z"} {
  if strings.HasSuffix(name,compressed){return errors.New("압축 로그는 텍스트 미리보기에서 지원하지 않습니다")}
 }
 if !remoteLogFilename.MatchString(name) {
  return errors.New("지원하는 텍스트 로그(.log/.out/.txt/.trace/.err, access_log, syslog 등)만 읽을 수 있습니다. 압축 파일은 지원하지 않습니다")
 }
 if v.MaxBytes<1||v.MaxBytes>512*1024 {return errors.New("한 번에 최대 512KiB만 조회할 수 있습니다")}
 return nil
}

func remoteTail(w http.ResponseWriter,r *http.Request) {
 if r.Method!=http.MethodPost {apiError(w,"POST only",http.StatusMethodNotAllowed);return}
 r.Body=http.MaxBytesReader(w,r.Body,8192)
 var q remoteTailRequest
 dec:=json.NewDecoder(r.Body)
 if err:=dec.Decode(&q);err!=nil {apiError(w,"잘못된 SSH 요청입니다",400);return}
 if err:=validateRemoteTail(q);err!=nil {apiError(w,err.Error(),400);return}
 ctx,cancel:=context.WithTimeout(r.Context(),20*time.Second)
 defer cancel()
 target:=net.JoinHostPort(q.Host,strconv.Itoa(q.Port))
 conn,err:=(&net.Dialer{Timeout:8*time.Second}).DialContext(ctx,"tcp",target)
 if err!=nil {apiError(w,"SSH 서버에 연결할 수 없습니다",502);return}
 defer conn.Close()
 // Cover handshake, authentication and bounded SFTP read.
 _=conn.SetDeadline(time.Now().Add(19*time.Second))
 hostKey:=func(_ string,_ net.Addr,key ssh.PublicKey)error{
  observed:=ssh.FingerprintSHA256(key)
  if subtle.ConstantTimeCompare([]byte(observed),[]byte(q.Fingerprint))!=1 {
   return errors.New("SSH 서버 호스트키 지문이 일치하지 않습니다")
  }
  return nil
 }
 cfg:=&ssh.ClientConfig{User:q.User,Auth:[]ssh.AuthMethod{ssh.Password(q.Password)},HostKeyCallback:hostKey,Timeout:8*time.Second}
 sshConn,chans,requests,err:=ssh.NewClientConn(conn,target,cfg)
 if err!=nil {apiError(w,"SSH 인증 또는 호스트키 검증에 실패했습니다",403);return}
 sshClient:=ssh.NewClient(sshConn,chans,requests)
 defer sshClient.Close()
 client,err:=sftp.NewClient(sshClient)
 if err!=nil {apiError(w,"SFTP 읽기 전용 연결을 시작할 수 없습니다",502);return}
 defer client.Close()
 info,err:=client.Lstat(q.Path)
 if err!=nil {apiError(w,"원격 로그 파일을 조회할 수 없습니다",404);return}
 if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink!=0 {apiError(w,"일반 로그 파일만 조회할 수 있습니다",400);return}
 file,err:=client.Open(q.Path) // Open is read-only: never OpenFile(O_WRONLY/O_RDWR/O_CREATE).
 if err!=nil {apiError(w,"원격 로그를 읽을 수 없습니다",403);return}
 defer file.Close()
 size:=info.Size()
 start:=size-q.MaxBytes
 if start<0{start=0}
 count:=size-start
 if count<0 || count>512*1024 {apiError(w,"잘못된 원격 파일 크기입니다",400);return}
 buf:=make([]byte,int(count))
 n,e:=file.ReadAt(buf,start)
 if e!=nil && e!=io.EOF {apiError(w,"원격 로그 읽기에 실패했습니다",502);return}
 buf=buf[:n]
 // Content is returned only to the local browser, never to a persistent index.
 jsonReply(w,struct{
  Size int64 `json:"size"`
  Offset int64 `json:"offset"`
  Data []byte `json:"data"`
  Partial bool `json:"partial"`
 }{Size:size,Offset:start,Data:buf,Partial:start>0})
}
