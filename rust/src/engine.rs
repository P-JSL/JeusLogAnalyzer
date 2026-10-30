//! Native Rust streaming parser. Binary indexes and JSON fields match Go JEUS Lens.
use chrono::{Duration, NaiveDateTime, Timelike};
use encoding_rs::EUC_KR;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::{collections::HashMap,fs::{self,File},io::{BufWriter,Write},path::Path,sync::OnceLock};

pub const MAX_SOURCE:u64=1<<30;
pub const RECORD_BYTES:usize=24;
const MAX_INDEX_EVENTS:u64=(512*1024*1024)/24;
pub const SQL_TYPES:[&str;9]=["","SQL 문법·객체","제약조건","연결","타임아웃","잠금·동시성","자원","권한","기타 SQL"];
fn re(p:&'static str)->&'static Regex{
 static MAP:OnceLock<HashMap<&'static str,Regex>>=OnceLock::new();
 let all=MAP.get_or_init(||{
  const PATTERNS:&[&str]=&[
   r"(?i)^\[(\d{4}[./-]\d\d?[./-]\d\d? \d\d:\d\d:\d\d(?:[.,:]\d{3})?)\]\s*\[([0-7]|SEVERE|WARNING|WARN|INFO|CONFIG|FINE|FINER|FINEST|ALL|ERROR|FATAL|DEBUG|TRACE)\]\s*(?:\[([^\]\r\n]*)\])?\s*(?:\[([A-Za-z][\w.-]*-\d+)\])?\s*(.*)$",
   r"(?i)^\[?(\d{4}[./-]\d\d?[./-]\d\d?[ T]\d\d:\d\d:\d\d(?:[.,:]\d{3})?)\]?\s*[-|:]?\s*(?:\[?(SEVERE|ERROR|FATAL|WARN(?:ING)?|INFO|DEBUG|TRACE|CONFIG|FINE(?:R|ST)?|ALL)\]?)?\s*(.*)$",
   r"(?i)^\s*\[(SEVERE|ERROR|FATAL|WARN(?:ING)?|INFO|DEBUG|TRACE)\]\s*(.*)$",
   r"(?i)\b(?:java\.sql\.(?:[A-Za-z]*SQLException|[A-Za-z]+Exception)|(?:SQL|JDBC|PSQL)(?:[A-Za-z]*)Exception|org\.springframework\.(?:dao|jdbc)\.[\w.]*Exception|org\.apache\.ibatis\.[\w.]*Exception|org\.hibernate\.[\w.]*Exception|org\.postgresql\.util\.PSQLException|oracle\.jdbc\.[\w.]*Exception|com\.mysql\.[\w.]*Exception)\b",
   r"(?i)\b(?:ORA|PLS)-\d{4,5}\b",
   r"(?i)\bSQL\s*STATE\s*[:=]?\s*([A-Za-z0-9]{5})\b",
   r"(?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*(?:Exception|Error)\b",
   r"^\s*at\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\(",
   r"(?i)^\s*(?:at\s+[\w.$<>/]+\(|Caused by\s*:|Suppressed\s*:|\.\.\.\s+\d+\s+more|<<__Exception__>>|\[STDERR\]|Exception in thread)",
   r"(?i)(?:^|\s|:|\[|\()(?:ERROR|FATAL|SEVERE)(?:\b|\])",
   r"(?i)(?:^|\s|:|\[|\()(?:WARN|WARNING)(?:\b|\])",
  ];
  PATTERNS.iter().map(|p|(*p,Regex::new(p).expect("constant regexp"))).collect()
 });
 all.get(p).expect("constant regexp lookup")
}
const JEUS:&str=r"(?i)^\[(\d{4}[./-]\d\d?[./-]\d\d? \d\d:\d\d:\d\d(?:[.,:]\d{3})?)\]\s*\[([0-7]|SEVERE|WARNING|WARN|INFO|CONFIG|FINE|FINER|FINEST|ALL|ERROR|FATAL|DEBUG|TRACE)\]\s*(?:\[([^\]\r\n]*)\])?\s*(?:\[([A-Za-z][\w.-]*-\d+)\])?\s*(.*)$";
const DATED:&str=r"(?i)^\[?(\d{4}[./-]\d\d?[./-]\d\d?[ T]\d\d:\d\d:\d\d(?:[.,:]\d{3})?)\]?\s*[-|:]?\s*(?:\[?(SEVERE|ERROR|FATAL|WARN(?:ING)?|INFO|DEBUG|TRACE|CONFIG|FINE(?:R|ST)?|ALL)\]?)?\s*(.*)$";
const LEVEL:&str=r"(?i)^\s*\[(SEVERE|ERROR|FATAL|WARN(?:ING)?|INFO|DEBUG|TRACE)\]\s*(.*)$";
const SQL_EX:&str=r"(?i)\b(?:java\.sql\.(?:[A-Za-z]*SQLException|[A-Za-z]+Exception)|(?:SQL|JDBC|PSQL)(?:[A-Za-z]*)Exception|org\.springframework\.(?:dao|jdbc)\.[\w.]*Exception|org\.apache\.ibatis\.[\w.]*Exception|org\.hibernate\.[\w.]*Exception|org\.postgresql\.util\.PSQLException|oracle\.jdbc\.[\w.]*Exception|com\.mysql\.[\w.]*Exception)\b";
const ORA:&str=r"(?i)\b(?:ORA|PLS)-\d{4,5}\b";
const STATE:&str=r"(?i)\bSQL\s*STATE\s*[:=]?\s*([A-Za-z0-9]{5})\b";
const EX:&str=r"(?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*(?:Exception|Error)\b";
const FRAME:&str=r"^\s*at\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\(";
const CONT:&str=r"(?i)^\s*(?:at\s+[\w.$<>/]+\(|Caused by\s*:|Suppressed\s*:|\.\.\.\s+\d+\s+more|<<__Exception__>>|\[STDERR\]|Exception in thread)";
const FAILURE:&str=r"(?i)(?:^|\s|:|\[|\()(?:ERROR|FATAL|SEVERE)(?:\b|\])";
const WARN:&str=r"(?i)(?:^|\s|:|\[|\()(?:WARN|WARNING)(?:\b|\])";
fn capture<'a>(regex:&'static str,field:usize,s:&'a str)->Option<&'a str>{re(regex).captures(s).and_then(|m|m.get(field).map(|x|x.as_str()))}
fn find<'a>(regex:&'static str,s:&'a str)->Option<&'a str>{re(regex).find(s).map(|x|x.as_str())}
fn level(s:&str)->u8{match s.to_ascii_uppercase().as_str(){"0"|"SEVERE"|"ERROR"|"FATAL"=>1,"1"|"WARN"|"WARNING"=>2,_=>3}}
fn header(line:&str)->(bool,u8,String,String){
 if let Some(m)=re(JEUS).captures(line){return (true,level(&m[2]),m.get(5).map_or("",|m|m.as_str()).to_owned(),m.get(4).map_or("",|m|m.as_str()).to_owned());}
 if let Some(m)=re(DATED).captures(line){let t=m.get(2).map_or("",|x|x.as_str());return (true,if t.is_empty(){0}else{level(t)},m.get(3).map_or("",|x|x.as_str()).to_owned(),String::new());}
 if let Some(m)=re(LEVEL).captures(line){return (true,level(&m[1]),m.get(2).map_or("",|x|x.as_str()).to_owned(),String::new());}
 (false,0,String::new(),String::new())
}
fn sql_signal(s:&str)->bool{
 if !["Exception","exception","SQL","sql","ORA-","ora-","PLS-","pls-","Database","database","JDBC","jdbc"].iter().any(|x|s.contains(x)){return false}
 find(SQL_EX,s).is_some()||find(ORA,s).is_some()||capture(STATE,1,s).is_some()||s.to_ascii_lowercase().contains("error querying database")||s.to_ascii_lowercase().contains("error updating database")
}
fn failure(s:&str)->bool{
 if !["Exception","exception","Error","ERROR","FATAL","SEVERE","Caused by:"].iter().any(|x|s.contains(x)){return false}
 find(EX,s).is_some()||find(FAILURE,s).is_some()||s.contains("Caused by:")
}
pub fn sql_type(s:&str)->u8{
 let u=s.to_ascii_uppercase();
 let rules:&[(u8,&[&str])]=&[
 (2,&["ORA-00001","ORA-01400","ORA-02291","ORA-02292","CONSTRAINTVIOLATION","DATAINTEGRITYVIOLATION","SQLINTEGRITYCONSTRAINTVIOLATION"]),
 (5,&["ORA-00060","ORA-08177","DEADLOCK","CANNOTACQUIRELOCK","LOCKACQUISITION"]),
 (4,&["ORA-01013","ORA-00054","ORA-02049","QUERYTIMEOUT","SQLTIMEOUTEXCEPTION","TIMEOUTEXCEPTION"]),
 (3,&["ORA-01012","ORA-03113","ORA-03114","ORA-12154","ORA-12514","SQLNONTRANSIENTCONNECTION","SQLTRANSIENTCONNECTION","CANNOTGETJDBCCONNECTION","COMMUNICATIONS LINK FAILURE"]),
 (6,&["ORA-01653","ORA-01555","ORA-01652","ORA-04031","OUT OF MEMORY","RESOURCEEXCEPTION"]),
 (7,&["ORA-01031","ORA-00942: TABLE OR VIEW DOES NOT EXIST (PERMISSION)"]),
 (1,&["ORA-00900","ORA-00904","ORA-00907","ORA-00911","ORA-00933","ORA-00936","ORA-00942","BADSQLGRAMMAR","SQLSYNTAXERROR","SQLGRAMMAR"])
 ];
 for (n,tokens) in rules{if tokens.iter().any(|v|u.contains(v)){return *n}}
 if let Some(st)=capture(STATE,1,&u){if st.len()>=2{return match &st[..2]{"08"=>3,"23"=>2,"42"=>1,"40"=>5,"53"=>6,"28"=>7,_ if st=="HYT00"||st=="HYT01"=>4,_=>8}}}
 if sql_signal(s){8}else{0}
}
fn iso_minute(s:&str)->Option<NaiveDateTime>{
 if s.len()<16{return None}
 let raw=s.get(..16)?.replace(['.','/'],"-").replace('T'," ");
 NaiveDateTime::parse_from_str(&(raw+":00"),"%Y-%m-%d %H:%M:%S").ok()
}
fn clock_and_bucket(s:&str)->(String,String){
 let stamp=if s.starts_with('['){s.get(1..).and_then(|x|x.split(']').next()).unwrap_or("")}else{s};
 let Some(t)=iso_minute(stamp)else{return (String::new(),String::new())};
 let rounded=t-Duration::minutes((t.minute()%5)as i64);
 (t.format("%Y-%m-%d %H").to_string(),rounded.format("%Y-%m-%d %H:%M").to_string())
}
fn decode(raw:&[u8],enc:&str)->String{
 if enc=="euc-kr"{let (text,_,_)=EUC_KR.decode(raw);return text.into_owned()}
 if enc.starts_with("utf-16"){
  let bytes=if raw.len()>=2 && (raw.starts_with(&[255,254])||raw.starts_with(&[254,255])){&raw[2..]}else{raw};
  let codes=bytes.chunks_exact(2).map(|a|if enc=="utf-16le"{u16::from_le_bytes([a[0],a[1]])}else{u16::from_be_bytes([a[0],a[1]])}).collect::<Vec<_>>();
  return String::from_utf16_lossy(&codes);
 }
 String::from_utf8_lossy(raw.strip_prefix(&[239,187,191]).unwrap_or(raw)).into_owned()
}
pub fn encoding_of(sample:&[u8],asked:&str)->Result<String,String>{
 if sample.starts_with(&[255,254]){return Ok("utf-16le".into())}
 if sample.starts_with(&[254,255]){return Ok("utf-16be".into())}
 if !["auto","","utf-8","euc-kr"].contains(&asked){return Err("지원하지 않는 인코딩입니다".into())}
 if sample.contains(&0){return Err("바이너리 파일은 지원하지 않습니다".into())}
 if asked=="utf-8"||asked=="euc-kr"{return Ok(asked.into())}
 let x=if sample.len()>4{&sample[..sample.len()-4]}else{sample};
 Ok(if std::str::from_utf8(x).is_ok(){"utf-8"}else{"euc-kr"}.into())
}
#[derive(Default,Clone,Copy,Debug,PartialEq,Eq)]
pub struct Record{pub offset:u64,pub length:u32,pub line:u32,pub end_line:u32,pub level:u8,pub category:u8,pub subtype:u8,pub reserved:u8}
impl Record{
 pub fn bytes(self)->[u8;24]{let mut b=[0;24];b[..8].copy_from_slice(&self.offset.to_le_bytes());b[8..12].copy_from_slice(&self.length.to_le_bytes());b[12..16].copy_from_slice(&self.line.to_le_bytes());b[16..20].copy_from_slice(&self.end_line.to_le_bytes());b[20]=self.level;b[21]=self.category;b[22]=self.subtype;b[23]=self.reserved;b}
 pub fn from_bytes(b:&[u8])->Result<Self,String>{if b.len()!=24{return Err("invalid record".into())}Ok(Self{offset:u64::from_le_bytes(b[..8].try_into().unwrap()),length:u32::from_le_bytes(b[8..12].try_into().unwrap()),line:u32::from_le_bytes(b[12..16].try_into().unwrap()),end_line:u32::from_le_bytes(b[16..20].try_into().unwrap()),level:b[20],category:b[21],subtype:b[22],reserved:b[23]})}
 pub fn json(self,index:u64)->serde_json::Value{serde_json::json!({"index":index,"offset":self.offset,"length":self.length,"line":self.line,"endLine":self.end_line,"level":self.level,"category":self.category,"sqlType":SQL_TYPES.get(self.subtype as usize).filter(|x|!x.is_empty()).unwrap_or(&"기타 SQL"),"review":self.reserved&1!=0})}
 pub fn matches(self,g:&str)->bool{match g{"all"|""=>true,"sql"=>self.category==1,"otherError"=>self.category==0&&self.level==1,"error"=>self.level==1,"review"=>self.reserved&1!=0,"warning"=>self.level==2,"info"=>self.level==3,_=>g.strip_prefix("sql:").and_then(|x|x.parse::<u8>().ok()).map_or(false,|n|(1..=8).contains(&n)&&self.category==1&&self.subtype==n)}}
}
#[derive(Serialize,Deserialize,Default,Clone,Debug)]
pub struct Counts{pub all:u64,pub error:u64,pub warning:u64,pub info:u64,pub sql:u64,#[serde(rename="otherError")]pub other_error:u64,#[serde(default)]pub review:u64}
#[derive(Serialize,Deserialize,Clone,Debug)]
pub struct Pair{pub name:String,pub count:u64}
#[derive(Serialize,Deserialize,Clone,Debug)]
#[serde(rename_all="camelCase")]
pub struct Issue{pub id:String,pub name:String,pub count:u64,pub first_event:i64,pub last_event:i64}
#[derive(Serialize,Deserialize,Clone,Debug)]
#[serde(rename_all="camelCase")]
pub struct Hotspot{pub start:String,pub all:u64,pub errors:u64,pub warnings:u64,pub sql_errors:u64,pub first_error_event:i64,pub last_error_event:i64}
#[derive(Serialize,Deserialize,Clone,Debug)]
#[serde(rename_all="camelCase")]
pub struct Surge{pub start:String,pub errors:u64,pub all:u64,pub baseline_errors:u64,pub baseline_all:u64,pub first_error_event:i64,pub last_error_event:i64}
#[derive(Serialize,Deserialize,Clone,Debug,Default)]
#[serde(rename_all="camelCase")]
pub struct Summary{
 #[serde(default)]pub source_hash:String,#[serde(default)]pub storage_mode:String,#[serde(default)]pub metadata_bytes:u64,
 #[serde(default)]pub id:String,#[serde(default)]pub name:String,#[serde(default)]pub size:u64,#[serde(default)]pub encoding:String,
 #[serde(default)]pub imported:String,#[serde(rename="stats")]pub counts:Counts,#[serde(default)]pub lines:u64,
 #[serde(default)]pub top:Vec<Pair>,#[serde(default)]pub sql_top:Vec<Pair>,#[serde(default)]pub hourly:Vec<Pair>,
 #[serde(default)]pub sql_types:Vec<Pair>,#[serde(default)]pub indexed:bool,#[serde(default)]pub issue_version:u8,
 #[serde(default)]pub issues:Vec<Issue>,#[serde(default)]pub hotspots:Vec<Hotspot>,#[serde(default)]pub hotspot_limited:bool,
 #[serde(default)]pub error_surges:Vec<Surge>
}
fn ranked(map:HashMap<String,u64>,limit:usize)->Vec<Pair>{let mut v=map.into_iter().map(|(name,count)|Pair{name,count}).collect::<Vec<_>>();v.sort_by(|a,b|b.count.cmp(&a.count).then(a.name.cmp(&b.name)));v.truncate(limit);v}
fn wilson(a:u64,n:u64)->(f64,f64){if n==0{return (0.,1.)}let z=1.96;let n=n as f64;let p=a as f64/n;let scale=1.+z*z/n;let mid=(p+z*z/(2.*n))/scale;let spread=z*((p*(1.-p)+z*z/(4.*n))/n).sqrt()/scale;((mid-spread).max(0.),(mid+spread).min(1.))}
pub fn surges(b:&HashMap<String,Hotspot>)->Vec<Surge>{
 let mut keys=b.keys().cloned().collect::<Vec<_>>();keys.sort();let mut out=Vec::new();
 for key in keys{let n=&b[&key];if n.all<20||n.errors<5||n.first_error_event<0{continue}
  let Ok(t)=NaiveDateTime::parse_from_str(&(key.clone()+":00"),"%Y-%m-%d %H:%M:%S")else{continue};
  let p=(t-Duration::minutes(5)).format("%Y-%m-%d %H:%M").to_string();
  if !b.get(&p).is_some_and(|v|v.all>0){continue}
  let (mut be,mut ba,mut observed)=(0,0,0);
  for i in 1..=12{let k=(t-Duration::minutes(i*5)).format("%Y-%m-%d %H:%M").to_string();if let Some(v)=b.get(&k){if v.all>0{observed+=1;be+=v.errors;ba+=v.all;}}}
  if observed<6||ba<120{continue}
  let rate=n.errors as f64/n.all as f64;let old=be as f64/ba as f64;
  if rate<old+0.05||(be>0&&rate<2.*old)||wilson(n.errors,n.all).0<=wilson(be,ba).1{continue}
  out.push(Surge{start:key,errors:n.errors,all:n.all,baseline_errors:be,baseline_all:ba,first_error_event:n.first_error_event,last_error_event:n.last_error_event});
 }
 out.sort_by(|a,b|{let da=a.errors as f64/a.all as f64-a.baseline_errors as f64/a.baseline_all as f64;let db=b.errors as f64/b.all as f64-b.baseline_errors as f64/b.baseline_all as f64;db.total_cmp(&da).then(b.errors.cmp(&a.errors)).then(a.start.cmp(&b.start))});out.truncate(8);out
}
fn fnv64(b:&[u8])->u64{let mut n:u64=0xcbf29ce484222325;for x in b{n^=*x as u64;n=n.wrapping_mul(0x100000001b3)}if n==0{1}else{n}}
fn last_class(s:&str)->String{s.rsplit('.').next().unwrap_or(s).to_owned()}
#[derive(Default,Clone)]
struct Event{offset:u64,line:u32,end:u32,explicit:u8,failure:bool,suspect:bool,sql:bool,message:String,signature:String,sql_class:String,code:String,event_code:String,subtype:u8,clock:String,minute:String,root_class:String,frame:String}
pub struct Indexer{
 encoding:String,dir:std::path::PathBuf,idx:BufWriter<File>,issue:BufWriter<File>,carry:Vec<u8>,carry_len:u64,offset:u64,line_start:u64,previous:u8,line:u32,event:Option<Event>,pub summary:Summary,
 top:HashMap<String,u64>,sql_top:HashMap<String,u64>,types:HashMap<String,u64>,hourly:HashMap<String,u64>,hotspots:HashMap<String,Hotspot>,issues:HashMap<u64,Issue>,limited:bool
}
impl Indexer{
 pub fn new(path:&Path,encoding:&str)->Result<Self,String>{
  fs::create_dir_all(path).map_err(|e|e.to_string())?;
  let idx=BufWriter::with_capacity(1024*1024,File::create(path.join("index.part")).map_err(|e|e.to_string())?);
  let issue=BufWriter::with_capacity(256*1024,File::create(path.join("issues.part")).map_err(|e|e.to_string())?);
  Ok(Self{encoding:encoding.into(),dir:path.to_owned(),idx,issue,carry:Vec::with_capacity(2048),carry_len:0,offset:0,line_start:0,previous:0,line:0,event:None,summary:Summary{encoding:encoding.into(),indexed:true,issue_version:1,..Default::default()},top:HashMap::new(),sql_top:HashMap::new(),types:HashMap::new(),hourly:HashMap::new(),hotspots:HashMap::new(),issues:HashMap::new(),limited:false})
 }
 fn finish_event(&mut self)->Result<(),String>{
  let Some(st)=self.event.take()else{return Ok(())};
  let length=self.offset-st.offset;
  if length>u32::MAX as u64{return Err("single event length >4GiB".into())}
  if self.summary.counts.all>=MAX_INDEX_EVENTS{return Err("index limit 512MiB".into())}
  let level=if st.explicit>0{st.explicit}else if st.failure{1}else if re(WARN).is_match(&st.message){2}else{3};
  let category=if st.sql{1}else{0};
  let c=&mut self.summary.counts;
  let index=c.all;c.all+=1;
  if category==1{c.sql+=1;*self.types.entry(SQL_TYPES.get(st.subtype as usize).filter(|v|!v.is_empty()).unwrap_or(&"기타 SQL").to_string()).or_default()+=1;}
  if st.suspect&&level!=1{c.review+=1;}
  match level{1=>{c.error+=1;if category==0{c.other_error+=1}},2=>c.warning+=1,_=>c.info+=1}
  if level==1{let key=if !st.signature.is_empty()&&st.signature!="기타 오류"{st.signature.clone()}else if !st.event_code.is_empty(){st.event_code.clone()}else{"기타 오류".into()};if self.top.len()<5000||self.top.contains_key(&key){*self.top.entry(key).or_default()+=1}}
  if category==1{let key=if !st.code.is_empty(){st.code.clone()}else if !st.sql_class.is_empty(){st.sql_class.clone()}else{"SQL 관련 오류".into()};if self.sql_top.len()<5000||self.sql_top.contains_key(&key){*self.sql_top.entry(key).or_default()+=1}}
  if !st.clock.is_empty(){*self.hourly.entry(st.clock.clone()).or_default()+=1}
  if !st.minute.is_empty(){
   if !self.hotspots.contains_key(&st.minute)&&self.hotspots.len()>=50000{self.limited=true}
   else{let h=self.hotspots.entry(st.minute.clone()).or_insert(Hotspot{start:st.minute,all:0,errors:0,warnings:0,sql_errors:0,first_error_event:-1,last_error_event:-1});h.all+=1;
    if level==1{h.errors+=1;if category==1{h.sql_errors+=1}if h.first_error_event<0{h.first_error_event=index as i64}h.last_error_event=index as i64}else if level==2{h.warnings+=1}
   }
  }
  let mut issue_id=0u64;
  if level==1||category==1||st.suspect{
   let cls=if !st.root_class.is_empty(){st.root_class}else if !st.sql_class.is_empty(){st.sql_class}else if !st.signature.is_empty()&&st.signature!="기타 오류"{st.signature}else{"기타 오류".into()};
   let label=if !st.code.is_empty(){format!("{} · {}",st.code,cls)}else{cls.clone()};
   let mut key=format!("v1|sql={}|code={}|class={}",if category==1{"true"}else{"false"},st.code,cls);
   if category==0{key.push_str(&format!("|frame={}|jeus={}",st.frame,st.event_code))}
   issue_id=fnv64(key.as_bytes());
   if let Some(v)=self.issues.get_mut(&issue_id){v.count+=1;v.last_event=index as i64}
   else if self.issues.len()<5000{self.issues.insert(issue_id,Issue{id:format!("{issue_id:016x}"),name:label,count:1,first_event:index as i64,last_event:index as i64});}
   else{issue_id=1;let v=self.issues.entry(1).or_insert(Issue{id:"0000000000000001".into(),name:"기타 오류 그룹 (그룹 수 제한)".into(),count:0,first_event:index as i64,last_event:index as i64});v.count+=1;v.last_event=index as i64}
  }
  self.idx.write_all(&Record{offset:st.offset,length:length as u32,line:st.line,end_line:st.end,level,category,subtype:st.subtype,reserved:u8::from(st.suspect&&level!=1)}.bytes()).map_err(|e|e.to_string())?;
  self.issue.write_all(&issue_id.to_le_bytes()).map_err(|e|e.to_string())?;Ok(())
 }
 fn line_done(&mut self)->Result<(),String>{
  self.line=self.line.checked_add(1).ok_or("too many log lines")?;
  let text=decode(&self.carry,&self.encoding);let clean=text.trim_end_matches(['\r','\n']);
  let sample=clean.get(..clean.len().min(1024)).unwrap_or(clean);
  let (hdr,lev,msg,event_code)=header(sample);
  let new_event=hdr||self.event.is_none()||self.event.as_ref().is_some_and(|v|v.explicit==0&&!clean.starts_with([' ','\t'])&&!clean.trim().is_empty()&&!re(CONT).is_match(clean));
  if new_event{
   // A new header begins at the start of the current line, not at its end.
   // The incoming bytes have already advanced offset to the next line.
   let after_line=self.offset;self.offset=self.line_start;
   let flushed=self.finish_event();self.offset=after_line;flushed?;
   let (clock,minute)=if hdr{clock_and_bucket(clean)}else{(String::new(),String::new())};
   self.event=Some(Event{offset:self.line_start,line:self.line,end:self.line,explicit:lev,message:if msg.is_empty(){clean.into()}else{msg},event_code,clock,minute,..Default::default()});}
  else if let Some(v)=self.event.as_mut(){v.end=self.line}
  if let Some(v)=self.event.as_mut(){
   if sql_signal(clean){v.sql=true;let t=sql_type(clean);if t!=0&&(v.subtype==0||v.subtype==8){v.subtype=t}
    if v.sql_class.is_empty(){if let Some(x)=find(SQL_EX,clean){v.sql_class=last_class(x)}}
    if v.code.is_empty(){if let Some(x)=find(ORA,clean){v.code=x.to_ascii_uppercase()}else if let Some(x)=capture(STATE,1,clean){v.code=format!("SQLSTATE {}",x.to_ascii_uppercase())}}
   }
   let vendor=["ORA-","ora-","PLS-","pls-"].iter().any(|x|clean.contains(x));
   if failure(clean)||(vendor&&find(ORA,clean).is_some()){v.suspect=true;if v.explicit==0{v.failure=true}}
   if clean.contains("Caused by:"){if let Some(x)=find(EX,clean){v.root_class=last_class(x);v.frame.clear()}}
   if v.frame.is_empty(){if let Some(x)=capture(FRAME,1,clean){v.frame=x.into()}}
   if (v.explicit==1||v.failure||v.sql||v.suspect)&&(v.signature.is_empty()||(v.sql&&!v.code.is_empty())){
    v.signature=if v.sql{if let Some(x)=find(ORA,clean){x.to_ascii_uppercase()}else if let Some(x)=find(SQL_EX,clean){last_class(x)}else if let Some(x)=capture(STATE,1,clean){format!("SQLSTATE {}",x.to_ascii_uppercase())}else{"Database error".into()}}
     else if let Some(x)=find(EX,clean){last_class(x)}else{"기타 오류".into()};
   }
  }
  self.carry.clear();self.carry_len=0;self.line_start=self.offset;Ok(())
 }
 pub fn feed(&mut self,bytes:&[u8])->Result<(),String>{
  // Scan complete byte segments without retaining a raw log. Preserve exact byte offsets.
  if self.encoding.starts_with("utf-16"){
   for &b in bytes{self.offset+=1;self.carry_len+=1;
    if self.carry.len()<65536{self.carry.push(b)}
    if self.carry_len%2==0{
     // Use the previous byte, not the bounded 64 KiB prefix: a newline
     // following a huge UTF-16 line must still terminate that line.
     let newline=if self.encoding=="utf-16le"{self.previous==10&&b==0}else{self.previous==0&&b==10};
     if newline{self.line_done()?}
    }
    self.previous=b;
   }
  }else{
   for &b in bytes{self.offset+=1;self.carry_len+=1;if self.carry.len()<65536{self.carry.push(b)}if b==10{self.line_done()?}}
  }
  Ok(())
 }
 pub fn finish(mut self)->Result<Summary,String>{
  if self.carry_len>0{self.line_done()?}self.finish_event()?;
  self.idx.flush().map_err(|e|e.to_string())?;self.issue.flush().map_err(|e|e.to_string())?;
  self.idx.get_ref().sync_all().map_err(|e|e.to_string())?;self.issue.get_ref().sync_all().map_err(|e|e.to_string())?;
  drop(self.idx);drop(self.issue);
  fs::rename(self.dir.join("index.part"),self.dir.join("index.bin")).map_err(|e|e.to_string())?;
  fs::rename(self.dir.join("issues.part"),self.dir.join("issues.bin")).map_err(|e|e.to_string())?;
  self.summary.lines=self.line as u64;self.summary.top=ranked(self.top,8);self.summary.sql_top=ranked(self.sql_top,8);self.summary.sql_types=ranked(self.types,10);
  self.summary.hourly=self.hourly.into_iter().map(|(name,count)|Pair{name,count}).collect();self.summary.hourly.sort_by(|a,b|a.name.cmp(&b.name));
  self.summary.error_surges=surges(&self.hotspots);
  self.summary.hotspots=self.hotspots.into_values().filter(|v|v.errors>0).collect();
  self.summary.hotspots.sort_by(|a,b|b.errors.cmp(&a.errors).then(b.sql_errors.cmp(&a.sql_errors)).then(a.start.cmp(&b.start)));self.summary.hotspots.truncate(12);
  self.summary.hotspot_limited=self.limited;
  self.summary.issues=self.issues.into_values().collect();self.summary.issues.sort_by(|a,b|b.count.cmp(&a.count).then(a.id.cmp(&b.id)));self.summary.issues.truncate(100);
  Ok(self.summary)
 }
}
#[cfg(test)]
mod tests{
 use super::*;
 #[test]fn binary_layout(){let r=Record{offset:500,length:3,line:22,end_line:30,level:3,category:1,subtype:2,reserved:1};assert_eq!(Record::from_bytes(&r.bytes()).unwrap(),r);assert!(r.matches("review"));assert!(r.matches("sql:2"));assert!(!r.matches("error"));assert_eq!(r.bytes().len(),24);}
 #[test]fn sql_categories(){let entries=[("java.sql.SQLSyntaxErrorException ORA-00904",1),("Caused by: java.sql.SQLIntegrityConstraintViolationException: ORA-00001",2),("java.sql.SQLRecoverableException: ORA-03113",3),("SQLState: 08006",3),("SQLException ORA-01013",4),("SQLException ORA-00060",5),("ORA-01653",6),("ORA-01031",7),("java.sql.SQLException unexpected",8),("INFO SQL query finished normally",0)];for(s,n)in entries{assert_eq!(sql_type(s),n,"{s}")}}
 #[test]fn stream_offsets_and_sql(){let dir=tempfile::tempdir().unwrap();let input="[2026.10.23 09:01:01][2] [ms1-1] [SERVER-0001] ready\n[2026.10.23 09:01:02][0] [ms1-1] [APP-0002] transaction failed\nCaused by: java.sql.SQLSyntaxErrorException: ORA-00904\n  at demo.Service.run(Service.java:8)\n[2026.10.23 09:01:03][1] [x] [APP-0003] warning\n";let mut e=Indexer::new(dir.path(),"utf-8").unwrap();for b in input.as_bytes().chunks(7){e.feed(b).unwrap()}let s=e.finish().unwrap();assert_eq!((s.counts.all,s.counts.error,s.counts.warning,s.counts.sql),(3,1,1,1));let b=fs::read(dir.path().join("index.bin")).unwrap();assert_eq!(b.len(),72);let r=Record::from_bytes(&b[24..48]).unwrap();assert_eq!((r.line,r.end_line,r.subtype),(2,4,1));assert!(input.as_bytes()[r.offset as usize..(r.offset+r.length as u64)as usize].windows(9).any(|v|v==b"ORA-00904"));}
 #[test]fn info_review(){let dir=tempfile::tempdir().unwrap();let text="[2026-10-22 08:00:00.000][INFO][W-1][102][TRACE1][Request][Service] - failed\nCaused by: java.sql.SQLException: ORA-12899\n[2026-10-22 08:00:02.000][ERROR][W-1][102][TRACE1][Request][Service] - normal\n";let mut e=Indexer::new(dir.path(),"utf-8").unwrap();e.feed(text.as_bytes()).unwrap();let s=e.finish().unwrap();assert_eq!(s.counts.all,2);assert_eq!(s.counts.review,1);assert_eq!(s.counts.error,1);}
 #[test]fn surge_evidence(){let mut b=HashMap::new();for i in 0..12{let key=format!("2026-10-23 10:{:02}",i*5);b.insert(key.clone(),Hotspot{start:key,all:25,errors:1,warnings:0,sql_errors:0,first_error_event:i,last_error_event:i});}let key="2026-10-23 11:00";b.insert(key.into(),Hotspot{start:key.into(),all:30,errors:15,warnings:0,sql_errors:0,first_error_event:300,last_error_event:314});assert_eq!(surges(&b).len(),1);}
 #[test]fn utf16_offset(){let dir=tempfile::tempdir().unwrap();let s="[2026.10.23 10:00:00][0] ORA-00904\n";let mut bytes=vec![255,254];for c in s.encode_utf16(){bytes.extend_from_slice(&c.to_le_bytes())}let mut e=Indexer::new(dir.path(),"utf-16le").unwrap();for part in bytes.chunks(3){e.feed(part).unwrap()}let sm=e.finish().unwrap();assert_eq!(sm.counts.all,1);let b=fs::read(dir.path().join("index.bin")).unwrap();assert_eq!(Record::from_bytes(&b).unwrap().length as usize,bytes.len());}
}
