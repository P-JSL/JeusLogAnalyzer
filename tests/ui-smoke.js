/* Chromium CDP UI smoke. This managed Chromium blocks localhost page navigation.
   Load exact packaged HTML/CSS/JS into about:blank, with a deterministic mock API.
   Backend routing/storage are independently tested via Go + api-smoke.js. */
'use strict';
const {spawn} = require('node:child_process');
const fs=require('node:fs');const path=require('node:path');const os=require('node:os');
const assert=require('node:assert/strict');
const root=path.join(__dirname,'..'),html=fs.readFileSync(path.join(root,'web/index.html'),'utf8'),css=fs.readFileSync(path.join(root,'web/style.css'),'utf8'),parser=fs.readFileSync(path.join(root,'web/parser.js'),'utf8'),app=fs.readFileSync(path.join(root,'web/app.js'),'utf8');
const diagnostics=fs.readFileSync(path.join(root,'web/diagnostics.js'),'utf8');
const remoteUI=fs.readFileSync(path.join(root,'web/remote-sftp.js'),'utf8');
const updaterUI=fs.readFileSync(path.join(root,'web/updater.js'),'utf8');
const delay=t=>new Promise(r=>setTimeout(r,t));
const captureDocs=process.env.JEUS_LENS_DOC_SCREENSHOTS==='1';
async function saveDocsScreenshot(filename,positionSelector){
 if(!captureDocs)return;
 if(positionSelector)await js(`document.querySelector(${JSON.stringify(positionSelector)}).scrollIntoView({block:'start',behavior:'instant'})`);
 await delay(150);
 const snapshot=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
 const folder=path.join(root,'docs','images');fs.mkdirSync(folder,{recursive:true});
 fs.writeFileSync(path.join(folder,filename),Buffer.from(snapshot.data,'base64'));
}
let chrome,ws,index=0,pending=new Map();
async function until(fn,timeout=12000){let last;let start=Date.now();while(Date.now()-start<timeout){try{last=await fn();if(last)return last;}catch{}await delay(120);}throw Error('timeout: '+String(last));}
async function call(method,params={}){return new Promise((resolve,reject)=>{let id=++index;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});}
async function js(code){const result=await call('Runtime.evaluate',{expression:code,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));return result.result.value;}
const mock=`
(()=>{
window.mockSummary={issueVersion:1,issues:[{id:'0123456789abcdef',name:'ORA-00904 · SQLException',count:1,firstEvent:0,lastEvent:0}],id:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',name:'sample.log',size:0,encoding:'utf-8',imported:'2026-10-23T12:00:00Z',storageMode:'metadata-only',metadataBytes:48,lines:2,sourceHash:'example',indexed:true,stats:{all:2,error:1,warning:0,info:1,sql:1,otherError:0},top:[{name:'ORA-00904',count:1}],sqlTop:[{name:'ORA-00904',count:1}],sqlTypes:[{name:'SQL 문법·객체',count:1}],hourly:[{name:'2026.10.23 09',count:2}],hotspots:[{start:'2026-10-23 09:00',all:2,errors:1,sqlErrors:1,warnings:0,firstErrorEvent:0,lastErrorEvent:0}],errorSurges:[{start:'2026-10-23 09:00',all:30,errors:15,baselineErrors:12,baselineAll:300,firstErrorEvent:0,lastErrorEvent:0}]};
window.mockRows=[];window.mockGroup='all';window.mockImported=false;
const message=(data,status=200,type='application/json')=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':type}});
window.fetch=async function(input,opts={}){
  const u=new URL(String(input),'http://127.0.0.1:1');const route=u.pathname;
  if(route==='/ping')return new Response(null,{status:204});
  if(route==='/api/archives')return message({items:window.mockImported?[window.mockSummary]:[],metadataUsed:window.mockImported?48:0});
  if(route==='/api/import'){window.mockImported=true;window.mockSummary.size=opts.body.size;return message(window.mockSummary)}
  if(route==='/api/verify')return message(window.mockSummary);
  if(route==='/api/filter'){const req=JSON.parse(opts.body);window.mockGroup=req.group;const arr=window.mockRows.filter(x=>req.group==='all'||(req.group==='sql'&&x.category===1)||(req.group==='sql:1'&&x.category===1&&x.sqlType==='SQL 문법·객체')||(req.group==='issue:0123456789abcdef'&&x.index===0)||(req.group==='error'&&x.level===1)||(req.group==='info'&&x.level===3)||(req.group==='warning'&&x.level===2)||(req.group==='otherError'&&x.level===1&&x.category===0));window.mockMatches=arr;return message({filterId:'f1',total:arr.length})}
  if(route==='/api/page'){const arr=window.mockMatches||window.mockRows;return message({page:1,pages:1,total:arr.length,rows:arr})}
  if(route==='/api/page-by-ids'){const req=JSON.parse(opts.body);return message({rows:req.indices.map(i=>window.mockRows[i])})}
  if(route==='/api/delete'){window.mockImported=false;return message({deleted:true})}
  if(route==='/api/status')return message({stage:'complete',indexed:window.mockSummary.size,size:window.mockSummary.size});
  if(route==='/api/update/check'){window.updateRequests=(window.updateRequests||0)+1;return message({currentVersion:'1.0.2',latestVersion:'1.0.3',updateAvailable:true,asset:'JEUS_Lens_Rust_Windows_x64.exe',size:4800000,runtime:'rust',installSupported:true})}
  if(route==='/api/update/apply'){window.updateInstallCount=(window.updateInstallCount||0)+1;return message({status:'installing',version:'1.0.3'})}
  if(route==='/api/remote-trace'){window.remoteRequest=JSON.parse(opts.body);const stages=window.mockRemoteFails?
    [{stage:'tcp',level:'info',code:'CONNECTING',message:'연결 시도'},{stage:'ssh',level:'error',code:'AUTH_FAILED',message:'사용자 인증 실패'}]:
    [{stage:'tcp',level:'info',code:'CONNECTING',message:'연결 시도'},{stage:'auth',level:'success',code:'AUTHENTICATED',message:'계정 인증 완료'},{stage:'done',level:'success',code:'DONE',message:'종료',size:15,offset:0,data:btoa('REMOTE LOG SAFE'),partial:false}];
    return new Response(stages.map(x=>JSON.stringify(x)).join(String.fromCharCode(10))+String.fromCharCode(10),{status:200,headers:{'Content-Type':'application/x-ndjson'}})}
  if(route==='/api/remote-tail'){window.remoteRequest=JSON.parse(opts.body);return message({size:15,offset:0,data:btoa('REMOTE LOG SAFE'),partial:false})}
  throw Error('unknown mock route: '+route);
};
})();
`;
async function main(){const port=21000+Math.floor(Math.random()*1000);const profile=fs.mkdtempSync(path.join(os.tmpdir(),'jeus-v6-chrome-'));chrome=spawn('/usr/bin/chromium',['--no-sandbox','--disable-gpu','--headless=new','--disable-dev-shm-usage','--no-first-run','--no-proxy-server',`--remote-debugging-port=${port}`,`--user-data-dir=${profile}`,'about:blank'],{stdio:'ignore'});
const pages=await until(async()=>{const r=await fetch(`http://127.0.0.1:${port}/json`);return (await r.json()).filter(p=>p.type==='page')});
ws=new WebSocket(pages[0].webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(pending.has(m.id)){const q=pending.get(m.id);pending.delete(m.id);m.error?q.reject(Error(JSON.stringify(m.error))):q.resolve(m.result);}});await call('Runtime.enable');await call('Page.enable');
await js(`document.open();document.write(${JSON.stringify(html)});document.close();`);
await js(`(()=>{let s=document.createElement('style');s.textContent=${JSON.stringify(css)};document.head.append(s);})()`);
await js(parser);await js(diagnostics);await js(mock);await js(app);await js(remoteUI);await js(updaterUI);
if(captureDocs)await call('Emulation.setDeviceMetricsOverride',{width:1480,height:1024,deviceScaleFactor:1,mobile:false});
await saveDocsScreenshot('01-file-import.png','.heading');
const lines=['[2026.10.23 09:00:00][0] [m-1] [APP-3333] SQL error ORA-00904 invalid column','[2026.10.23 09:00:01][2] [m-1] [APP-3334] request complete'];
await js(`(()=>{const txt=${JSON.stringify(lines.join('\n'))};const a=txt.split('\\n');let p=0;window.mockRows=a.map((s,i)=>{const n=new TextEncoder().encode(s).length;const row={index:i,offset:p,length:n,line:i+1,endLine:i+1,category:i===0?1:0,level:i===0?1:3,sqlType:i===0?'SQL 문법·객체':'기타 SQL'};p+=n+1;return row;});let blob=new File([txt],'sample.log',{type:'text/plain'});const dt=new DataTransfer();dt.items.add(blob);document.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}));return true;})()`);
await until(()=>js(`!document.querySelector('#results').classList.contains('hidden')&&document.querySelectorAll('#logRows tr').length===2`));
await saveDocsScreenshot('02-analysis-summary.png','.stat-grid');
assert.equal(await js(`document.querySelector('#countAll').textContent`),'2');assert.equal(await js(`document.querySelector('#sqlCount').textContent`),'1');
assert.equal(await js(`document.querySelectorAll('#hotspotList .hotspot-row').length`),1);
assert.equal(await js(`document.querySelectorAll('#errorSurgeList .surge-row').length`),1);
assert.match(await js(`document.querySelector('#errorSurgeList').textContent`),/50\.0%/);
await js(`document.querySelector('#errorSurgeList .surge-row button').click()`);
await until(()=>js(`!document.querySelector('#detailPanel').classList.contains('hidden') && document.querySelector('#detailRaw').textContent.includes('ORA-00904')`));
await js(`document.querySelector('#closeDetail').click()`);
await js(`document.querySelector('#hotspotList .hotspot-row button').click()`);
await until(()=>js(`!document.querySelector('#detailPanel').classList.contains('hidden') && document.querySelector('#detailRaw').textContent.includes('ORA-00904')`));
await js(`document.querySelector('#closeDetail').click()`);
await js(`document.querySelector('#issueList button.issue-item').click()`);
await until(()=>js(`window.mockGroup==='issue:0123456789abcdef' && document.querySelectorAll('#logRows tr').length===1`));
assert.equal(await js(`document.querySelector('#searchBox').disabled`),true);
await js(`document.querySelector('#clearIssue').click()`);
await until(()=>js(`window.mockGroup==='all' && document.querySelectorAll('#logRows tr').length===2`));
await js(`document.querySelector('[data-level="sql"]').click()`);
await until(()=>js(`document.querySelectorAll('#logRows tr').length===1`));
await js(`document.querySelector('#sqlSubtype').value='sql:1';document.querySelector('#sqlSubtype').dispatchEvent(new Event('change',{bubbles:true}))`);
await until(()=>js(`window.mockGroup==='sql:1'&&document.querySelectorAll('#logRows tr').length===1`));
await js(`document.querySelector('#logRows tr').click()`);
assert.equal(await js(`document.querySelector('#detailSQLType').textContent`),'SQL 문법·객체');
assert.match(await js(`document.querySelector('#detailRaw').textContent`),/ORA-00904/);
assert.match(await js(`document.querySelector('#faultLocation').textContent`),/원본 로그 1행/);
assert.equal(await js(`document.querySelectorAll('#detailRaw .fault-highlight').length`),1);
const example=['[2026.10.23 10:01:00][0] insert failed LOT_ID=0044-26-0072','==> Preparing: INSERT INTO T(LOT_ID) VALUES (?)','==> Parameters: 0044-26-0072(String)','Caused by: java.sql.SQLException: ORA-00001',' at com.acme.Db.save(Db.java:87)'].join('\n');
await js(`showDetail({index:0,line:51,endLine:55,level:'error',category:'sql',time:'2026.10.23 10:01:00',code:'ORA-00001',sqlState:'',sqlType:'제약조건',thread:'m-1',rootCause:'',message:'insert failed',raw:${JSON.stringify(example)},truncated:false});`);
assert.match(await js(`document.querySelector('#faultLocation').textContent`),/Db.java:87/);
assert.match(await js(`document.querySelector('#faultData').textContent`),/0044-26-0072/);
assert.match(await js(`document.querySelector('#faultData').textContent`),/INSERT INTO T/);
assert.match(await js(`document.querySelector('#faultChain').textContent`),/SQLException/);
assert.match(await js(`document.querySelector('#faultChain').textContent`),/ORA-00001/);
assert.ok((await js(`document.querySelectorAll('#faultChain button.neighbor').length`))>=2);
assert.equal(await js(`document.querySelector('#detailRaw .fault-highlight').dataset.logLine`),'55');
await saveDocsScreenshot('03-error-detail.png','.logs-panel');
assert.ok((await js(`document.querySelectorAll('#hourlyChart .hour-item').length`))>0);
await js(`(()=>{const m={...window.mockSummary,hourly:Array.from({length:28},(_,i)=>({name:'2026.10.23 '+String(i).padStart(2,'0'),count:i+1}))};showSummary(m)})()`);
assert.equal(await js(`document.querySelectorAll('#hourlyChart .hour-item').length`),24);
assert.match(await js(`document.querySelector('#hourlyChart').textContent`),/최근 24개 기록 시간 구간/);
const report=await js(`diagnosticSummary(window.mockSummary)`);assert.match(report,/원본 로그 제외/);assert.match(report,/오류율 급증 후보/);assert.match(report,/SQL 관련 이벤트: 1/);assert.ok(!report.includes('ORA-00904 invalid column'),'report should not embed full raw messages');
await js(`document.querySelector('#closeDetail').click()`);
await js(`(()=>{document.querySelector('#remoteHost').value='127.0.0.1';document.querySelector('#remotePort').value='22';document.querySelector('#remoteUser').value='readonly';document.querySelector('#remotePass').value='temporary';document.querySelector('#remotePath').value='/logs/server.log';document.querySelector('#remoteFingerprint').value='SHA256:AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefg';document.querySelector('#remoteRead').click()})()`);
await until(()=>js(`document.querySelector('#remoteOutput').textContent.includes('REMOTE LOG SAFE')`));
assert.equal(await js(`window.remoteRequest.maxBytes`),524288);
assert.equal(await js(`window.remoteRequest.path`),'/logs/server.log');
assert.match(await js(`document.querySelector('#remoteTraceOutput').textContent`),/계정 인증 완료/);
await js(`document.querySelector('#remoteTabTrace').click()`);
assert.equal(await js(`document.querySelector('#remoteTabTrace').getAttribute('aria-selected')`),'true');
await js(`(()=>{window.mockRemoteFails=true;document.querySelector('#remoteConnect').click()})()`);
await until(()=>js(`document.querySelector('#remoteStatus').textContent.includes('AUTH_FAILED')`));
assert.match(await js(`document.querySelector('#remoteTraceOutput').textContent`),/사용자 인증 실패/);
await js(`window.mockRemoteFails=false`);

if(captureDocs)await js(`(()=>{document.querySelector('#remoteHost').value='';document.querySelector('#remoteUser').value='';document.querySelector('#remotePass').value='';document.querySelector('#remoteFingerprint').value='';document.querySelector('#remotePath').value='';document.querySelector('#remoteOutput').textContent='';document.querySelector('#remoteStatus').textContent='서버 호스트키를 확인하고 읽기 전용 계정으로 접속합니다.';})()`);
await saveDocsScreenshot('04-remote-sftp.png','.remote-panel');
await until(()=>js(`document.querySelector('#updateApply').disabled===false`));
assert.match(await js(`document.querySelector('#updateStatus').textContent`),/1\.0\.3/);
await js(`document.querySelector('#updateApply').click()`);
await until(()=>js(`window.updateInstallCount===1`));
assert.match(await js(`document.querySelector('#updateStatus').textContent`),/자동 재실행/);
await call('Emulation.setDeviceMetricsOverride',{width:1480,height:1050,deviceScaleFactor:1,mobile:false});
const snap=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(root,'preview.png'),Buffer.from(snap.data,'base64'));
const rebindState=await js(`(async()=>{ await rebind(new File(['different'],'wrong.log'),window.mockSummary); return {staleFile:currentFile!==null,staleSummary:summary!==null,visible:!document.querySelector('#results').classList.contains('hidden'),warning:document.querySelector('#notice').textContent.includes('크기가')};})()`);
assert.deepEqual(rebindState,{staleFile:false,staleSummary:false,visible:false,warning:true});
console.log('CHROMIUM_UI_DROP_ISSUE_SQL_FILTER_HOTSPOT_SURGE_JUMP_DETAIL_REBIND_PASS');
}main().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{try{ws?.close()}catch{}chrome?.kill('SIGKILL');await delay(150)});
