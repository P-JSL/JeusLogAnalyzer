'use strict';
// Explicit user-selected File System Access handle; never infer or persist local paths.
(function(){
 const $=id=>document.getElementById(id),upload=document.querySelector('.upload-panel');
 if(!upload)return;
 const button=document.createElement('button');button.id='watchFileButton';button.type='button';button.className='btn secondary';button.textContent='실시간 감시 파일 선택';
 upload.querySelector('.upload-actions').append(button);
 const panel=document.createElement('section');panel.className='logs-panel live-panel hidden';panel.id='localLivePanel';
 panel.innerHTML='<div class="logs-head"><div><span class="mini-kicker">LOCAL APPEND MONITOR</span><h2>추가 로그 이벤트 <span id="watchEventCount" class="counter">0건</span></h2></div><div class="remote-actions"><span id="watchStatus" class="tiny-muted">감시할 파일을 선택해 주세요.</span><button id="watchStop" class="btn secondary small" type="button">감시 중단</button></div></div><p class="detail-hint remote-event-note" id="watchStats">기존 분석 결과는 유지합니다. 추가된 데이터만 별도의 실시간 이벤트 화면에서 분석합니다.</p><div class="table-wrap"><table><thead><tr><th><button class="sort-head" data-watch-sort="level">구분</button></th><th><button class="sort-head" data-watch-sort="time">발생 시각</button></th><th><button class="sort-head" data-watch-sort="message">메시지 / 예외</button></th><th><button class="sort-head" data-watch-sort="code">코드</button></th><th class="right"><button class="sort-head" data-watch-sort="line">라인</button></th></tr></thead><tbody id="watchEventRows"></tbody></table></div><p class="detail-hint remote-event-note">메모리에는 최근 5,000개 추가 이벤트만 유지합니다. 기존 메타데이터 인덱스와 통계는 변경하지 않습니다. 아직 새로운 헤더가 나타나지 않은 멀티라인 이벤트는 확정 전까지 표시하지 않습니다.</p>';
 upload.insertAdjacentElement('afterend',panel);
 let watcher=null,sort='line',ascending=false,events=[],total=0,errors=0,warnings=0,working=false;
 const textBytes=(a,b)=>{if(a.length!==b.length)return false;for(let i=0;i<a.length;i++)if(a[i]!==b[i])return false;return true};
 async function anchor(file,offset){return new Uint8Array(await file.slice(Math.max(0,offset-64),offset).arrayBuffer())}
 function render(){
  $('watchEventCount').textContent=total.toLocaleString('ko-KR')+'건';
  $('watchStats').textContent='감시 시작 후 추가 '+total.toLocaleString('ko-KR')+'건 · 오류 '+errors+'건 · 경고 '+warnings+'건 · 최근 5,000건 보관';
  const order=(a,b)=>{
   const value=x=>sort==='code'?x.code:x[sort]??'';
   const left=value(a),right=value(b);
   const n=sort==='line'?Number(left)-Number(right):String(left).localeCompare(String(right),'ko',{numeric:true,sensitivity:'base'});
   return (ascending?1:-1)*n;
  };
  const body=$('watchEventRows');body.replaceChildren();
  for(const ev of [...events].sort(order).slice(0,200)){
   const tr=document.createElement('tr');
   for(const [i,v] of [ev.level,ev.time||'-',ev.message,ev.code||'-',String(ev.line)].entries()){
    const td=document.createElement('td');
    if(i===0){const badge=document.createElement('span');badge.className='level-pill '+ev.level;badge.textContent=ev.level==='error'?'오류':ev.level==='warning'?'경고':'일반';td.append(badge)}
    else{td.textContent=v;if(i===2)td.className='message-cell';if(i===4)td.className='right mono'}
    tr.append(td);
   }body.append(tr);
  }
 }
 function add(ev){total++;if(ev.level==='error')errors++;if(ev.level==='warning')warnings++;events.push(ev);if(events.length>5000)events.shift();}
 function stop(silent=false){
  if(!watcher)return;
  const old=watcher;watcher=null;
  clearInterval(old.timer);
  old.parser.finish();
  render();
  if(!silent)$('watchStatus').textContent='감시 중단 · 마지막 확인 위치 '+old.offset.toLocaleString('ko-KR')+' bytes';
 }
 async function tick(){
  const w=watcher;if(!w||working||document.hidden)return;working=true;
  try{
   const file=await w.handle.getFile();if(w!==watcher)return;
   if(file.size<w.offset)throw Error('파일 크기가 줄어들었습니다. 로그 회전/잘림으로 감시를 중단합니다.');
   if(file.size===w.offset){
    if(file.lastModified!==w.modified)throw Error('파일 내용이 같은 크기로 교체되었습니다. 재분석이 필요합니다.');
    return;
   }
   // A bounded tail anchor rejects truncation/rewrite of already consumed bytes.
   if(!textBytes(await anchor(file,w.offset),w.anchor))throw Error('파일의 이전 구간이 바뀌었습니다. 이어쓰기 대신 새 분석이 필요합니다.');
   const decoder=w.decoder;
   for(let from=w.offset;from<file.size;from+=1024*1024){
    const buffer=await file.slice(from,Math.min(from+1024*1024,file.size)).arrayBuffer();
    const decoded=decoder.decode(buffer,{stream:true});
    const parts=(w.carry+decoded).split('\n');w.carry=parts.pop()||'';
    for(const line of parts){
     if(w.skipBoundary){w.skipBoundary=false;continue;}
     w.parser.ingest(line);
    }
   }
   w.offset=file.size;w.modified=file.lastModified;w.anchor=await anchor(file,w.offset);
   $('watchStatus').textContent='감시 중 · 파일 크기 '+w.offset.toLocaleString('ko-KR')+' bytes · '+new Date().toLocaleTimeString('ko-KR');
   render();
  }catch(error){
   if(w===watcher){stop();$('watchStatus').textContent='감시 중단: '+error.message;}
  }finally{working=false;}
 }
 async function choose(){
  if(typeof window.showOpenFilePicker!=='function'){
   $('watchStatus').textContent='현재 브라우저는 파일 변경 감시 API를 지원하지 않습니다. Chromium 기반 브라우저에서 실행해 주세요.';
   panel.classList.remove('hidden');return;
  }
  try{
   const [handle]=await window.showOpenFilePicker({multiple:false,types:[{description:'로그 파일',accept:{'text/plain':['.log','.txt','.out','.trace','.err','.error']}}]});
   const file=await handle.getFile();
   stop(true);
   panel.classList.remove('hidden');$('watchStatus').textContent='원본 분석 후 변경 사항을 감시합니다…';
   await start(file); // Existing import workflow and read-only metadata index.
   if(!summary||!currentFile||summary.size!==file.size){$('watchStatus').textContent='초기 분석이 완료되지 않아 감시를 시작하지 않았습니다.';return;}
   events=[];total=0;errors=0;warnings=0;render();
   const first=await file.slice(Math.max(0,file.size-1),file.size).arrayBuffer();
   const last=new Uint8Array(first);
   const parser=new JeusParser.Parser(add);parser.line=Number(summary.lines)||0;
   watcher={handle,parser,offset:file.size,modified:file.lastModified,anchor:await anchor(file,file.size),
    decoder:new TextDecoder(summary.encoding,{fatal:false}),carry:'',skipBoundary:last.length>0&&last[0]!==10,timer:null};
   watcher.timer=setInterval(()=>void tick(),2000);
   $('watchStatus').textContent='감시 중 · 2초마다 변경 확인 · '+file.name;
  }catch(error){if(error.name!=='AbortError'){$('watchStatus').textContent='파일 감시 시작 실패: '+String(error.message||error).slice(0,200);panel.classList.remove('hidden');}}
 }
 $('watchStop').addEventListener('click',()=>stop());
 button.addEventListener('click',()=>void choose());
 panel.addEventListener('click',e=>{const key=e.target.closest('[data-watch-sort]')?.dataset.watchSort;if(!key)return;if(sort===key)ascending=!ascending;else{sort=key;ascending=true}render()});
 window.addEventListener('pagehide',()=>stop(true));
 window.LocalFileWatch={stop};
})();
