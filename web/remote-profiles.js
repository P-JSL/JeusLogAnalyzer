'use strict';
// Session-only connection presets. Passwords, log contents and connection
// diagnostic traces are NEVER written to storage or saved in a preset.
(function(){
 const el=id=>document.getElementById(id);
 const profiles={
  jeus:{name:'JEUS',kind:'app',placeholder:'/opt/jeus/logs/JeusServer.log',hint:'JEUS 예시: JeusServer.log, server.log, server.log.1. 실제 위치는 JEUS 로그 설정에서 확인하세요.'},
  webtob:{name:'WebtoB',kind:'access',placeholder:'/opt/webtob/log/access_20261030.log',hint:'WebtoB 5 예시: log/access_YYYYMMDD.log, log/error_YYYYMMDD.log, log/system_YYYYMMDD.log. WebtoB 6 예시: webtob_access.log, webtob_error.log, webtob_system.log. 절대경로는 해당 서버의 LOGGING 설정과 설치 경로에 따라 다릅니다.'},
  tomcat:{name:'Tomcat / JBoss',kind:'app',placeholder:'/opt/tomcat/logs/catalina.out',hint:'Tomcat 예시: catalina.out, localhost_access_log.2026-10-30.txt, catalina.2026-10-30.log. JBoss/WildFly 예시: standalone/log/server.log.'},
  spring:{name:'Spring Boot / Java',kind:'app',placeholder:'/opt/apps/logs/application.log',hint:'Spring Boot / Java 예시: application.log, app.log, gc.log.0.current. 각 애플리케이션 로그 설정에서 정확한 위치를 확인하세요.'},
  nginx:{name:'Nginx',kind:'access',placeholder:'/var/log/nginx/access.log',hint:'Nginx 예시: /var/log/nginx/access.log, /var/log/nginx/error.log, access.log.1. 파일 경로는 설정에 따라 변경될 수 있습니다.'},
  apache:{name:'Apache HTTP Server',kind:'access',placeholder:'/var/log/httpd/access_log',hint:'Apache 예시: /var/log/httpd/access_log, /var/log/httpd/error_log, /var/log/apache2/access.log. 설치 환경에 따라 다릅니다.'},
  linux:{name:'Linux OS',kind:'system',placeholder:'/var/log/syslog',hint:'Linux 예시: /var/log/syslog, /var/log/messages, /var/log/secure, /var/log/auth.log. 일부 시스템은 journald에만 기록하므로 별도 파일이 없을 수 있습니다. 명령 실행은 지원하지 않습니다.'},
  other:{name:'기타 SFTP 서버',kind:'auto',placeholder:'/var/log/custom-service.log',hint:'원격 서버의 SSH/SFTP에 로그인해 접근 가능한 일반 텍스트 로그의 절대경로를 입력하세요. 지원: .log/.out/.txt/.trace/.err/.error/.audit/.jsonl 및 날짜별 회전 파일. .gz/.zip 등 압축 파일은 지원하지 않습니다.'}
 };
 const source=el('remoteService'),kind=el('remoteLogKind'),path=el('remotePath'),label=el('remoteTargetName'),list=el('remoteTargetList');
 const saved=[];let nextId=1;let selected='',lastText='',lastPartial=false;
 function profileChange(){
  const profile=profiles[source.value]||profiles.other;
  path.placeholder=profile.placeholder;
  el('remoteServiceHint').textContent=profile.hint+' · WebtoB/JEUS 서비스 포트가 아니라 해당 호스트의 SSH/SFTP 포트를 사용하세요.';
  // A user-chosen file path is never overwritten on a service change.
  kind.value=profile.kind;
  resetPreview();
 }
 function resetPreview(){
  lastText='';lastPartial=false;
  el('remoteOutput').textContent='';
  el('remoteLogSummary').textContent='선택한 서버의 원격 로그를 조회하면 최근 파일 끝부분을 분석합니다.';
 }
 function snapshot(){
  return {id:selected,name:label.value.trim().slice(0,80),service:source.value,kind:kind.value,
   host:el('remoteHost').value.trim(),port:el('remotePort').value,user:el('remoteUser').value,
   fingerprint:el('remoteFingerprint').value.trim(),path:path.value.trim(),encoding:el('remoteEncoding').value};
 }
 function choose(id){
  if(el('remoteDisconnect')?.disabled===false)el('remoteDisconnect').click();
  if(el('remoteAuto').checked){el('remoteAuto').checked=false;el('remoteAuto').dispatchEvent(new Event('change'))}
  selected=id;const match=saved.find(x=>x.id===id);
  if(!match){label.value='';for(const id of ['remoteHost','remoteUser','remotePass','remoteFingerprint','remotePath'])el(id).value='';el('remotePort').value='22';source.value='jeus';kind.value='app';profileChange();return}
  label.value=match.name;source.value=match.service;kind.value=match.kind;
  for(const key of ['host','port','user','fingerprint','path']){
   const ids={host:'remoteHost',port:'remotePort',user:'remoteUser',fingerprint:'remoteFingerprint',path:'remotePath'};
   el(ids[key]).value=match[key];
  }
  el('remoteEncoding').value=match.encoding;
  el('remotePass').value=''; // Credentials are not duplicated or carried across server profiles.
  profileChange();kind.value=match.kind;
  el('remoteStatus').textContent=match.name+' 선택됨 · 비밀번호를 다시 입력하고 연결하세요.';
  el('remoteTraceClear').click();
 }
 function renderTargets(){
  list.replaceChildren(new Option('새 연결',''));
  for(const x of saved)list.append(new Option(x.name+' · '+(profiles[x.service]?.name||'기타')+' · '+x.host,x.id));
  list.value=selected;
 }
 function save(){
  const value=snapshot();if(!value.host||!value.path){el('remoteStatus').textContent='접속 대상 저장: 호스트 주소와 절대 로그 경로를 입력하세요.';return}
  if(!value.name)value.name=(profiles[value.service]?.name||'서버')+' · '+value.host;
  const idx=saved.findIndex(x=>x.id===selected);
  if(idx>=0){value.id=selected;saved[idx]=value}
  else{
   if(saved.length>=15){el('remoteStatus').textContent='현재 세션의 접속 대상은 최대 15개까지 저장할 수 있습니다.';return}
   value.id='target-'+nextId++;saved.push(value);selected=value.id;
  }
  label.value=value.name;renderTargets();
  el('remoteStatus').textContent=value.name+' 대상 정보 저장됨 (현재 브라우저 메모리만, 비밀번호 제외).';
 }
 function remove(){
  if(!selected)return;
  const idx=saved.findIndex(x=>x.id===selected);
  if(idx>=0)saved.splice(idx,1);
  selected='';renderTargets();choose('');
  el('remoteStatus').textContent='접속 대상이 현재 세션 목록에서 제거됐습니다.';
 }
 function detect(line,mode){
  // Recognize standard quoted HTTP request/status pairs only for access or auto.
  const httpAllowed=mode==='auto'||mode==='access';
  const match=httpAllowed?/"(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|CONNECT|TRACE)\s[^"]*"\s+([1-5][0-9]{2})\b/i.exec(line):null;
  const status=match?Number(match[1]):0;
  // JEUS numeric severity 0=error, 1=warning, independent of message text.
  const jeus=/^\[\d{4}[.\-/]\d{1,2}[.\-/]\d{1,2}[ T]\d{2}:\d{2}:\d{2}[^\]\r\n]*\]\s*\[([0-7])\](?=\s|\[)/.exec(line);
  const explicit=jeus?jeus[1]:null;
  const error=explicit==='0'||(explicit===null&&(status>=500||/\b(?:ERROR|FATAL|SEVERE|CRITICAL|EXCEPTION|PANIC|SQLSTATE)\b|ORA-\d{5}/i.test(line)));
  const warning=explicit==='1'||(explicit===null&&!error&&(status>=400||/\bWARN(?:ING)?\b/i.test(line)));
  return {http:Boolean(match),status,error,warning};
 }
 function summarize(text,mode){
  const lines=text.split(/\r?\n/);
  if(lines.at(-1)==='')lines.pop();
  const results=lines.map(line=>detect(line,mode));
  const counts={errors:0,warnings:0,http:0,server:0,client:0};
  for(const e of results){if(e.error)counts.errors++;if(e.warning)counts.warnings++;if(e.http)counts.http++;if(e.status>=500)counts.server++;else if(e.status>=400)counts.client++}
  return {lines,results,counts};
 }
 function renderPreview(){
  if(!lastText){resetPreview();return}
  const analysis=summarize(lastText,kind.value);
  const {lines,results,counts}=analysis;
  const filter=el('remoteLineFilter').value;
  let visible=0;
  const selectedLines=[];
  for(let i=0;i<lines.length;i++){
   const r=results[i];
   const include=filter==='all'||(filter==='error'&&r.error)||(filter==='warning'&&r.warning)||(filter==='http'&&r.http);
   if(include){selectedLines.push(lines[i]);visible++}
  }
  const prefix=lastPartial?'[마지막 512KiB만 읽었습니다. 첫 번째 줄이 잘렸을 수 있습니다.]\n':'';
  el('remoteOutput').textContent=prefix+(selectedLines.join('\n')||'(선택한 조건에 해당하는 로그 행이 없습니다.)');
  const httpCount=(kind.value==='auto'||kind.value==='access')
   ?' · HTTP 요청 '+counts.http+' (5xx '+counts.server+', 4xx '+counts.client+', 표준 요청 형식만 인식)'
   :' · HTTP 분석 제외 ('+kind.options[kind.selectedIndex].textContent+')';
  el('remoteLogSummary').textContent='최근 구간 '+lines.length.toLocaleString('ko-KR')+'행 · 오류 '+counts.errors+' · 경고 '+counts.warnings+
   httpCount+' · 표시 '+visible+'행';
 }
 window.RemoteLogProfiles={
  onData(text,data){lastText=text;lastPartial=Boolean(data?.partial);renderPreview()},
  clear:resetPreview,
  profileNames:profiles
 };
 source.addEventListener('change',profileChange);
 kind.addEventListener('change',renderPreview);
 list.addEventListener('change',()=>choose(list.value));
 el('remoteTargetSave').addEventListener('click',save);
 el('remoteTargetRemove').addEventListener('click',remove);
 el('remoteLineFilter').addEventListener('change',renderPreview);
 window.addEventListener('pagehide',()=>{saved.length=0;selected='';lastText='';});
 profileChange();
})();
