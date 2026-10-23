'use strict';
const $=id=>document.getElementById(id);
const fmt=n=>Number(n||0).toLocaleString('ko-KR');
const percent=(n,all)=>all?((n/all)*100).toFixed(1)+'%':'0%';
const prettyBytes=n=>n>=1024**3?(n/1024**3).toFixed(2)+' GiB':n>=1024**2?(n/1024**2).toFixed(2)+' MiB':n>=1024?(n/1024).toFixed(1)+' KiB':n+' B';
const label={error:'오류',warning:'경고',info:'일반',sql:'SQL 예외',otherError:'기타 오류'};
let pendingRebind=null,currentFile=null,summary=null,activeFilter='all',searchWorker=null,searchIds=null,filterId='all',currentPage=1,lastPage=1,rows=[],detail=null,searchHandle=null,abortImport=null,operation=0,history=[],pageRequest=0,matchedTotal=0,detailRequest=0;
const fileInput=$('fileInput'),drop=$('dropZone');
function announce(message,error=false){$('notice').textContent=message;$('notice').classList.remove('hidden');$('notice').classList.toggle('error',error);}
function hideNotice(){$('notice').classList.add('hidden');}
function progress(p,text){$('progressPanel').classList.remove('hidden');$('progressLabel').textContent=text;$('progressPercent').textContent=Math.round(p)+'%';$('progressBar').style.width=Math.round(p)+'%';}
function destroy(){detailRequest++;if(abortImport){abortImport.abort();abortImport=null;}if(searchWorker){searchWorker.terminate();searchWorker=null;}operation++;pageRequest++;}
async function api(path,options){const res=await fetch(path,{cache:'no-store',...options});if(!res.ok){let message=res.status+' HTTP 오류';try{message=(await res.json()).error||message;}catch{}throw Error(message);}return res;}
const sessionId=()=>Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join('');
function activeTab(group){activeFilter=group;const selected=group.startsWith('issue:');$('issueScope').classList.toggle('hidden',!selected);$('searchBox').disabled=selected;if(!selected)$('issueScopeName').textContent='';$('sqlSubtype').classList.toggle('hidden',group!=='sql');if(group!=='sql')$('sqlSubtype').value='sql';document.querySelectorAll('#tabs .tab').forEach(el=>{const active=el.dataset.level===group;el.classList.toggle('active',active);el.setAttribute('aria-selected',String(active));});}
async function loadHistory(){try{const res=await (await api('/api/archives')).json();history=res.items||[];renderHistory(res.metadataUsed||0);}catch(e){console.warn('History read:',e.message);}}
function renderHistory(bytes){const el=$('historyList');if(!el)return;el.replaceChildren();$('metadataUsage').textContent=prettyBytes(bytes);if(!history.length){const p=document.createElement('p');p.className='tiny-muted';p.textContent='저장된 분석 요약이 없습니다.';el.append(p);return;}
 for(const m of history.slice(0,20)){const wrap=document.createElement('div');wrap.className='history-item';const text=document.createElement('span');text.textContent=`${m.name} · ${fmt(m.stats?.all)}건 · 인덱스 ${prettyBytes(m.metadataBytes||0)}`;text.title='원본은 저장되지 않습니다. 다시 분석하려면 파일을 다시 선택해야 합니다.';const btn=document.createElement('button');btn.type='button';btn.className='history-delete';btn.textContent='삭제';btn.addEventListener('click',async()=>{if(!confirm('이 분석 메타데이터를 삭제하시겠습니까? 원본 로그 파일은 삭제되지 않습니다.'))return;try{await api('/api/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:m.id})});if(summary?.id===m.id)reset();await loadHistory();}catch(e){announce(e.message,true);}});const rebindBtn=document.createElement('button');rebindBtn.type='button';rebindBtn.className='history-delete';rebindBtn.textContent='원본 연결';rebindBtn.addEventListener('click',()=>{pendingRebind=m;pick();});wrap.append(text,rebindBtn,btn);el.append(wrap);}}
async function start(file){if(!file)return;destroy();const run=operation;closeDetail();hideNotice();rows=[];currentFile=null;summary=null;searchIds=null;filterId='all';currentPage=1;lastPage=1;activeTab('all');$('searchBox').value='';$('emptyState').classList.add('hidden');$('results').classList.add('hidden');$('resetButton').classList.remove('hidden');$('uploadHeading').textContent='다른 파일을 끌어다 놓으면 새로 분석합니다';$('uploadDesc').textContent=file.name+' · '+prettyBytes(file.size);
 if(file.size<=0 || file.size>1024**3){announce('파일 크기는 1B~1GiB만 지원합니다.',true);$('progressPanel').classList.add('hidden');return;}
 const id=sessionId();abortImport=new AbortController();progress(1,'원본은 복사하지 않고 메타데이터만 생성합니다');
 const statusTimer=setInterval(async()=>{if(run!==operation)return;try{const data=await(await api('/api/status?id='+id)).json();progress(Math.min(99,Math.round(100*(data.indexed||0)/file.size)),`파일 읽기·분류 중 · ${prettyBytes(data.indexed||0)} / ${prettyBytes(file.size)}`);}catch{}},350);
 try{const encoding=$('encoding').value;const res=await api('/api/import?id='+id+'&name='+encodeURIComponent(file.name)+'&encoding='+encoding,{method:'POST',body:file,signal:abortImport.signal,headers:{'Content-Type':'application/octet-stream'}});const data=await res.json();if(run!==operation)return;currentFile=file;summary=data;progress(100,'메타데이터 분석 완료');showSummary(data);await applyFilter();await loadHistory();$('progressPanel').classList.add('hidden');announce('원본 로그는 별도 저장하지 않았습니다. 분석 메타데이터를 저장했습니다. 다음 실행에서는 이력의 원본 연결을 이용하면 SHA-256 검증 후 인덱스를 재사용합니다.');}
 catch(e){if(run===operation){$('progressPanel').classList.add('hidden');$('emptyState').classList.remove('hidden');announce(e.message||String(e),true);}}
 finally{clearInterval(statusTimer);if(run===operation)abortImport=null;}}
function showSummary(m){$('results').classList.remove('hidden');$('fileName').textContent=m.name;$('fileMeta').textContent=`${prettyBytes(m.size)} · ${fmt(m.lines)}행 · 메타데이터 ${prettyBytes(m.metadataBytes||0)}`;$('encodingTag').textContent=m.encoding;$('scopeTag').textContent='원본 미보관 · 전수 인덱스';$('countAll').textContent=fmt(m.stats.all);$('countError').textContent=fmt(m.stats.error);$('countWarn').textContent=fmt(m.stats.warning);$('countInfo').textContent=fmt(m.stats.info);$('pctError').textContent='전체의 '+percent(m.stats.error,m.stats.all);$('pctWarn').textContent='전체의 '+percent(m.stats.warning,m.stats.all);$('pctInfo').textContent='전체의 '+percent(m.stats.info,m.stats.all);
 const ratios=[m.stats.error,m.stats.warning,m.stats.info].map(n=>m.stats.all?(n/m.stats.all*100):0);document.querySelectorAll('#distributionBar .segment').forEach((el,i)=>el.style.width=ratios[i]+'%');['barError','barWarn','barInfo'].forEach((id,i)=>$(id).textContent=ratios[i].toFixed(1)+'%');const issue=$('issueList');issue.replaceChildren();const issueData=m.issueVersion===1?(m.issues||[]):(m.top||[]);$('topIssueCount').textContent=m.issueVersion===1?'상위 8개 · 클릭하여 필터':'상위 8개';for(const p of issueData.slice(0,8)){const item=document.createElement(m.issueVersion===1?'button':'div');if(m.issueVersion===1){item.type='button';item.title=`처음 이벤트 #${fmt(p.firstEvent+1)} · 마지막 이벤트 #${fmt(p.lastEvent+1)}`;item.addEventListener('click',()=>selectIssue(p));}item.className='issue-item';const name=document.createElement('span');name.textContent=p.name;const num=document.createElement('b');num.textContent=fmt(p.count);item.append(name,num);issue.append(item);}if(!issue.childElementCount){const p=document.createElement('p');p.className='no-issues';p.textContent='집계된 오류가 없습니다.';issue.append(p);}
 $('sqlCount').textContent=fmt(m.stats.sql);$('otherErrorCount').textContent=fmt(m.stats.otherError);$('sqlTopList').replaceChildren();for(const p of (m.sqlTop||[])){const item=document.createElement('span');item.className='sql-chip';item.textContent=`${p.name} · ${fmt(p.count)}`;$('sqlTopList').append(item);}
 $('sqlTypeList').replaceChildren();for(const t of (m.sqlTypes||[])){const item=document.createElement('span');item.className='sql-chip';item.textContent=`${t.name}: ${fmt(t.count)}건`;$('sqlTypeList').append(item);}
 renderHotspots(m);
 const chart=$('hourlyChart');chart.replaceChildren();const series=(m.hourly||[]),peak=Math.max(1,...series.map(x=>x.count));for(const t of series.slice(-48)){const block=document.createElement('div');block.className='hour-item';block.title=`${t.name} · ${fmt(t.count)}건`;const bar=document.createElement('span');bar.className='hour-bar';bar.style.height=Math.max(2,Math.round(100*t.count/peak))+'%';const x=document.createElement('small');x.textContent=t.name.slice(-5);block.append(bar,x);chart.append(block);}if(series.length>48){const info=document.createElement('small');info.textContent='최근 48개 시간 구간 표시';chart.append(info);} }
// Splunk-inspired 5-minute aggregation without retaining message bodies.
// Buttons open the real source event through the existing immutable offset index.
function renderHotspots(m){
 const box=$('hotspotList');box.replaceChildren();$('hotspotLimit').classList.toggle('hidden',!m.hotspotLimited);
 const items=m.hotspots||[];
 if(!items.length){const empty=document.createElement('p');empty.className='data-empty';empty.textContent='시간 정보가 있는 오류 이벤트가 없습니다.';box.append(empty);return;}
 for(const h of items){
  const row=document.createElement('div');row.className='hotspot-row';
  const stat=document.createElement('div');stat.className='hotspot-stat';
  const stamp=document.createElement('strong');stamp.textContent=h.start;
  const counts=document.createElement('span');counts.textContent=`오류 ${fmt(h.errors)}건 · SQL 오류 ${fmt(h.sqlErrors)}건 · 경고 ${fmt(h.warnings)}건 · 전체 ${fmt(h.all)}건`;
  stat.append(stamp,counts);
  const actions=document.createElement('div');actions.className='hotspot-actions';
  for(const [text,index] of [['첫 오류',h.firstErrorEvent],['마지막 오류',h.lastErrorEvent]]){
   const button=document.createElement('button');button.type='button';button.className='btn secondary small';button.textContent=text;
   button.disabled=!Number.isSafeInteger(index)||index<0;
   button.addEventListener('click',()=>void showIndexedEvent(index));actions.append(button);
  }
  row.append(stat,actions);box.append(row);
 }
}
async function showIndexedEvent(index){
 if(!summary||!currentFile||!Number.isSafeInteger(index)||index<0||index>=summary.stats.all)return;
 const run=operation,sourceId=summary.id,request=++detailRequest;
 try{
  const obj=await(await api('/api/page-by-ids',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:sourceId,indices:[index]})})).json();
  if(run!==operation||request!==detailRequest||summary?.id!==sourceId)return;
  if(!Array.isArray(obj.rows)||obj.rows.length!==1||obj.rows[0].index!==index)throw Error('원본 이벤트 인덱스를 찾을 수 없습니다.');
  const ev=await readRow(obj.rows[0]);
  if(run!==operation||request!==detailRequest||summary?.id!==sourceId)return;
  showDetail(ev);
 }catch(e){if(run===operation&&request===detailRequest)announce('오류 이벤트 조회 실패: '+e.message,true);}
}
async function readRow(rec){if(!currentFile)throw Error('원본 로그 파일을 먼저 선택해 주세요.');const offset=Number(rec.offset),length=Number(rec.length);if(!Number.isSafeInteger(offset)||!Number.isSafeInteger(length)||offset<0||offset+length>currentFile.size)throw Error('파일 내용과 메타데이터가 일치하지 않습니다. 다시 분석해 주세요.');const limit=Math.min(length,128*1024);const buf=await currentFile.slice(offset,offset+limit).arrayBuffer();let raw=new TextDecoder(summary.encoding,{fatal:false}).decode(buf).replace(/\r?\n$/,'');const first=raw.split('\n',1)[0];const h=JeusParser.header(first);const code=(raw.match(/\b(?:ORA|PLS)-\d{4,5}\b/i)||[])[0]||h?.code||((raw.match(/\b[A-Za-z][\w.-]*-\d{3,}\b/)||[])[0]||'');const sqlState=(raw.match(/\bSQL\s*STATE\s*[:=]?\s*([A-Za-z0-9]{5})/i)||[])[1]||'';const rootCause=(raw.match(/Caused by:[^\r\n]*/g)||[]).at(-1)||'';const message=(h?.message||first).trim().slice(0,1000);return {...rec,level:rec.level===1?'error':rec.level===2?'warning':'info',category:rec.category===1?'sql':'other',time:h?.time||'',thread:h?.thread||'',code,message,line:rec.line,endLine:rec.endLine,raw,truncated:length>limit,sqlCode:code,sqlState,rootCause};}
async function materialize(meta){return Promise.all(meta.map(readRow));}
async function drawPage(page){if(!summary)return;const run=operation,request=++pageRequest;try{let raw,total,pages,p;if(searchIds!==null){total=searchIds.length;pages=Math.max(1,Math.ceil(total/100));p=Math.max(1,Math.min(page,pages));const ids=searchIds.slice((p-1)*100,p*100);raw=await (await api('/api/page-by-ids',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:summary.id,indices:ids})})).json();}else{raw=await (await api(`/api/page?id=${summary.id}&filterId=${filterId}&page=${page}`)).json();total=raw.total;pages=raw.pages;p=raw.page;}
 const data=await materialize(raw.rows);if(run!==operation||request!==pageRequest)return;rows=data;matchedTotal=total;currentPage=p;lastPage=pages;renderRows(data,total);}catch(e){if(run===operation&&request===pageRequest)announce('페이지 조회 실패: '+e.message,true);}}
function highlightText(target,text,query){
 target.replaceChildren();if(!query){target.textContent=text;return;}
 const exact=$('caseSensitive').checked,lower=exact?text:text.toLocaleLowerCase(),needle=exact?query:query.toLocaleLowerCase();let at=0,hits=0;
 while(at<text.length && hits<30){const pos=lower.indexOf(needle,at);if(pos<0)break;
  target.append(document.createTextNode(text.slice(at,pos)));
  const marked=document.createElement('mark');marked.textContent=text.slice(pos,pos+query.length);target.append(marked);
  at=pos+query.length;hits++;
 }
 target.append(document.createTextNode(text.slice(at)));
}
function renderRows(data,total){const body=$('logRows');body.replaceChildren();$('matchedCount').textContent=fmt(total)+'건';$('pageInfo').textContent=total?`${fmt((currentPage-1)*100+1)}–${fmt(Math.min(total,currentPage*100))} / ${fmt(total)}건`:'0건';$('pageNumber').textContent=`${fmt(currentPage)} / ${fmt(lastPage)}`;$('prevPage').disabled=currentPage<=1;$('nextPage').disabled=currentPage>=lastPage;$('noMatches').classList.toggle('hidden',data.length>0);
 for(const ev of data){const tr=document.createElement('tr');tr.tabIndex=0;const td1=document.createElement('td');const pill=document.createElement('span');pill.className='level-pill '+ev.level;pill.textContent=label[ev.level];td1.append(pill);const td2=document.createElement('td');td2.className='mono';td2.textContent=ev.time||'-';const td3=document.createElement('td');const mes=document.createElement('div');mes.className='message-text';const query=$('searchBox').value.trim();const sensitive=$('caseSensitive').checked;
 const msgMatch=query && (sensitive?ev.message.includes(query):ev.message.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
 if(msgMatch)highlightText(mes,ev.message,query);else mes.textContent=ev.message;
 td3.append(mes);
 if(query && !msgMatch){const lines=ev.raw.split('\n');const found=lines.findIndex(line=>sensitive?line.includes(query):line.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const hint=document.createElement('small');hint.className='search-hint';hint.textContent=found>=0?`원본 ${fmt(ev.line+found)}행에 검색어 포함`:'검색어가 원본 미리보기 범위 밖에 있을 수 있습니다';mes.append(hint);
 }if(ev.category==='sql'){const tag=document.createElement('span');tag.className='sql-inline';tag.textContent=ev.sqlType||'SQL';td3.append(tag);}const td4=document.createElement('td');td4.className='subtle-cell';td4.textContent=[ev.code,ev.thread].filter(Boolean).join(' / ')||'-';const td5=document.createElement('td');td5.className='right mono';td5.textContent=fmt(ev.line);tr.append(td1,td2,td3,td4,td5);tr.addEventListener('click',()=>showDetail(ev));tr.addEventListener('keydown',e=>{if(e.key==='Enter')showDetail(ev);});body.append(tr);}}
async function applyFilter(){if(!summary)return;const query=$('searchBox').value.trim();if(searchWorker){searchWorker.terminate();searchWorker=null;}searchIds=null;currentPage=1;const run=++operation;
 const group=activeFilter==='sql'?$('sqlSubtype').value:activeFilter;
 if(!query){try{const result=await(await api('/api/filter',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:summary.id,group,query:''})})).json();if(run!==operation)return;filterId=result.filterId;await drawPage(1);}catch(e){announce('필터 오류: '+e.message,true);}return;}
 progress(0,'원본 로그 검색 중…');searchWorker=new Worker('search-worker.js');const worker=searchWorker;
 worker.onmessage=async({data:d})=>{if(run!==operation)return;if(d.type==='progress'){progress(Math.min(99,Math.floor(100*d.scanned/summary.stats.all)),`원본 검색 중 · ${fmt(d.matches)}건 발견`);}else if(d.type==='complete'){searchWorker=null;searchIds=d.indices;$('progressPanel').classList.add('hidden');if(d.limited)announce(`검색 일치 ${fmt(d.totalMatches)}건 중 처음 ${fmt(d.indices.length)}건을 표시합니다. 메모리 보호를 위한 상한입니다.`);await drawPage(1);}else if(d.type==='error'){$('progressPanel').classList.add('hidden');announce('검색 오류: '+d.message,true);}};
 worker.postMessage({file:currentFile,id:summary.id,encoding:summary.encoding,group,query,total:summary.stats.all,caseSensitive:$('caseSensitive').checked});}
function filter(){void applyFilter();}
function selectTab(level){activeTab(level);filter();}
function selectIssue(item){
 if(!summary||summary.issueVersion!==1)return;
 activeTab('issue:'+item.id);
 $('issueScopeName').textContent=`선택한 오류 그룹: ${item.name} (${fmt(item.count)}건)`;
 $('searchBox').value='';
 hideNotice();
 void applyFilter();
 $('issueScope').scrollIntoView({block:'nearest',behavior:'smooth'});
}
$('clearIssue').addEventListener('click',()=>selectTab('all'));
function renderFaultRaw(ev,info){
 const raw=$('detailRaw');raw.replaceChildren();const query=$('searchBox').value.trim();
 const lines=ev.raw.split('\n');for(let i=0;i<lines.length;i++){
  const row=document.createElement('span');row.className='raw-line';const n=ev.line+i;
  row.dataset.logLine=String(n);if(n===info.focusLine)row.classList.add('fault-highlight');
  const number=document.createElement('span');number.className='raw-num';number.textContent=String(n);row.append(number);
  const segment=document.createElement('span');const hit=query&&( $('caseSensitive').checked?lines[i].includes(query):lines[i].toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  if(hit){row.classList.add('search-highlight');highlightText(segment,lines[i],query);}else segment.textContent=lines[i];row.append(segment);raw.append(row);
 }
 if(ev.truncated){const hint=document.createElement('span');hint.className='raw-line';hint.textContent='[128 KiB까지만 미리보기: 원본 로그에 나머지 데이터가 있습니다.]';raw.append(hint);}
}
async function loadNearby(ev,request){
 const target=$('nearbyEvents');target.textContent='주변 이벤트 조회 중…';
 if(!summary||!currentFile)return;
 const first=Math.max(0,ev.index-2),last=Math.min(summary.stats.all-1,ev.index+2);
 const indices=Array.from({length:last-first+1},(_,i)=>first+i).filter(i=>i!==ev.index);
 if(!indices.length){target.textContent='인접 이벤트가 없습니다.';return;}
 try{const obj=await(await api('/api/page-by-ids',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:summary.id,indices})})).json();
  const events=await materialize(obj.rows);if(request!==detailRequest)return;
  target.replaceChildren();for(const item of events){const btn=document.createElement('button');btn.type='button';btn.className='neighbor';
   const sameThread=Boolean(ev.thread&&item.thread&&ev.thread===item.thread);
   const text=document.createElement('span');text.textContent=`${item.line}행 · ${item.time||'-'} · ${item.message.slice(0,95)}`;
   const badge=document.createElement('b');badge.textContent=sameThread?'동일 스레드':'주변 로그';btn.append(text,badge);btn.addEventListener('click',()=>showDetail(item));target.append(btn);
   // Only show other-event input values as leads, never as proven failing input.
   if(sameThread){const nearby=JeusDiagnostics.diagnose(item.raw,item.line,item.level).evidence.slice(0,6);
    if(nearby.length){const note=document.createElement('div');note.className='nearby-proof';
     note.textContent='동일 스레드 인접 이벤트의 기록값 (오류와 연관성 미확정): ' + nearby.map(x=>`${x.name}: ${x.value} [${x.line}행]`).join(' · ');target.append(note);}
   }
  }
 }catch(error){if(request===detailRequest)target.textContent='주변 로그 조회 불가: '+error.message;}
}
function showDetail(e){detail=e;const request=++detailRequest;$('detailLevel').className='level-pill '+e.level;$('detailLevel').textContent=label[e.level]+(e.category==='sql'?' · SQL':'');$('detailMessage').textContent=e.message;$('detailTimestamp').textContent=e.time||'-';$('detailCode').textContent=e.code||'-';$('detailThread').textContent=e.thread||'-';$('detailLine').textContent=e.line===e.endLine?String(e.line):`${e.line} – ${e.endLine}`;$('detailSQLType').textContent=e.category==='sql'?(e.sqlType||'기타 SQL'):'-';$('detailSQLState').textContent=e.sqlState||'-';$('detailCause').textContent=e.rootCause||'-';const fault=JeusDiagnostics.diagnose(e.raw,e.line,e.level);
 const loc=fault.location;
 $('faultLocation').textContent=loc.kind==='stack'?`${loc.source}:${loc.sourceLine} · ${loc.method} (로그 ${loc.logLine}행)`: `원본 로그 ${loc.logLine}행 · 소스 코드 위치는 로그에 기록되지 않았습니다.`;
 $('faultCause').textContent=fault.causes.filter(x=>/Caused by/.test(x.message)).at(-1)?.message||'Java 스택의 최하위 원인이 없거나 기록되지 않았습니다.';
 $('jumpFault').onclick=()=>{$('detailRaw').querySelector('.fault-highlight')?.scrollIntoView({block:'center',behavior:'smooth'});};
 const data=$('faultData');data.replaceChildren();if(fault.evidence.length){const table=document.createElement('table'),thead=document.createElement('thead'),hrow=document.createElement('tr');
  for(const name of ['유형','기록된 값','원본 줄']){const th=document.createElement('th');th.textContent=name;hrow.append(th);}thead.append(hrow);
  const body=document.createElement('tbody');for(const item of fault.evidence){const tr=document.createElement('tr');for(const val of [item.kind==='sql'?'SQL':item.name,item.value,String(item.line)]){const td=document.createElement('td');td.textContent=val;tr.append(td);}body.append(tr);}table.append(thead,body);data.append(table);
 }else{const p=document.createElement('p');p.className='data-empty';p.textContent='이 이벤트에 명시적으로 기록된 SQL·바인드값·입력 식별자가 없습니다. 실제 DB 레코드는 로그만으로 확인할 수 없습니다.';data.append(p);}
 renderFaultRaw(e,fault);void loadNearby(e,request);$('detailShade').classList.remove('hidden');$('detailPanel').classList.remove('hidden');$('closeDetail').focus();}
function closeDetail(){detailRequest++;detail=null;$('detailShade').classList.add('hidden');$('detailPanel').classList.add('hidden');}
function safeFilename(s){return s.replace(/[^\p{L}\p{N}._-]/gu,'_').slice(0,80);}
function csvSafe(s){return /^[\s\t\r\n]*[=+\-@]/.test(s)?"'"+s:s;}
async function exportData(kind){if(!summary)return;const total=searchIds===null?null:searchIds.length;const max=5000;let events=[],pages=0;let limit=total===null?max:Math.min(total,max),actualTotal=total;try{
 if(searchIds!==null){for(let pos=0;pos<limit;pos+=100){const ids=searchIds.slice(pos,pos+100);const obj=await(await api('/api/page-by-ids',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:summary.id,indices:ids})})).json();events.push(...await materialize(obj.rows));}}
 else{for(let p=1;events.length<max;p++){const obj=await(await api(`/api/page?id=${summary.id}&filterId=${filterId}&page=${p}`)).json();pages=obj.pages;actualTotal=obj.total;events.push(...await materialize(obj.rows));if(p>=pages)break;}}
 events=events.map(e=>({...e,raw:e.raw.slice(0,8192)}));const truncated=(actualTotal??matchedTotal)>events.length;const note=truncated?`내보내기 상한 5000건에 도달했습니다. 실제 검색/필터 결과는 더 많을 수 있습니다.`:'선택한 검색/필터 결과';let payload,mime;
 if(kind==='json'){payload=JSON.stringify({note,metadataOnly:true,sourceSHA256:summary.sourceHash,events},null,2);mime='application/json;charset=utf-8';}
 else{const cols=['구분','SQL 여부','SQL 유형','발생시각','SQL 코드','SQLSTATE','시작라인','끝라인','메시지','원본(이벤트당 최대8KiB)'];const esc=x=>'"'+csvSafe(String(x??'')).replace(/"/g,'""')+'"';payload='\ufeff'+[cols.map(esc).join(','),...events.map(e=>[e.level,e.category,e.sqlType,e.time,e.sqlCode,e.sqlState,e.line,e.endLine,e.message,e.raw].map(esc).join(','))].join('\r\n');mime='text/csv;charset=utf-8';}
 const url=URL.createObjectURL(new Blob([payload],{type:mime}));const a=document.createElement('a');a.href=url;a.download=safeFilename(summary.name.replace(/\.[^.]*$/,'')+'_분석')+'.'+kind;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);if(truncated)announce('내보내기는 최대 5,000건으로 제한됩니다. 원본 로그는 저장하거나 변형하지 않았습니다.');
 }catch(e){announce('내보내기 실패: '+e.message,true);}}
async function rebind(file,m){if(!file)return;
 destroy();currentFile=null;summary=null;searchIds=null;rows=[];filterId='all';
 closeDetail();$('results').classList.add('hidden');$('emptyState').classList.remove('hidden');
 $('progressPanel').classList.add('hidden');$('resetButton').classList.remove('hidden');
 if(file.size!==m.size){announce('선택한 원본의 크기가 기존 분석 파일과 다릅니다. 새 분석을 선택해 주세요.',true);return;}
 const run=operation;progress(1,'기존 로그와 SHA-256 전체 검증 중 · 원본 복사 없음');try{const res=await api('/api/verify?id='+encodeURIComponent(m.id),{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:file});const verified=await res.json();if(run!==operation)return;currentFile=file;summary=verified;activeTab('all');$('searchBox').value='';searchIds=null;filterId='all';currentPage=1;lastPage=1;closeDetail();$('emptyState').classList.add('hidden');$('resetButton').classList.remove('hidden');showSummary(verified);await applyFilter();announce('SHA-256 전체 검증 완료: 기존 메타데이터 인덱스를 재사용했습니다.');}
 catch(e){if(run===operation)announce('원본 연결 실패: '+e.message,true);}finally{if(run===operation)$('progressPanel').classList.add('hidden');}}
function pick(){fileInput.value='';fileInput.click();}
$('pickButton').addEventListener('click',e=>{e.stopPropagation();pendingRebind=null;pick();});
drop.addEventListener('click',e=>{if(e.target.closest('select,button,input,label'))return;pendingRebind=null;pick();});
drop.addEventListener('keydown',e=>{if((e.key==='Enter'||e.key===' ')&&e.target===drop){e.preventDefault();pick();}});
fileInput.addEventListener('change',()=>{const file=fileInput.files?.[0];const m=pendingRebind;pendingRebind=null;if(m)void rebind(file,m);else void start(file);});
function reset(){pendingRebind=null;destroy();currentFile=null;summary=null;searchIds=null;rows=[];hideNotice();$('results').classList.add('hidden');$('progressPanel').classList.add('hidden');$('emptyState').classList.remove('hidden');$('resetButton').classList.add('hidden');$('uploadHeading').textContent='로그 파일을 여기에 끌어다 놓으세요';$('uploadDesc').textContent='파일을 드래그하거나 버튼을 눌러서 바로 분석합니다. TXT · LOG · OUT';}
$('resetButton').addEventListener('click',reset);
$('sqlSubtype').addEventListener('change',()=>{if(activeFilter==='sql')void applyFilter();});
$('tabs').addEventListener('click',e=>{const btn=e.target.closest('button[data-level]');if(btn)selectTab(btn.dataset.level);});
$('searchBox').addEventListener('input',()=>{if(searchHandle)clearTimeout(searchHandle);searchHandle=setTimeout(filter,250);});
$('caseSensitive').addEventListener('change',()=>{if($('searchBox').value.trim())void applyFilter();});
$('prevPage').addEventListener('click',()=>drawPage(currentPage-1));$('nextPage').addEventListener('click',()=>drawPage(currentPage+1));
// This report contains aggregates only. Never include raw messages or stack traces.
function diagnosticSummary(m){
 const out=[
  'JEUS Lens · 진단 요약 (원본 로그 제외)',
  `파일: ${m.name}`,
  `분석 시각: ${m.imported}`,
  `크기: ${prettyBytes(m.size)} / 인코딩: ${m.encoding}`,
  `원본 SHA-256: ${m.sourceHash}`,
  `메타데이터: ${prettyBytes(m.metadataBytes||0)} (원본 파일 미보관)`,
  '',
  `전체 이벤트: ${fmt(m.stats.all)}`,
  `오류: ${fmt(m.stats.error)} (${percent(m.stats.error,m.stats.all)})`,
  `경고: ${fmt(m.stats.warning)} (${percent(m.stats.warning,m.stats.all)})`,
  `일반: ${fmt(m.stats.info)} (${percent(m.stats.info,m.stats.all)})`,
  `SQL 관련 이벤트: ${fmt(m.stats.sql)}`,
  `비SQL 오류: ${fmt(m.stats.otherError)}`,
  '',
  'SQL 하위 유형 (건수)',
  ...(m.sqlTypes||[]).map(x=>`${x.name}: ${fmt(x.count)}`),
  '',
  'SQL 예외 코드/클래스 TOP',
  ...(m.sqlTop||[]).map(x=>`${x.name}: ${fmt(x.count)}`),
  '',
  '오류 서명 TOP',
  ...(m.top||[]).map(x=>`${x.name}: ${fmt(x.count)}`),
  '',
  '유사 오류 그룹 (구조 기반, 첫/마지막 이벤트 번호)',
  ...(m.issues||[]).slice(0,30).map(x=>`${x.name} [${x.id}]: ${fmt(x.count)}건 / ${fmt(x.firstEvent+1)} ~ ${fmt(x.lastEvent+1)}`),
  '',
  '5분 단위 오류 집중 구간 (건수 기준, 이상 탐지 모델 아님)',
  ...(m.hotspots||[]).map(x=>`${x.start}: 오류 ${fmt(x.errors)}건 / SQL 오류 ${fmt(x.sqlErrors)}건 / 전체 ${fmt(x.all)}건 · 첫 오류 #${fmt(x.firstErrorEvent+1)} / 마지막 #${fmt(x.lastErrorEvent+1)}`),
  m.hotspotLimited?'신규 시간 구간 50,000개 초과로 일부 시간 구간 집계 생략':'',
  '',
  '시간대별 이벤트 (서버 로그 시각)',
  ...(m.hourly||[]).map(x=>`${x.name}: ${fmt(x.count)}`),
  '',
  '참고: 규칙 기반 분류 결과이며 일반 레벨은 서버 정상 가동의 증명이 아닙니다.',
  'SQL 유형은 장애 원인 확정이 아닌 진단 힌트입니다.'
 ];
 return out.join('\n');
}
function downloadSummary(){
 if(!summary)return;
 const url=URL.createObjectURL(new Blob(['\ufeff'+diagnosticSummary(summary)],{type:'text/plain;charset=utf-8'}));
 const a=document.createElement('a');a.href=url;a.download=safeFilename(summary.name.replace(/\.[^.]*$/,'')+'_진단요약')+'.txt';
 document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
}
$('downloadSummary').addEventListener('click',downloadSummary);$('exportCsv').addEventListener('click',()=>exportData('csv'));$('exportJson').addEventListener('click',()=>exportData('json'));
$('closeDetail').addEventListener('click',closeDetail);$('detailShade').addEventListener('click',closeDetail);document.addEventListener('keydown',e=>{if(e.key==='Escape')closeDetail();});
$('copyDetail').addEventListener('click',async()=>{if(!detail)return;try{await navigator.clipboard.writeText(detail.raw);$('copyDetail').textContent='복사됨 ✓';setTimeout(()=>$('copyDetail').textContent='복사',1200);}catch{announce('클립보드 복사가 제한되었습니다.',true);}});
let dragDepth=0;document.addEventListener('dragenter',e=>{if([...e.dataTransfer?.types||[]].includes('Files')){e.preventDefault();dragDepth++;$('dropOverlay').classList.add('show');drop.classList.add('drag-active');}});document.addEventListener('dragover',e=>{if([...e.dataTransfer?.types||[]].includes('Files')){e.preventDefault();e.dataTransfer.dropEffect='copy';}});document.addEventListener('dragleave',e=>{e.preventDefault();if(--dragDepth<=0){dragDepth=0;$('dropOverlay').classList.remove('show');drop.classList.remove('drag-active');}});document.addEventListener('drop',e=>{e.preventDefault();dragDepth=0;$('dropOverlay').classList.remove('show');drop.classList.remove('drag-active');if(e.dataTransfer?.files.length){pendingRebind=null;start(e.dataTransfer.files[0]);if(e.dataTransfer.files.length>1)announce('한 번에 첫 번째 파일만 처리합니다.');}});document.addEventListener('dragend',()=>{dragDepth=0;$('dropOverlay').classList.remove('show');drop.classList.remove('drag-active');});
function keepAlive(){fetch('/ping',{method:'POST',body:'',cache:'no-store'}).catch(()=>{});}setInterval(keepAlive,20000);keepAlive();loadHistory();
