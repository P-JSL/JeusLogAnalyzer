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
#[cfg(test)]mod tests{
 use super::*;
 #[test]fn deny_unsafe_remote(){let mut q=RemoteReq{host:"127.0.0.1".into(),port:22,user:"readonly".into(),password:"test".into(),fingerprint:format!("SHA256:{}", "A".repeat(43)),path:"/logs/server.log".into(),max_bytes:512*1024};assert!(check(&q).is_ok());q.path="/etc/../shadow.log".into();assert!(check(&q).is_err());q.path="/logs/server.log".into();q.fingerprint.clear();assert!(check(&q).is_err());q.fingerprint=format!("SHA256:{}", "A".repeat(43));q.max_bytes=1<<30;assert!(check(&q).is_err());}
}
