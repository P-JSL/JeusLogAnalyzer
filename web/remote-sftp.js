'use strict';
// The connection log is held in DOM memory only: never persist SSH secrets,
// server paths, raw remote log messages or full SSH exceptions.
(function(){
 const el=id=>document.getElementById(id);
 const connect=el('remoteConnect'),readButton=el('remoteRead'),disconnect=el('remoteDisconnect');
 const status=el('remoteStatus'),output=el('remoteOutput'),traceOutput=el('remoteTraceOutput');
 let busy=false,refresh=null,controller=null,generation=0;
 const fields=['remoteHost','remotePort','remoteUser','remotePass','remoteFingerprint','remotePath'];
 const logLines=[];
 const codes={START:'접속 시작',VALID:'입력 검증',CONNECTING:'TCP/SSH 연결 시도',CONNECTED:'TCP 연결 성공',SSH_CONNECTED:'SSH 연결 성공',
  CHECKING:'서버 신원 검증',MATCHED:'서버 신원 확인',HANDSHAKE:'SSH 핸드셰이크',AUTHENTICATING:'계정 인증',
  AUTHENTICATED:'인증 성공',OPENING:'SFTP 개설',READY:'SFTP 연결 성공',LSTAT:'파일 검사',FILE_VERIFIED:'파일 검사 완료',
  READING:'로그 읽기',READ_COMPLETE:'읽기 성공',DONE:'정상 완료',AUTH_FAILED:'인증 실패',HOSTKEY_MISMATCH:'서버 지문 불일치',
  SSH_CONNECT:'연결 실패',TCP_REFUSED:'연결 거부',TCP_TIMEOUT:'연결 시간 초과',DNS_FAILURE:'DNS 조회 실패',
  FILE_STAT_FAILED:'파일 접근 실패',OPEN_DENIED:'파일 열기 실패',SFTP_UNAVAILABLE:'SFTP 사용 불가',
  SSH_TIMEOUT:'접속 제한 시간 초과',INVALID_CONFIG:'입력값 오류'};
 function values(){return {host:el('remoteHost').value.trim(),port:Number(el('remotePort').value),user:el('remoteUser').value,
  password:el('remotePass').value,fingerprint:el('remoteFingerprint').value.trim(),path:el('remotePath').value.trim(),maxBytes:512*1024}}
 function tab(which){
  const trace=which==='trace';
  el('remoteTabContent').setAttribute('aria-selected',String(!trace));
  el('remoteTabTrace').setAttribute('aria-selected',String(trace));
  el('remotePreviewPanel').classList.toggle('hidden',trace);
  el('remoteTracePanel').classList.toggle('hidden',!trace);
 }
 function addTrace(event){
  const stamp=event.time?new Date(event.time):new Date();
  const ts=Number.isNaN(stamp.getTime())?new Date().toLocaleTimeString('ko-KR'):stamp.toLocaleTimeString('ko-KR',{hour12:false});
  const level=['success','info','error'].includes(event.level)?event.level:'info';
  const code=String(event.code||event.stage||'INFO').slice(0,48);
  const detail=String(event.message||codes[code]||'단계 완료').slice(0,600);
  const entry={ts,level,code,detail};
  logLines.push(entry);if(logLines.length>400)logLines.shift();
  while(traceOutput.childNodes.length>400)traceOutput.removeChild(traceOutput.firstChild);
  if(traceOutput.childNodes.length===1&&traceOutput.firstChild.nodeType===3)traceOutput.replaceChildren();
  const row=document.createElement('div');row.className='remote-trace-line remote-trace-'+level;
  const prefix=document.createElement('span');prefix.className='remote-trace-key';prefix.textContent='['+ts+'] ['+(codes[code]||code)+'] ';
  const message=document.createElement('span');message.textContent=detail;
  row.append(prefix,message);traceOutput.append(row);
  el('remoteTraceCount').textContent=String(logLines.length);
  traceOutput.scrollTop=traceOutput.scrollHeight;
  if(level==='error'){status.textContent='연결 실패 ['+code+'] '+detail;tab('trace')}
 }
 function stopAuto(){if(refresh){clearInterval(refresh);refresh=null}}
 function stop(){
  generation++;
  if(controller){controller.abort();controller=null}
  busy=false;connect.disabled=false;readButton.disabled=false;disconnect.disabled=true;
  el('remoteAuto').checked=false;stopAuto();
  status.textContent='원격 연결 중단 · 현재 요청을 종료했습니다.';
  addTrace({level:'info',stage:'disconnect',code:'DISCONNECTED',message:'사용자가 원격 요청을 중단했습니다. 새 접속 시 다른 SSH/SFTP 연결을 생성합니다.'});
 }
 function showData(data){
  const binary=atob(data.data||'');
  const bytes=Uint8Array.from(binary,char=>char.charCodeAt(0));
  const decoded=new TextDecoder(el('remoteEncoding').value,{fatal:false}).decode(bytes);
  output.textContent=(data.partial?'[파일 끝부분 512KiB만 표시합니다. 앞부분은 포함되지 않습니다.]\n':'')+decoded;
  status.textContent='조회 완료 · 원격 크기 '+Number(data.size).toLocaleString('ko-KR')+' bytes · '+new Date().toLocaleTimeString('ko-KR');
 }
 async function runTrace(manual=true){
  if(busy||document.hidden)return;
  const id=++generation;
  const abort=new AbortController();controller=abort;busy=true;
  connect.disabled=true;readButton.disabled=true;disconnect.disabled=false;
  if(manual){logLines.length=0;traceOutput.replaceChildren();el('remoteTraceCount').textContent='0';tab('trace')}
  status.textContent='SSH/SFTP 연결을 시작합니다…';
  let terminal=false;
  try{
   const res=await fetch('/api/remote-trace',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(values()),cache:'no-store',signal:abort.signal});
   if(!res.ok)throw Error('HTTP '+res.status+' · SSH 진단 연결 요청이 차단되었습니다.');
   if(!res.body)throw Error('브라우저가 단계별 스트리밍 응답을 지원하지 않습니다.');
   let carry='';const decoder=new TextDecoder();const reader=res.body.getReader();
   const consume=(line)=>{
    if(!line.trim())return;
    let event;try{event=JSON.parse(line)}catch{throw Error('서버 진단 응답 해석에 실패했습니다.')}
    if(id!==generation)return;
    if(event.code==='DONE'){showData(event);terminal=true;}
    else if(event.level==='error')terminal=true;
    // Never record raw remote data or authentication material.
    addTrace({stage:event.stage,code:event.code,level:event.level,message:event.message,time:event.time});
   };
   while(true){
    const {done,value}=await reader.read();if(done)break;
    carry+=decoder.decode(value,{stream:true});
    if(carry.length>1024*1024)throw Error('서버 진단 메시지가 크기 제한을 초과했습니다.');
    let eol;while((eol=carry.indexOf('\n'))>=0){const line=carry.slice(0,eol);carry=carry.slice(eol+1);consume(line)}
   }
   carry+=decoder.decode();if(carry.trim())consume(carry);
   if(!terminal){addTrace({level:'error',code:'STREAM_CLOSED',message:'SSH 요청이 결과 없이 종료됐습니다. 네트워크 또는 서버 로그를 확인하세요.'})}
  }catch(error){
   if(id!==generation)return;
   if(error.name==='AbortError'){addTrace({level:'info',code:'CANCELLED',message:'연결 요청이 취소되었습니다.'})}
   else{addTrace({level:'error',code:'REQUEST_FAILED',message:'진단 스트림 오류: '+String(error.message||'알 수 없는 오류').slice(0,200)})}
  }finally{
   if(id===generation){
    controller=null;busy=false;connect.disabled=false;readButton.disabled=false;disconnect.disabled=true;
    if(logLines.some(x=>x.level==='error')){el('remoteAuto').checked=false;stopAuto()}
   }
  }
 }
 function updateAuto(){stopAuto();if(el('remoteAuto').checked)refresh=setInterval(()=>{if(!document.hidden)void runTrace(false)},10000)}
 connect.addEventListener('click',()=>void runTrace(true));
 readButton.addEventListener('click',()=>void runTrace(true));
 disconnect.addEventListener('click',stop);
 el('remoteTabTrace').addEventListener('click',()=>tab('trace'));
 el('remoteTabContent').addEventListener('click',()=>tab('preview'));
 el('remoteTraceClear').addEventListener('click',()=>{logLines.length=0;traceOutput.replaceChildren();traceOutput.textContent='진단 기록을 지웠습니다.';el('remoteTraceCount').textContent='0'});
 el('remoteTraceCopy').addEventListener('click',()=>{void navigator.clipboard?.writeText(logLines.map(v=>'['+v.ts+'] ['+v.code+'] '+v.detail).join('\n')).catch(()=>{status.textContent='클립보드 복사를 허용하지 않는 브라우저입니다.'})});
 el('remoteAuto').addEventListener('change',updateAuto);
 for(const field of fields){el(field).addEventListener('change',()=>{el('remoteAuto').checked=false;stopAuto()})}
 window.addEventListener('pagehide',()=>{if(controller)controller.abort();stopAuto()});
})();
