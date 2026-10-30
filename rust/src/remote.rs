//! SFTP only: no remote shell/exec/write or mutation. Verify host-key pin before auth.
use axum::{extract::Json,response::{Response,IntoResponse},http::StatusCode};
use serde::Deserialize;
use serde_json::json;
use russh::{client,keys::{PublicKeyOrCertificate,HashAlg}};
use russh_sftp::client::SftpSession;
use std::{io::SeekFrom,sync::Arc,time::Duration};
use tokio::io::{AsyncReadExt,AsyncSeekExt};
use base64::{engine::general_purpose::STANDARD,Engine};
#[derive(Deserialize,Clone)]
#[serde(rename_all="camelCase")]
pub struct RemoteReq{host:String,port:u16,user:String,password:String,fingerprint:String,path:String,max_bytes:u64}
fn check(q:&RemoteReq)->Result<(),String>{
 if q.host.is_empty()||q.host.len()>253||!q.host.bytes().all(|b|b.is_ascii_alphanumeric()||matches!(b,b'.'|b'-'|b':')){return Err("잘못된 서버 주소".into())}
 if q.port==0||q.user.is_empty()||q.user.len()>128||q.user.bytes().any(|b|b==0||b==10||b==13)||q.password.is_empty()||q.password.len()>1024{return Err("SSH 사용자 또는 비밀번호가 올바르지 않습니다".into())}
 if !q.fingerprint.starts_with("SHA256:")||q.fingerprint.len()<42||q.fingerprint.len()>57||!q.fingerprint[7..].bytes().all(|b|b.is_ascii_alphanumeric()||b==b'+'||b==b'/'){return Err("SHA256 호스트키 지문을 입력해야 합니다".into())}
 if !q.path.starts_with('/')||q.path.len()>2048||q.path.contains(['\\','\n','\r','\0'])||q.path[1..].split('/').any(|s|s==".."||s=="."||s.is_empty()){return Err("올바른 절대 로그 경로를 입력하세요".into())}
 let lower=q.path.to_ascii_lowercase();
 let ext=[".log",".out",".txt",".trace"].iter().any(|s|lower.ends_with(s))||[".log.",".out.",".txt.",".trace."].iter().any(|s|lower.rsplit_once(s).is_some_and(|(_,suffix)|suffix.len()<=6&&!suffix.is_empty()&&suffix.bytes().all(|b|b.is_ascii_digit())));
 if !ext||q.max_bytes==0||q.max_bytes>512*1024{return Err("로그 확장자 또는 최대 조회 크기가 잘못됐습니다".into())}
 Ok(())
}
struct VerifyHost{pin:String}
impl client::Handler for VerifyHost{
 type Error=russh::Error;
 async fn check_server_key(&mut self,key:&PublicKeyOrCertificate)->Result<bool,Self::Error>{
  // Certificates require a separate cert-specific trust model. Reject them here.
  if key.certificate().is_some(){return Ok(false)}
  let observed=key.public_key().fingerprint(HashAlg::Sha256).to_string();
  let got=observed.as_bytes();let expected=self.pin.as_bytes();
  let mut difference=(got.len()^expected.len())as u8;
  for (i,b) in got.iter().enumerate(){difference|=*b^*expected.get(i).unwrap_or(&0)}
  Ok(difference==0)
 }
}
fn api_error(code:StatusCode,detail:&str)->Response{(code,Json(json!({"error":detail}))).into_response()}
pub async fn remote_tail(Json(q):Json<RemoteReq>)->Response{
 if let Err(e)=check(&q){return api_error(StatusCode::BAD_REQUEST,&e)}
 let res=tokio::time::timeout(Duration::from_secs(20),async {
  let ssh=client::connect(Arc::new(client::Config{nodelay:true,..Default::default()}),(q.host.as_str(),q.port),VerifyHost{pin:q.fingerprint.clone()}).await.map_err(|_|"SSH 연결 또는 서버 호스트키 검증 실패")?;
  let mut ssh=ssh;
  let auth=ssh.authenticate_password(&q.user,&q.password).await.map_err(|_|"SSH 인증 실패")?;
  if !auth.success(){return Err("SSH 인증 실패")}
  let channel=ssh.channel_open_session().await.map_err(|_|"SSH 채널 생성 실패")?;
  channel.request_subsystem(true,"sftp").await.map_err(|_|"SFTP 연결 실패")?;
  let sftp=SftpSession::new(channel.into_stream()).await.map_err(|_|"SFTP 프로토콜 실패")?;
  let meta=sftp.symlink_metadata(q.path.clone()).await.map_err(|_|"원격 로그 경로 조회 실패")?;
  if !meta.is_regular()||meta.is_symlink(){return Err("일반 로그 파일만 조회할 수 있습니다")}
  let size=meta.len();let start=size.saturating_sub(q.max_bytes);
  let mut file=sftp.open(q.path.clone()).await.map_err(|_|"원격 로그 읽기 거부")?;
  file.seek(SeekFrom::Start(start)).await.map_err(|_|"원격 로그 위치 이동 실패")?;
  let mut data=Vec::with_capacity((size-start)as usize);file.take(q.max_bytes).read_to_end(&mut data).await.map_err(|_|"원격 로그 읽기 실패")?;
  Ok::<_,&str>(json!({"size":size,"offset":start,"data":STANDARD.encode(&data),"partial":start>0}))
 }).await;
 match res{Ok(Ok(v))=>Json(v).into_response(),Ok(Err(e))=>api_error(StatusCode::BAD_GATEWAY,e),Err(_)=>api_error(StatusCode::GATEWAY_TIMEOUT,"SFTP 20초 제한 초과")}
}
// One request = one read-only SSH/SFTP connection. The stream emits each real
// milestone while it happens and ends by closing the connection. No trace or
// authentication data is persisted on the server.
use axum::{body::Body,http::header};
use bytes::Bytes;
use futures_util::stream;
use std::{convert::Infallible,sync::atomic::{AtomicBool,Ordering}};
use tokio::sync::mpsc;

fn frame(stage:&str,level:&str,code:&str,message:&str,extra:Option<serde_json::Value>)->Bytes{
 let mut v=json!({"stage":stage,"level":level,"code":code,"message":message,"time":chrono::Utc::now().to_rfc3339()});
 if let Some(serde_json::Value::Object(fields))=extra{
  if let serde_json::Value::Object(dst)=&mut v{dst.extend(fields)}
 }
 Bytes::from(format!("{}\n",v))
}
async fn trace_send(tx:&mpsc::Sender<Bytes>,stage:&str,level:&str,code:&str,message:&str){
 let _=tx.send(frame(stage,level,code,message,None)).await;
}
struct TraceHost{pin:String,tx:mpsc::Sender<Bytes>,mismatch:Arc<AtomicBool>}
impl client::Handler for TraceHost{
 type Error=russh::Error;
 async fn check_server_key(&mut self,key:&PublicKeyOrCertificate)->Result<bool,Self::Error>{
  let _=self.tx.try_send(frame("hostkey","info","CHECKING","서버 SSH 공개키 지문을 검증합니다.",None));
  let allowed=if key.certificate().is_some(){false}else{
   let actual=key.public_key().fingerprint(HashAlg::Sha256).to_string();
   let a=actual.as_bytes();let b=self.pin.as_bytes();
   let mut diff=a.len()^b.len();
   for (i,c) in a.iter().enumerate(){diff|=(c^b.get(i).copied().unwrap_or(0)) as usize;}
   diff==0
  };
  if allowed{let _=self.tx.try_send(frame("hostkey","success","MATCHED","등록된 SHA256 서버 지문과 일치합니다.",None));}
  else{self.mismatch.store(true,Ordering::Relaxed);let _=self.tx.try_send(frame("hostkey","error","HOSTKEY_MISMATCH","서버 공개키 지문이 일치하지 않습니다. 위장 서버 가능성이 있어 연결을 중단합니다.",None));}
  Ok(allowed)
 }
}

pub async fn remote_trace(Json(q):Json<RemoteReq>)->Response{
 let (tx,rx)=mpsc::channel::<Bytes>(48);
 tokio::spawn(async move{
  trace_send(&tx,"request","info","START","SSH/SFTP 연결 및 원격 로그 조회 요청을 시작했습니다.").await;
  if let Err(e)=check(&q){trace_send(&tx,"validate","error","INVALID_CONFIG",&e).await;return}
  trace_send(&tx,"validate","success","VALID","서버·계정·경로·호스트키 지문 입력값을 검증했습니다.").await;
  let run=async{
   trace_send(&tx,"dns","info","RESOLVING","서버 호스트 이름 및 연결 주소를 확인합니다.").await;
   if tokio::net::lookup_host((q.host.as_str(),q.port)).await.is_err(){
    trace_send(&tx,"dns","error","DNS_FAILURE","서버 이름을 확인할 수 없습니다. DNS와 SSH 호스트 주소를 확인하세요.").await;
    return
   }
   trace_send(&tx,"tcp","info","CONNECTING","SSH/TCP 연결 및 키 교환을 시도합니다.").await;
   let mismatch=Arc::new(AtomicBool::new(false));
   let handler=TraceHost{pin:q.fingerprint.clone(),tx:tx.clone(),mismatch:mismatch.clone()};
   let mut ssh=match client::connect(Arc::new(client::Config{nodelay:true,..Default::default()}),(q.host.as_str(),q.port),handler).await{
    Ok(v)=>v,Err(err)=>{
     if !mismatch.load(Ordering::Relaxed){
      let detail=err.to_string().to_ascii_lowercase();
      let (code,message)=if detail.contains("refused"){
       ("TCP_REFUSED","서버가 TCP 연결을 거부했습니다. SSH 포트 및 서버 실행 여부를 확인하세요.")
      }else if detail.contains("timed out")||detail.contains("timeout"){
       ("TCP_TIMEOUT","SSH/TCP 연결 시간이 초과됐습니다. 방화벽·네트워크 상태를 확인하세요.")
      }else if detail.contains("network is unreachable")||detail.contains("no route"){
       ("NETWORK_UNREACHABLE","서버로 연결할 네트워크 경로가 없습니다.")
      }else{
       ("SSH_CONNECT","SSH/TCP 연결 또는 SSH 협상에 실패했습니다. 포트·서버·SSH 알고리즘을 확인하세요.")
      };
      trace_send(&tx,"tcp","error",code,message).await;
     }
     return
    }
   };
   trace_send(&tx,"tcp","success","SSH_CONNECTED","SSH 서버 접속 및 서버 신원 검증에 성공했습니다.").await;
   trace_send(&tx,"auth","info","AUTHENTICATING","SSH 계정 인증을 시작합니다.").await;
   let accepted=match ssh.authenticate_password(&q.user,&q.password).await{
    Ok(v)=>v.success(),Err(_)=>false
   };
   if !accepted{trace_send(&tx,"auth","error","AUTH_FAILED","SSH 사용자 인증 실패. 계정명, 비밀번호 및 인증 정책을 확인하세요.").await;return}
   trace_send(&tx,"auth","success","AUTHENTICATED","서버에서 사용자 인증을 승인했습니다.").await;
   trace_send(&tx,"sftp","info","OPENING","원격 명령 실행 없이 SFTP 서브시스템을 개설합니다.").await;
   let channel=match ssh.channel_open_session().await{Ok(v)=>v,Err(_)=>{trace_send(&tx,"sftp","error","CHANNEL_FAILED","SSH SFTP 채널 생성 실패. 계정의 서브시스템 권한을 확인하세요.").await;return}};
   if channel.request_subsystem(true,"sftp").await.is_err(){trace_send(&tx,"sftp","error","SFTP_DENIED","SFTP 서브시스템 요청이 거절되었습니다.").await;return}
   let sftp=match SftpSession::new(channel.into_stream()).await{Ok(v)=>v,Err(_)=>{trace_send(&tx,"sftp","error","SFTP_UNAVAILABLE","SFTP 프로토콜 협상 실패. 서버 SFTP 설정을 확인하세요.").await;return}};
   trace_send(&tx,"sftp","success","READY","읽기 전용 SFTP 세션 준비가 완료되었습니다.").await;
   trace_send(&tx,"stat","info","LSTAT","로그 파일 경로, 유형 및 크기를 조회합니다.").await;
   let meta=match sftp.symlink_metadata(q.path.clone()).await{Ok(v)=>v,Err(_)=>{trace_send(&tx,"stat","error","FILE_STAT_FAILED","파일 조회 실패. 원격 경로, 존재 여부 및 읽기 권한을 확인하세요.").await;return}};
   if !meta.is_regular()||meta.is_symlink(){trace_send(&tx,"stat","error","NOT_REGULAR","보안을 위해 디렉터리 및 심볼릭 링크 파일은 읽지 않습니다.").await;return}
   let size=meta.len();let start=size.saturating_sub(q.max_bytes);
   trace_send(&tx,"stat","success","FILE_VERIFIED",&format!("로그 확인 · 전체 {}바이트, 읽기 {}바이트",size,size-start)).await;
   trace_send(&tx,"read","info","READING","원격 파일 끝부분을 읽고 있습니다.").await;
   let mut file=match sftp.open(q.path.clone()).await{Ok(v)=>v,Err(_)=>{trace_send(&tx,"read","error","OPEN_DENIED","SFTP 파일 열기 거부. 파일 권한을 확인하세요.").await;return}};
   if file.seek(SeekFrom::Start(start)).await.is_err(){trace_send(&tx,"read","error","SEEK_FAILED","원격 파일 위치 이동 실패.").await;return}
   let mut data=Vec::with_capacity((size-start) as usize);
   if file.take(q.max_bytes).read_to_end(&mut data).await.is_err(){trace_send(&tx,"read","error","READ_FAILED","SFTP 파일 읽기에 실패했습니다.").await;return}
   trace_send(&tx,"read","success","READ_COMPLETE",&format!("{}바이트 읽기 완료",data.len())).await;
   let final_frame=frame("done","success","DONE","조회 완료. SFTP 세션을 종료합니다.",Some(json!({"size":size,"offset":start,"data":STANDARD.encode(&data),"partial":start>0})));
   let _=tx.send(final_frame).await;
  };
  tokio::select!{
   _=tx.closed()=>{}, // Browser clicked "연결 중단": drop network future immediately.
   result=tokio::time::timeout(Duration::from_secs(20),run)=>{
    if result.is_err(){trace_send(&tx,"timeout","error","SSH_TIMEOUT","SSH/SFTP 연결 또는 조회가 20초 제한을 초과했습니다.").await}
   }
  }
 });
 let output=stream::unfold(rx,|mut r|async move{r.recv().await.map(|item|(Ok::<Bytes,Infallible>(item),r))});
 ([(header::CONTENT_TYPE,"application/x-ndjson; charset=utf-8"),(header::CACHE_CONTROL,"no-store"),(header::HeaderName::from_static("x-accel-buffering"),"no")],Body::from_stream(output)).into_response()
}

#[cfg(test)]mod tests{
 use super::*;
 #[test]fn deny_unsafe_remote(){let mut q=RemoteReq{host:"127.0.0.1".into(),port:22,user:"readonly".into(),password:"test".into(),fingerprint:format!("SHA256:{}", "A".repeat(43)),path:"/logs/server.log".into(),max_bytes:512*1024};assert!(check(&q).is_ok());q.path="/etc/../shadow.log".into();assert!(check(&q).is_err());q.path="/logs/server.log".into();q.fingerprint.clear();assert!(check(&q).is_err());q.fingerprint=format!("SHA256:{}", "A".repeat(43));q.max_bytes=1<<30;assert!(check(&q).is_err());}
}
