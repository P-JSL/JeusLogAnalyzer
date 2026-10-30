//! HTTP API wire-compatible with Go's browser client. Source bytes are never persisted.
// Handler helpers return full responses so their HTTP status and body survive unchanged.
#![allow(clippy::result_large_err)]
use crate::{engine::{self,Indexer,Record,Summary},remote};
use axum::{body::Body,extract::{State,Query},http::{HeaderValue,Method,Request,StatusCode,header},middleware::{self,Next},response::{IntoResponse,Response},routing::{get,post},Json,Router};
use futures_util::StreamExt;
use rand::RngCore;
use serde::Deserialize;
use serde_json::{json,Value};
use sha2::{Sha256,Digest};
use std::{collections::HashMap,fs::{self,File},io::{BufReader,BufWriter,Read,Seek,SeekFrom,Write},path::{Path,PathBuf},sync::{Arc,Mutex,atomic::{AtomicU64,Ordering}},time::{SystemTime,UNIX_EPOCH},};
use tokio::net::TcpListener;
use rust_embed::RustEmbed;
use chrono::Utc;
#[derive(RustEmbed)]
#[folder="../web/"]
struct Web;
#[derive(Clone)]
pub struct App{pub root:PathBuf,pub host:String,pub last_ping:Arc<AtomicU64>,jobs:Arc<Mutex<HashMap<String,Value>>>,filters:Arc<Mutex<HashMap<String,Filter>>>}
#[derive(Clone)]struct Filter{session:String,path:PathBuf,total:u64}
fn err(code:StatusCode,text:&str)->Response{(code,Json(json!({"error":text}))).into_response()}
fn now_sec()->u64{SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()}
fn token()->String{let mut bytes=[0;16];rand::thread_rng().fill_bytes(&mut bytes);hex::encode(bytes)}
fn valid_id(id:&str)->bool{(16..=48).contains(&id.len())&&id.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'-')}
fn disk_used(root:&Path)->u64{fs::read_dir(root).ok().into_iter().flatten().filter_map(Result::ok).filter(|e|e.file_type().is_ok_and(|k|k.is_dir())&&valid_id(&e.file_name().to_string_lossy())).map(|e|["summary.json","index.bin","issues.bin"].iter().map(|f|e.path().join(f).metadata().map(|m|m.len()).unwrap_or(0)).sum::<u64>()).sum()}
fn load(app:&App,id:&str)->Result<Summary,Response>{
 if !valid_id(id){return Err(err(StatusCode::BAD_REQUEST,"invalid id"))}
 let bytes=fs::read(app.root.join(id).join("summary.json")).map_err(|_|err(StatusCode::NOT_FOUND,"archive not found"))?;
 let data:Summary=serde_json::from_slice(&bytes).map_err(|_|err(StatusCode::CONFLICT,"invalid summary"))?;
 if data.id!=id||!data.indexed{return Err(err(StatusCode::CONFLICT,"invalid session"))}
 Ok(data)
}
fn records_file(app:&App,id:&str)->Result<File,Response>{File::open(app.root.join(id).join("index.bin")).map_err(|_|err(StatusCode::NOT_FOUND,"index unavailable"))}
fn record_at(f:&mut File,n:u64)->Result<Record,Response>{
 let offset=n.checked_mul(24).ok_or_else(||err(StatusCode::BAD_REQUEST,"invalid record index"))?;
 f.seek(SeekFrom::Start(offset)).map_err(|_|err(StatusCode::CONFLICT,"corrupt record offset"))?;
 let mut b=[0;24];f.read_exact(&mut b).map_err(|_|err(StatusCode::CONFLICT,"damaged index"))?;
 Record::from_bytes(&b).map_err(|_|err(StatusCode::CONFLICT,"damaged index"))
}
fn query_id(q:&HashMap<String,String>)->String{q.get("id").cloned().unwrap_or_default()}
pub fn new_app(host:String)->Result<App,String>{
 let root=std::env::var_os("JEUS_LENS_DATA_DIR").map(PathBuf::from).unwrap_or_else(||{
  #[cfg(windows)] {PathBuf::from(std::env::var_os("APPDATA").unwrap_or_else(||".".into())).join("JEUS_Lens").join("archive")}
  #[cfg(not(windows))] {PathBuf::from(std::env::var_os("XDG_CONFIG_HOME").unwrap_or_else(||std::env::var_os("HOME").unwrap_or_else(||".".into()))).join("JEUS_Lens").join("archive")}
 });
 fs::create_dir_all(&root).map_err(|e|e.to_string())?;
 for d in fs::read_dir(&root).map_err(|e|e.to_string())?.flatten(){if d.file_type().is_ok_and(|k|k.is_dir())&&valid_id(&d.file_name().to_string_lossy()){
  if let Ok(items)=fs::read_dir(d.path()){for f in items.flatten(){let name=f.file_name().to_string_lossy().into_owned();if name.starts_with("filter-")&&name.ends_with(".tmp"){let _=fs::remove_file(f.path());}}}
 }}
 Ok(App{root,host,last_ping:Arc::new(AtomicU64::new(now_sec())),jobs:Arc::new(Mutex::new(HashMap::new())),filters:Arc::new(Mutex::new(HashMap::new()))})
}
fn protect_headers(res:&mut Response){
 let h=res.headers_mut();
 h.insert("cache-control",HeaderValue::from_static("no-store"));
 h.insert("x-content-type-options",HeaderValue::from_static("nosniff"));
 h.insert("x-frame-options",HeaderValue::from_static("DENY"));
 h.insert("referrer-policy",HeaderValue::from_static("no-referrer"));
 h.insert("cross-origin-resource-policy",HeaderValue::from_static("same-origin"));
 h.insert("content-security-policy",HeaderValue::from_static("default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; worker-src 'self'; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"));
}
async fn guard(State(app):State<App>,req:Request<Body>,next:Next)->Response{
 let uri=req.uri().path().to_owned();let host=req.headers().get("host").and_then(|v|v.to_str().ok()).unwrap_or("");
 let origin=req.headers().get("origin").and_then(|v|v.to_str().ok());
 let mutate=req.method()==Method::POST;
 if host!=app.host{return err(StatusCode::FORBIDDEN,"host not allowed")}
 if origin.is_some_and(|o|o!=format!("http://{}",app.host)){return err(StatusCode::FORBIDDEN,"origin not allowed")}
 if (uri.starts_with("/api/")||uri=="/ping")&&mutate&&origin!=Some(format!("http://{}",app.host).as_str()){return err(StatusCode::FORBIDDEN,"origin required")}
 let mut out=next.run(req).await;protect_headers(&mut out);out
}
async fn static_file(req:Request<Body>)->Response{
 if !matches!(req.method(),&Method::GET|&Method::HEAD){return err(StatusCode::METHOD_NOT_ALLOWED,"method not allowed")}
 let target=req.uri().path().trim_start_matches('/');let target=if target.is_empty(){"index.html"}else{target};
 if target.contains("..")||target.contains('\\'){return err(StatusCode::NOT_FOUND,"not found")}
 let Some(a)=Web::get(target)else{return err(StatusCode::NOT_FOUND,"not found")};
 let mime=mime_guess::from_path(target).first_or_octet_stream();
 let mut res=(StatusCode::OK,[(header::CONTENT_TYPE,mime.as_ref().to_string())],a.data.to_vec()).into_response();
 if req.method()==Method::HEAD{*res.body_mut()=Body::empty()}res
}
async fn ping(State(app):State<App>)->Response{app.last_ping.store(now_sec(),Ordering::Relaxed);StatusCode::NO_CONTENT.into_response()}
async fn archives(State(app):State<App>)->Json<Value>{
 let mut items=Vec::<Summary>::new();
 if let Ok(dirs)=fs::read_dir(&app.root){for d in dirs.flatten(){let id=d.file_name().to_string_lossy().into_owned();if let Ok(m)=load(&app,&id){items.push(m)}}}
 items.sort_by(|a,b|b.imported.cmp(&a.imported));
 Json(json!({"items":items,"maxSourceBytes":engine::MAX_SOURCE,"metadataUsed":disk_used(&app.root)}))
}
async fn import(State(app):State<App>,Query(q):Query<HashMap<String,String>>,req:Request<Body>)->Response{
 let id=query_id(&q);if !valid_id(&id){return err(StatusCode::BAD_REQUEST,"invalid id")}
 let size=req.headers().get(header::CONTENT_LENGTH).and_then(|v|v.to_str().ok()).and_then(|s|s.parse::<u64>().ok()).unwrap_or(0);
 if !(1..=engine::MAX_SOURCE).contains(&size){return err(StatusCode::PAYLOAD_TOO_LARGE,"원본 파일은 1B~1GiB만 허용합니다")}
 let name=q.get("name").cloned().unwrap_or_else(||"log.txt".into());
 let name=Path::new(&name).file_name().and_then(|v|v.to_str()).unwrap_or("log.txt").chars().take(150).collect::<String>();
 let enc=q.get("encoding").map(String::as_str).unwrap_or("auto");
 if !["auto","","utf-8","euc-kr"].contains(&enc){return err(StatusCode::BAD_REQUEST,"지원하지 않는 인코딩입니다")}
 let dir=app.root.join(&id);
 {
  let mut jobs=app.jobs.lock().unwrap();
  if jobs.contains_key(&id)||dir.exists(){return err(StatusCode::CONFLICT,"duplicate archive id")}
  jobs.insert(id.clone(),json!({"received":0,"indexed":0,"size":size,"stage":"indexing"}));
 }
 let result=async{
  fs::create_dir(&dir).map_err(|e|e.to_string())?;
  let mut stream=req.into_body().into_data_stream();let mut first=Vec::new();let mut indexer=None;let mut hash=Sha256::new();let mut total:u64=0;
  while let Some(next)=stream.next().await{
   let chunk=next.map_err(|e|e.to_string())?;total+=chunk.len()as u64;if total>size{return Err("file exceeds declared length".into())}
   hash.update(&chunk);
   if indexer.is_none(){
    let take=(128*1024-first.len()).min(chunk.len());first.extend_from_slice(&chunk[..take]);
    if first.len()==128*1024||total==size{
     let encoding=engine::encoding_of(&first,enc)?;
     let mut engine=Indexer::new(&dir,&encoding)?;engine.feed(&first)?;engine.feed(&chunk[take..])?;indexer=Some(engine);
    }
   }else if let Some(engine)=indexer.as_mut(){engine.feed(&chunk)?}
   if let Some(j)=app.jobs.lock().unwrap().get_mut(&id){j["received"]=json!(total);j["indexed"]=json!(total)}
  }
  if total!=size{return Err(format!("size mismatch: {total}/{size}"))}
  let mut summary=indexer.ok_or("empty log")?.finish()?;
  summary.id=id.clone();summary.name=name;summary.size=size;summary.imported=Utc::now().to_rfc3339();summary.source_hash=hex::encode(hash.finalize());summary.storage_mode="metadata-only".into();
  summary.metadata_bytes=["index.bin","issues.bin"].iter().map(|n|dir.join(n).metadata().map(|m|m.len()).unwrap_or(0)).sum();
  let data=serde_json::to_vec_pretty(&summary).map_err(|e|e.to_string())?;fs::write(dir.join("summary.part"),data).map_err(|e|e.to_string())?;
  fs::rename(dir.join("summary.part"),dir.join("summary.json")).map_err(|e|e.to_string())?;
  Ok::<Summary,String>(summary)
 }.await;
 app.jobs.lock().unwrap().remove(&id);
 match result{Ok(v)=>Json(json!(v)).into_response(),Err(e)=>{let _=fs::remove_dir_all(dir);err(StatusCode::BAD_REQUEST,&format!("분석 실패: {e}"))}}
}
async fn verify(State(app):State<App>,Query(q):Query<HashMap<String,String>>,req:Request<Body>)->Response{
 let meta=match load(&app,&query_id(&q)){Ok(m)=>m,Err(e)=>return e};
 let size=req.headers().get(header::CONTENT_LENGTH).and_then(|v|v.to_str().ok()).and_then(|s|s.parse::<u64>().ok()).unwrap_or(0);
 if size!=meta.size{return err(StatusCode::CONFLICT,"원본 크기가 저장된 메타데이터와 다릅니다")}
 let mut stream=req.into_body().into_data_stream();let mut hash=Sha256::new();let mut n=0u64;
 while let Some(b)=stream.next().await{let Ok(b)=b else{return err(StatusCode::BAD_REQUEST,"원본 검증 실패")};n+=b.len()as u64;if n>size{return err(StatusCode::BAD_REQUEST,"원본 크기 초과")}hash.update(&b)}
 if n!=size{return err(StatusCode::BAD_REQUEST,"원본 검증 실패")}
 if hex::encode(hash.finalize())!=meta.source_hash.to_ascii_lowercase(){return err(StatusCode::CONFLICT,"파일의 SHA-256이 이전 원본과 다릅니다. 새 분석이 필요합니다")}
 Json(json!(meta)).into_response()
}
async fn status(State(app):State<App>,Query(q):Query<HashMap<String,String>>)->Response{
 let jobs=app.jobs.lock().unwrap();match jobs.get(&query_id(&q)){Some(v)=>Json(v.clone()).into_response(),None=>err(StatusCode::NOT_FOUND,"job not found")}
}
#[derive(Deserialize)]struct IdReq{id:String}
async fn delete(State(app):State<App>,Json(d):Json<IdReq>)->Response{
 if !valid_id(&d.id){return err(StatusCode::BAD_REQUEST,"invalid id")}
 if let Err(e)=load(&app,&d.id){return e}
 if fs::remove_dir_all(app.root.join(&d.id)).is_err(){return err(StatusCode::INTERNAL_SERVER_ERROR,"delete failed")}
 let mut filters=app.filters.lock().unwrap();filters.retain(|_,f|{if f.session==d.id{let _=fs::remove_file(&f.path);false}else{true}});
 Json(json!({"deleted":true})).into_response()
}
#[derive(Deserialize)]struct FilterReq{id:String,group:String,#[serde(default)]query:String}
async fn filter(State(app):State<App>,Json(q):Json<FilterReq>)->Response{
 let meta=match load(&app,&q.id){Ok(m)=>m,Err(e)=>return e};
 if q.query.len()>256{return err(StatusCode::BAD_REQUEST,"검색어는 256자 이하로 입력해 주세요")}
 if !q.query.trim().is_empty(){return err(StatusCode::UNPROCESSABLE_ENTITY,"원본 내용 검색은 브라우저에서 수행해야 합니다")}
 let selected_issue=if let Some(id)=q.group.strip_prefix("issue:"){
  if meta.issue_version!=1||!meta.issues.iter().any(|i|i.id==id){return err(StatusCode::BAD_REQUEST,"invalid issue")}
  match u64::from_str_radix(id,16){Ok(v)=>Some(v),Err(_)=>return err(StatusCode::BAD_REQUEST,"invalid issue")}
 }else{None};
 if !["all","sql","otherError","error","review","warning","info"].contains(&q.group.as_str())&&selected_issue.is_none()&&!q.group.strip_prefix("sql:").is_some_and(|x|x.parse::<u8>().is_ok_and(|v|(1..=8).contains(&v))){return err(StatusCode::BAD_REQUEST,"invalid group")}
 if q.group=="all"{return Json(json!({"filterId":"all","total":meta.counts.all})).into_response()}
 let fid=token();let path=app.root.join(&q.id).join(format!("filter-{fid}.tmp"));
 let mut source=match records_file(&app,&q.id){Ok(f)=>BufReader::with_capacity(1024*1024,f),Err(e)=>return e};
 let mut selected=match selected_issue{Some(_)=>match File::open(app.root.join(&q.id).join("issues.bin")){Ok(f)=>Some(BufReader::with_capacity(512*1024,f)),Err(_)=>return err(StatusCode::NOT_FOUND,"issue index unavailable")},None=>None};
 let mut out=match File::create(&path){Ok(f)=>BufWriter::with_capacity(1024*1024,f),Err(_)=>return err(StatusCode::INTERNAL_SERVER_ERROR,"filter write failed")};
 let mut total=0u64;let mut b=[0;24];let mut issue=[0;8];
 for index in 0..meta.counts.all{
  if source.read_exact(&mut b).is_err(){let _=fs::remove_file(path);return err(StatusCode::CONFLICT,"damaged index")}
  let row=match Record::from_bytes(&b){Ok(r)=>r,Err(_)=>return err(StatusCode::CONFLICT,"damaged index")};
  let yes=if let Some(id)=selected_issue{if selected.as_mut().unwrap().read_exact(&mut issue).is_err(){return err(StatusCode::CONFLICT,"damaged issue index")}u64::from_le_bytes(issue)==id}else{row.matches(&q.group)};
  if yes{if out.write_all(&index.to_le_bytes()).is_err(){return err(StatusCode::INTERNAL_SERVER_ERROR,"filter write failed")}total+=1}
 }
 if out.flush().is_err(){return err(StatusCode::INTERNAL_SERVER_ERROR,"filter flush failed")}
 let mut filters=app.filters.lock().unwrap();filters.retain(|_,f|{if f.session==q.id{let _=fs::remove_file(&f.path);false}else{true}});
 filters.insert(fid.clone(),Filter{session:q.id,path,total});
 Json(json!({"filterId":fid,"total":total})).into_response()
}
fn resolved_filter(app:&App,id:&str,fid:&str,total:u64)->Result<(u64,Option<File>),Response>{
 if fid=="all"||fid.is_empty(){return Ok((total,None))}
 let f=app.filters.lock().unwrap().get(fid).cloned().filter(|f|f.session==id).ok_or_else(||err(StatusCode::BAD_REQUEST,"필터가 만료되었습니다"))?;
 let file=File::open(f.path).map_err(|_|err(StatusCode::BAD_REQUEST,"filter index missing"))?;Ok((f.total,Some(file)))
}
fn filter_row(idx:&mut File,ids:&mut Option<File>,index:u64)->Result<Value,Response>{
 let i=if let Some(ids)=ids{let mut b=[0;8];ids.seek(SeekFrom::Start(index*8)).map_err(|_|err(StatusCode::CONFLICT,"filter index damaged"))?;ids.read_exact(&mut b).map_err(|_|err(StatusCode::CONFLICT,"filter index damaged"))?;u64::from_le_bytes(b)}else{index};
 Ok(record_at(idx,i)?.json(i))
}
async fn page(State(app):State<App>,Query(q):Query<HashMap<String,String>>)->Response{
 let id=query_id(&q);let meta=match load(&app,&id){Ok(m)=>m,Err(e)=>return e};
 let fid=q.get("filterId").map(String::as_str).unwrap_or("all");
 let (total,mut ids)=match resolved_filter(&app,&id,fid,meta.counts.all){Ok(v)=>v,Err(e)=>return e};
 let pages=(total.saturating_add(99)/100).max(1);let page=q.get("page").and_then(|s|s.parse::<u64>().ok()).unwrap_or(1).clamp(1,pages);
 let mut idx=match records_file(&app,&id){Ok(f)=>f,Err(e)=>return e};
 let start=(page-1)*100;
 let count=((page*100).min(total)-start) as usize;
 let mut rows=Vec::with_capacity(count);
 if ids.is_none(){
  // Unfiltered pages contain contiguous 24-byte records: one seek/read
  // instead of up to 100 filesystem syscalls and 100 small reads.
  let mut block=vec![0u8;count*24];
  if idx.seek(SeekFrom::Start(start*24)).is_err()||idx.read_exact(&mut block).is_err(){
   return err(StatusCode::CONFLICT,"damaged index")
  }
  for (position,bytes) in block.chunks_exact(24).enumerate(){
   let row=match Record::from_bytes(bytes){Ok(v)=>v,Err(_)=>return err(StatusCode::CONFLICT,"damaged index")};
   rows.push(row.json(start+position as u64));
  }
 }else{
  for i in start..start+count as u64{
   match filter_row(&mut idx,&mut ids,i){Ok(v)=>rows.push(v),Err(e)=>return e}
  }
 }
 Json(json!({"page":page,"pages":pages,"total":total,"rows":rows})).into_response()
}
async fn index(State(app):State<App>,Query(q):Query<HashMap<String,String>>)->Response{
 let id=query_id(&q);let meta=match load(&app,&id){Ok(m)=>m,Err(e)=>return e};
 let Some(start)=q.get("start").and_then(|x|x.parse::<u64>().ok())else{return err(StatusCode::BAD_REQUEST,"invalid range")};
 let Some(count)=q.get("count").and_then(|x|x.parse::<u64>().ok())else{return err(StatusCode::BAD_REQUEST,"invalid range")};
 if count==0||count>50000||start>meta.counts.all||start==meta.counts.all{return err(StatusCode::BAD_REQUEST,"invalid range")}
 let count=count.min(meta.counts.all-start);let mut bytes=vec![0;count as usize*24];
 let mut f=match records_file(&app,&id){Ok(f)=>f,Err(e)=>return e};
 if f.seek(SeekFrom::Start(start*24)).is_err()||f.read_exact(&mut bytes).is_err(){return err(StatusCode::CONFLICT,"invalid index")}
 ([(header::CONTENT_TYPE,"application/octet-stream")],bytes).into_response()
}
#[derive(Deserialize)]struct IDs{id:String,indices:Vec<u64>}
async fn page_ids(State(app):State<App>,Json(q):Json<IDs>)->Response{
 if q.indices.len()>1000{return err(StatusCode::BAD_REQUEST,"too many indices")}
 let meta=match load(&app,&q.id){Ok(m)=>m,Err(e)=>return e};
 let mut f=match records_file(&app,&q.id){Ok(f)=>f,Err(e)=>return e};let mut rows=Vec::new();
 for i in q.indices{if i>=meta.counts.all{return err(StatusCode::BAD_REQUEST,"invalid record index")}match record_at(&mut f,i){Ok(v)=>rows.push(v.json(i)),Err(e)=>return e}}
 Json(json!({"rows":rows})).into_response()
}
pub async fn serve(listener:TcpListener,app:App)->Result<(),String>{
 let last=app.last_ping.clone();
 let routes=Router::new()
 .route("/ping",post(ping))
 .route("/api/archives",get(archives))
 .route("/api/import",post(import))
 .route("/api/verify",post(verify))
 .route("/api/status",get(status))
 .route("/api/delete",post(delete))
 .route("/api/filter",post(filter))
 .route("/api/page",get(page))
 .route("/api/index",get(index))
 .route("/api/page-by-ids",post(page_ids))
 .route("/api/remote-tail",post(remote::remote_tail))
 .route("/api/remote-trace",post(remote::remote_trace))
 .fallback(static_file).layer(middleware::from_fn_with_state(app.clone(),guard)).with_state(app);
 axum::serve(listener,routes).with_graceful_shutdown(async move{
  loop{tokio::time::sleep(std::time::Duration::from_secs(30)).await;
   if now_sec().saturating_sub(last.load(Ordering::Relaxed))>180{break}
  }
 }).await.map_err(|e|e.to_string())
}
#[cfg(test)]mod tests{
 use super::*;
 #[test]fn id_guard(){assert!(valid_id("0123456789abcdef0123456789abcdef"));assert!(!valid_id("../../etc/passwd"));assert!(!valid_id("small"));}
 #[test]fn stored_metadata_roundtrip(){let d=tempfile::tempdir().unwrap();std::env::set_var("JEUS_LENS_DATA_DIR",d.path());let app=new_app("127.0.0.1:123".into()).unwrap();let id="0123456789abcdef0123456789abcdef";fs::create_dir(app.root.join(id)).unwrap();let sm=Summary{id:id.into(),indexed:true,..Default::default()};fs::write(app.root.join(id).join("summary.json"),serde_json::to_vec(&sm).unwrap()).unwrap();assert!(load(&app,id).is_ok());assert!(load(&app,"../../windows").is_err());}
}
