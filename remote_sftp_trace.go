package main
import (
 "context"
 "crypto/subtle"
 "encoding/json"
 "errors"
 "fmt"
 "io"
 "net"
 "net/http"
 "os"
 "strconv"
 "strings"
 "time"
 "github.com/pkg/sftp"
 "golang.org/x/crypto/ssh"
)
// NDJSON is flushed immediately; never persists remote secrets or trace records.
func remoteTrace(w http.ResponseWriter,r *http.Request){
 if r.Method!=http.MethodPost{apiError(w,"POST only",405);return}
 w.Header().Set("Content-Type","application/x-ndjson; charset=utf-8")
 w.Header().Set("Cache-Control","no-store")
 w.Header().Set("X-Content-Type-Options","nosniff")
 w.Header().Set("X-Accel-Buffering","no")
 flush,ok:=w.(http.Flusher);if !ok {apiError(w,"streaming unsupported",500);return}
 emit:=func(stage,level,code,msg string,other ...map[string]any){
  record:=map[string]any{"stage":stage,"level":level,"code":code,"message":msg,"time":time.Now().UTC().Format(time.RFC3339Nano)}
  if len(other)>0{for k,v:=range other[0]{record[k]=v}}
  _=json.NewEncoder(w).Encode(record);flush.Flush()
 }
 emit("request","info","START","SSH/SFTP 연결 및 조회를 시작했습니다.")
 r.Body=http.MaxBytesReader(w,r.Body,8192)
 var q remoteTailRequest
 if json.NewDecoder(r.Body).Decode(&q)!=nil{emit("validate","error","INVALID_JSON","잘못된 연결 요청 형식입니다.");return}
 if err:=validateRemoteTail(q);err!=nil{emit("validate","error","INVALID_CONFIG",err.Error());return}
 emit("validate","success","VALID","서버·계정·경로·호스트키 지문 형식을 확인했습니다.")
 ctx,cancel:=context.WithTimeout(r.Context(),20*time.Second);defer cancel()
 emit("tcp","info","CONNECTING","서버 주소를 확인하고 TCP 연결을 시도합니다.")
 target:=net.JoinHostPort(q.Host,strconv.Itoa(q.Port))
 conn,err:=(&net.Dialer{Timeout:8*time.Second}).DialContext(ctx,"tcp",target)
 if err!=nil{
  code,msg:="TCP_CONNECT","서버에 연결할 수 없습니다. 서버 실행 여부·SSH 포트·방화벽을 확인하세요."
  var dns *net.DNSError
  if errors.As(err,&dns){code="DNS_FAILURE";msg="호스트 이름을 DNS에서 확인할 수 없습니다."}
  if errors.Is(err,context.DeadlineExceeded)||errors.Is(err,os.ErrDeadlineExceeded){code="TCP_TIMEOUT";msg="TCP 연결 시간 초과: 서버·방화벽·네트워크 상태를 확인하세요."}
  if strings.Contains(strings.ToLower(err.Error()),"refused"){code="TCP_REFUSED";msg="SSH 서버가 연결을 거부했습니다. 포트와 서비스 상태를 확인하세요."}
  emit("tcp","error",code,msg);return
 }
 defer conn.Close();_=conn.SetDeadline(time.Now().Add(19*time.Second))
 emit("tcp","success","CONNECTED","TCP 소켓 연결이 성립했습니다.")
 trusted:=false
 checkKey:=func(_ string,_ net.Addr,key ssh.PublicKey)error{
  emit("hostkey","info","CHECKING","서버 공개키 SHA256 지문을 확인합니다.")
  if subtle.ConstantTimeCompare([]byte(ssh.FingerprintSHA256(key)),[]byte(q.Fingerprint))!=1{return errors.New("HOSTKEY_MISMATCH")}
  trusted=true;emit("hostkey","success","MATCHED","서버 호스트키가 등록된 지문과 일치합니다.");return nil
 }
 emit("ssh","info","HANDSHAKE","SSH 프로토콜 키 교환을 시작합니다.")
 cfg:=&ssh.ClientConfig{User:q.User,Auth:[]ssh.AuthMethod{ssh.Password(q.Password)},HostKeyCallback:checkKey,Timeout:8*time.Second}
 connection,channels,requests,err:=ssh.NewClientConn(conn,target,cfg)
 if err!=nil{
  code,msg:="SSH_HANDSHAKE","SSH 핸드셰이크가 실패했습니다. 서버 SSH 설정을 확인하세요."
  if strings.Contains(err.Error(),"HOSTKEY_MISMATCH"){code="HOSTKEY_MISMATCH";msg="서버 호스트키 불일치: 위장 서버 가능성으로 연결을 차단했습니다."}else if trusted{code="AUTH_FAILED";msg="사용자 인증에 실패했습니다. 비밀번호·계정·서버 인증 정책을 확인하세요."}
  var netErr net.Error;if errors.As(err,&netErr)&&netErr.Timeout(){code="SSH_TIMEOUT";msg="SSH 핸드셰이크·인증 시간 초과입니다."}
  emit("ssh","error",code,msg);return
 }
 sshClient:=ssh.NewClient(connection,channels,requests);defer sshClient.Close()
 emit("auth","success","AUTHENTICATED","SSH 서버 신원 검증 및 사용자 인증에 성공했습니다.")
 emit("sftp","info","OPENING","원격 명령 없이 읽기 전용 SFTP 서브시스템을 시작합니다.")
 client,err:=sftp.NewClient(sshClient)
 if err!=nil{emit("sftp","error","SFTP_UNAVAILABLE","SFTP 서브시스템 접속 실패. 서버 SFTP 설정과 권한을 확인하세요.");return}
 defer client.Close()
 emit("sftp","success","READY","읽기 전용 SFTP 연결에 성공했습니다.")
 emit("stat","info","LSTAT","원격 파일 경로·종류·크기를 확인합니다.")
 info,err:=client.Lstat(q.Path)
 if err!=nil{emit("stat","error","FILE_STAT_FAILED","파일 정보 조회 실패. 경로와 파일 읽기 권한을 확인하세요.");return}
 if !info.Mode().IsRegular()||info.Mode()&os.ModeSymlink!=0{emit("stat","error","NOT_REGULAR","심볼릭 링크·디렉터리는 조회할 수 없습니다.");return}
 size:=info.Size();start:=size-q.MaxBytes;if start<0{start=0}
 count:=size-start
 if count<0||count>512*1024{emit("stat","error","FILE_SIZE","로그 파일의 크기 정보가 올바르지 않습니다.");return}
 emit("stat","success","FILE_VERIFIED",fmt.Sprintf("로그 확인: 전체 %d바이트, 조회 범위 %d바이트",size,count))
 emit("read","info","READING","원격 파일의 마지막 512KiB 이내를 읽습니다.")
 file,err:=client.Open(q.Path)
 if err!=nil{emit("read","error","OPEN_DENIED","파일 열기 실패. 서버 파일 권한을 확인하세요.");return}
 defer file.Close()
 data:=make([]byte,int(count));n,readErr:=file.ReadAt(data,start)
 if readErr!=nil&&readErr!=io.EOF{emit("read","error","READ_FAILED","SFTP 파일 읽기 실패. 서버 로그와 권한을 확인하세요.");return}
 emit("read","success","READ_COMPLETE",fmt.Sprintf("총 %d바이트 읽기를 완료했습니다.",n))
 emit("done","success","DONE","조회 완료. SSH/SFTP 요청을 종료합니다.",map[string]any{"size":size,"offset":start,"data":data[:n],"partial":start>0})
}
