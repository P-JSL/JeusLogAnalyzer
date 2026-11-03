//! Private GitHub release updater: current-process scoped credentials, digest-checked
//! downloads and rollback-capable Windows replacement (no token in arguments).
#![allow(clippy::result_large_err)]
use axum::{extract::Json,response::{Response,IntoResponse},http::StatusCode};
use serde::Deserialize;
use serde_json::{json,Value};
#[cfg(windows)]
use sha2::{Digest,Sha256};
use std::time::Duration;
#[cfg(windows)]
use futures_util::StreamExt;

pub const VERSION:&str="1.0.4";
const RELEASE_API:&str="https://api.github.com/repos/P-JSL/JeusLogAnalyzer";
const RUST_EXE:&str="JEUS_Lens_Rust_Windows_x64.exe";
const MAX_DOWNLOAD:u64=120*1024*1024;
#[derive(Deserialize)]
pub struct UpdateInput{#[serde(default)]token:String}
#[cfg_attr(not(windows),allow(dead_code))]
struct Release{version:String,tag:String,id:u64,size:u64,digest:String}
fn bad(code:StatusCode,msg:&str)->Response{(code,Json(json!({"error":msg}))).into_response()}
fn version(s:&str)->Option<[u32;3]>{
 let s=s.strip_prefix('v').unwrap_or(s);let fields=s.split('.').collect::<Vec<_>>();
 if fields.len()!=3{return None}
 let mut parts=[0;3];
 for (index,part) in fields.iter().enumerate(){if part.is_empty()||!part.bytes().all(|b|b.is_ascii_digit()){return None};parts[index]=part.parse().ok()?;if parts[index]>9999{return None}}
 Some(parts)
}
fn update_available(tag:&str)->bool{match(version(tag),version(VERSION)){(Some(next),Some(current))=>next>current,_=>false}}
fn github_client()->Result<reqwest::Client,Response>{
 reqwest::Client::builder().timeout(Duration::from_secs(85)).redirect(reqwest::redirect::Policy::limited(4)).build().map_err(|_|bad(StatusCode::BAD_GATEWAY,"GitHub 연결을 준비할 수 없습니다"))
}
fn request(client:&reqwest::Client,url:&str,token:&str,accept:&str)->reqwest::RequestBuilder{
 let mut r=client.get(url).header("User-Agent","JEUS-Lens-LocalUpdater/1.0.4").header("X-GitHub-Api-Version","2022-11-28").header("Accept",accept);
 if !token.is_empty(){r=r.bearer_auth(token)}r
}
async fn release(client:&reqwest::Client,token:&str)->Result<Release,Response>{
 if token.len()>2048||token.contains(['\r','\n']){return Err(bad(StatusCode::BAD_REQUEST,"GitHub 토큰 형식이 올바르지 않습니다"))}
 let response=request(client,&format!("{RELEASE_API}/releases/latest"),token,"application/vnd.github+json").timeout(Duration::from_secs(18)).send().await.map_err(|_|bad(StatusCode::BAD_GATEWAY,"GitHub 연결 실패: 네트워크 또는 TLS 설정을 확인하세요"))?;
 let status=response.status();
 if status==401||status==403||status==404{return Err(bad(StatusCode::BAD_GATEWAY,"Private GitHub 릴리즈 조회 권한이 없습니다. 저장소 Contents: Read 토큰을 입력하세요"))}
 if !status.is_success(){return Err(bad(StatusCode::BAD_GATEWAY,"GitHub 릴리즈 API 조회에 실패했습니다"))}
 let data:Value=response.json().await.map_err(|_|bad(StatusCode::BAD_GATEWAY,"릴리즈 응답 형식이 올바르지 않습니다"))?;
 if data["draft"]==true||data["prerelease"]==true{return Err(bad(StatusCode::BAD_GATEWAY,"정식 릴리즈가 아닙니다"))}
 let tag=data["tag_name"].as_str().unwrap_or("").to_owned();
 if version(&tag).is_none(){return Err(bad(StatusCode::BAD_GATEWAY,"지원하지 않는 버전 태그입니다"))}
 let Some(asset)=data["assets"].as_array().and_then(|items|items.iter().find(|a|a["name"]==RUST_EXE))else{return Err(bad(StatusCode::BAD_GATEWAY,"Rust Windows 릴리즈 실행 파일을 찾지 못했습니다"))};
 let id=asset["id"].as_u64().unwrap_or(0);let size=asset["size"].as_u64().unwrap_or(0);
 let digest=asset["digest"].as_str().unwrap_or("").to_owned();
 let hex=digest.strip_prefix("sha256:").unwrap_or("");
 if id==0||size==0||size>MAX_DOWNLOAD||hex.len()!=64||hex::decode(hex).is_err(){return Err(bad(StatusCode::BAD_GATEWAY,"릴리즈 크기 또는 신뢰 가능한 SHA-256 정보가 누락되었습니다"))}
 Ok(Release{version:tag.trim_start_matches('v').to_owned(),tag,id,size,digest})
}
pub async fn check(Json(input):Json<UpdateInput>)->Response{
 let client=match github_client(){Ok(c)=>c,Err(e)=>return e};
 let latest=match release(&client,&input.token).await{Ok(v)=>v,Err(e)=>return e};
 Json(json!({"currentVersion":VERSION,"latestVersion":latest.version,"updateAvailable":update_available(&latest.tag),"asset":RUST_EXE,"size":latest.size,"runtime":"rust","installSupported":cfg!(windows)})).into_response()
}
pub async fn apply(Json(input):Json<UpdateInput>)->Response{
 #[cfg(not(windows))]{
  let _=input;
  bad(StatusCode::NOT_IMPLEMENTED,"자동 설치는 Windows 실행 파일에서만 지원합니다")
 }
 #[cfg(windows)]{
  apply_windows(input).await
 }
}
#[cfg(windows)]
async fn apply_windows(input:UpdateInput)->Response{
 use tokio::io::AsyncWriteExt;
 use std::path::PathBuf;
 let client=match github_client(){Ok(c)=>c,Err(e)=>return e};
 let latest=match release(&client,&input.token).await{Ok(v)=>v,Err(e)=>return e};
 if !update_available(&latest.tag){return bad(StatusCode::CONFLICT,"현재 버전이 최신 버전입니다")}
 let binary=match std::env::current_exe().and_then(std::fs::canonicalize){Ok(p)=>p,Err(_)=>return bad(StatusCode::INTERNAL_SERVER_ERROR,"실행 파일 경로 확인 실패")};
 let Some(dir)=binary.parent()else{return bad(StatusCode::INTERNAL_SERVER_ERROR,"실행 파일 디렉터리가 없습니다")};
 let staged=dir.join(format!(".jeus-update-{}.exe",hex::encode(rand::random::<[u8;16]>())));
 let mut output=match tokio::fs::OpenOptions::new().create_new(true).write(true).open(&staged).await{Ok(f)=>f,Err(_)=>return bad(StatusCode::FORBIDDEN,"설치 폴더에 업데이트 파일을 만들 권한이 없습니다")};
 let url=format!("{RELEASE_API}/releases/assets/{}",latest.id);
 let result=async{
  let response=request(&client,&url,&input.token,"application/octet-stream").send().await.map_err(|_|"릴리즈 실행 파일 다운로드 실패")?;
  if !response.status().is_success(){return Err("GitHub 실행 파일을 다운로드할 수 없습니다")}
  let mut stream=response.bytes_stream();let mut hasher=Sha256::new();let mut written=0u64;
  while let Some(part)=stream.next().await{
   let bytes=part.map_err(|_|"실행 파일 다운로드가 중단되었습니다")?;
   written+=bytes.len()as u64;
   if written>MAX_DOWNLOAD{return Err("다운로드 파일 크기가 제한을 초과했습니다")}
   hasher.update(&bytes);output.write_all(&bytes).await.map_err(|_|"업데이트 임시 파일을 저장할 수 없습니다")?;
  }
  if written!=latest.size{return Err("다운로드 파일 크기가 릴리즈 정보와 다릅니다")}
  if !format!("sha256:{}",hex::encode(hasher.finalize())).eq_ignore_ascii_case(&latest.digest){return Err("SHA-256 무결성 검증에 실패했습니다")}
  output.flush().await.map_err(|_|"업데이트 임시 파일 저장에 실패했습니다")?;
  output.sync_all().await.map_err(|_|"업데이트 파일 디스크 동기화에 실패했습니다")?;
  Ok::<(),&str>(())
 }.await;
 drop(output);
 if let Err(e)=result{let _=tokio::fs::remove_file(&staged).await;return bad(StatusCode::BAD_GATEWAY,e)}
 let prefix=match tokio::fs::read(&staged).await{Ok(v)=>v.get(..2).map(|x|x.to_owned()),Err(_)=>None};
 if prefix.as_deref()!=Some(b"MZ".as_slice()){let _=tokio::fs::remove_file(&staged).await;return bad(StatusCode::CONFLICT,"업데이트 파일이 올바른 Windows EXE 형식이 아닙니다")}
 let quote=|p:&std::path::Path|format!("'{}'",p.to_string_lossy().replace('\'',"''"));
 let back=PathBuf::from(format!("{}.update-backup",binary.display()));
 let script=format!("$ErrorActionPreference='Stop';$old={};$next={};$back={};$appId={};for($i=0;$i -lt 90;$i++){{if(Get-Process -Id $appId -ErrorAction SilentlyContinue){{Start-Sleep -Milliseconds 500;continue}};try{{if(Test-Path -LiteralPath $back){{Remove-Item -LiteralPath $back -Force}};Move-Item -LiteralPath $old -Destination $back -Force;try{{Move-Item -LiteralPath $next -Destination $old -Force;Start-Process -FilePath $old;Remove-Item -LiteralPath $back -Force -ErrorAction SilentlyContinue;exit 0}}catch{{if(Test-Path -LiteralPath $back){{Move-Item -LiteralPath $back -Destination $old -Force}};throw}}}}catch{{Start-Sleep -Milliseconds 500}}}};exit 1",quote(&binary),quote(&staged),quote(&back),std::process::id());
 let utf16=script.encode_utf16().flat_map(u16::to_le_bytes).collect::<Vec<_>>();
 let encoded=base64::Engine::encode(&base64::engine::general_purpose::STANDARD,utf16);
 if std::process::Command::new("powershell.exe").args(["-NoProfile","-NonInteractive","-WindowStyle","Hidden","-EncodedCommand",&encoded]).spawn().is_err(){
  let _=tokio::fs::remove_file(&staged).await;return bad(StatusCode::INTERNAL_SERVER_ERROR,"Windows 자동 업데이트 실행 프로세스를 시작하지 못했습니다")
 }
 tokio::spawn(async{tokio::time::sleep(Duration::from_millis(1400)).await;std::process::exit(0)});
 Json(json!({"status":"installing","version":latest.version,"message":"릴리즈 SHA-256을 검증했습니다. 프로그램 종료 후 새 버전으로 교체하고 자동으로 재실행합니다."})).into_response()
}
#[cfg(test)]
mod tests{
 use super::*;
 #[test]fn version_order_and_invalid_tag(){assert!(update_available("v1.0.5"));assert!(!update_available("v1.0.4"));assert!(!update_available("v1.0.3"));assert!(!update_available("v1.0.5-rc1"));assert_eq!(version("1.0.4"),Some([1,0,4]));}
}
