'use strict';
// Separate local and remote workspaces without changing existing element IDs.
(function(){
 const $=id=>document.getElementById(id);
 const content=document.querySelector('.content');
 const remote=document.querySelector('.remote-panel:not(.updater-panel)');
 if(!content||!remote)return;
 const workspace=document.createElement('section');
 workspace.id='remoteWorkspace';
 workspace.innerHTML='<section class="heading"><div><span class="eyebrow">SECURE REMOTE LOG INTELLIGENCE</span><h1>Connect <span class="subtle-head">/ Remote analysis</span></h1><p class="lead">인증된 SSH/SFTP 접속으로 읽은 로그를 로컬에서 분석합니다. 서버에서 명령을 실행하지 않습니다.</p></div></section>';
 content.prepend(workspace);
 workspace.append(remote);
 const gateway=document.createElement('section');
 gateway.className='gateway-settings';
 gateway.innerHTML='<div class="remote-service-bar"><label>접근통제 / 게이트웨이 제품<select id="remoteGatewayProduct"><option value="direct">직접 SSH/SFTP</option><option value="ssh-gateway">표준 SSH/SFTP 게이트웨이</option><option value="dbsafer">DBSAFER AM (PNPSECURE)</option><option value="secureguard">SecureGuard AM (Datawall)</option><option value="dbi">DB-i (SOMANSA)</option><option value="other">기타 접근통제 솔루션</option></select></label></div><p id="remoteGatewayHint" class="detail-hint"></p>';
 remote.insertBefore(gateway,remote.querySelector('.remote-fields'));
 const gatewayProduct=$('remoteGatewayProduct'),gatewayHint=$('remoteGatewayHint');
 function updateGateway(){
  const p=gatewayProduct.value;
  gatewayHint.textContent=p==='direct'
   ?'대상 서버의 일반 SSH/SFTP 엔드포인트에 연결합니다.'
   :'이 제품에서 승인된 SSH/SFTP 접속 주소·포트·계정·비밀번호·대상 로그 경로를 사용하세요. 제품의 게이트웨이가 SFTP를 대상 서버로 중계하는 구성이어야 합니다. 별도 전용 클라이언트·OTP·MFA·승인 화면이 필요한 환경은 지원하지 않으며, 승인·인증을 우회하지 않습니다.';
  $('remoteHost').parentElement.firstChild.textContent=p==='direct'?'서버 주소':'승인된 SSH/SFTP 접속 주소';
  $('remotePass').parentElement.firstChild.textContent=p==='direct'?'비밀번호':'접속 비밀번호 (게이트웨이 정책 적용)';
 }
 gatewayProduct.addEventListener('change',()=>{if(!$('remoteDisconnect').disabled)$('remoteDisconnect').click();window.RemoteLogWatch?.reset();updateGateway()});
 updateGateway();
 // Product names are UI options only, never claims of proprietary protocol support.
 window.JeusGateway={select:gatewayProduct,update:updateGateway};
 const analytics=document.createElement('section');
 analytics.className='logs-panel remote-analytics';
 analytics.innerHTML='<div class="logs-head"><div><span class="mini-kicker">REMOTE EVENT EXPLORER</span><h2>원격 로그 이벤트 <span id="remoteEventCount" class="counter">0건</span></h2></div><label class="search-option">레벨 <select id="remoteEventFilter"><option value="all">전체</option><option value="error">오류</option><option value="warning">경고</option><option value="info">일반</option></select></label></div><p class="detail-hint remote-event-note" id="remoteEventSummary">최근 조회한 최대 512KiB 구간을 분석합니다. 전체 파일 통계가 아닙니다.</p><div class="table-wrap"><table><thead><tr><th><button class="sort-head" data-remote-sort="level">구분</button></th><th><button class="sort-head" data-remote-sort="time">발생 시각</button></th><th><button class="sort-head" data-remote-sort="message">메시지 / 예외</button></th><th><button class="sort-head" data-remote-sort="code">코드 · 스레드</button></th><th class="right"><button class="sort-head" data-remote-sort="line">라인</button></th></tr></thead><tbody id="remoteEventRows"></tbody></table></div><p class="detail-hint remote-event-note">표시는 현재 원격 읽기 버퍼(최근 최대 512KiB) 기준이며 파일 전체 이력은 유지하지 않습니다. 표는 최대 200건을 표시합니다.</p>';
 workspace.append(analytics);
 let remoteEvents=[],sortKey='line',ascending=false;
 function compare(a,b){
  const key=v=>sortKey==='code'?[v.code,v.thread].filter(Boolean).join(' / '):v[sortKey]??'';
  const x=key(a),y=key(b),z=(sortKey==='line')?Number(x)-Number(y):String(x).localeCompare(String(y),'ko',{numeric:true,sensitivity:'base'});
  return (ascending?1:-1)*z;
 }
 function render(){
  const filtered=remoteEvents.filter(x=>$('remoteEventFilter').value==='all'||x.level===$('remoteEventFilter').value).sort(compare);
  $('remoteEventCount').textContent=remoteEvents.length.toLocaleString('ko-KR')+'건';
  $('remoteEventSummary').textContent='현재 읽기 버퍼 '+remoteEvents.length.toLocaleString('ko-KR')+'건 · 오류 '+remoteEvents.filter(x=>x.level==='error').length+'건 · 경고 '+remoteEvents.filter(x=>x.level==='warning').length+'건 · 화면 표시 '+Math.min(filtered.length,200)+'건';
  const body=$('remoteEventRows');body.replaceChildren();
  for(const ev of filtered.slice(0,200)){
   const tr=document.createElement('tr');
   for(const [i,value] of [ev.level,ev.time||'-',ev.message,([ev.code,ev.thread].filter(Boolean).join(' / ')||'-'),String(ev.line)].entries()){
    const cell=document.createElement('td');if(i===4)cell.className='right mono';
    if(i===0){const pill=document.createElement('span');pill.className='level-pill '+ev.level;pill.textContent=ev.level==='error'?'오류':ev.level==='warning'?'경고':'일반';cell.append(pill)}
    else{cell.textContent=value;if(i===2)cell.className='message-cell'}
    tr.append(cell);
   }body.append(tr);
  }
 }
 function rebuild(){
  const snapshot=window.RemoteLogProfiles?.currentText?.()||'';
  remoteEvents=[];
  if(snapshot){const parser=new JeusParser.Parser(event=>remoteEvents.push(event));for(const line of snapshot.split(/\r?\n/)){parser.ingest(line)}parser.finish();}
  render();
 }
 window.addEventListener('jeus:remote-updated',rebuild);
 $('remoteEventFilter').addEventListener('change',render);
 analytics.addEventListener('click',e=>{
  const key=e.target.closest('[data-remote-sort]')?.dataset.remoteSort;if(!key)return;
  if(sortKey===key)ascending=!ascending;else{sortKey=key;ascending=true}
  for(const b of analytics.querySelectorAll('[data-remote-sort]'))b.setAttribute('aria-sort',b.dataset.remoteSort===key?(ascending?'ascending':'descending'):'none');
  render();
 });
 function navigate(remoteView){
  content.classList.toggle('remote-mode',remoteView);
  $('navLocal').classList.toggle('active',!remoteView);
  $('navConnect').classList.toggle('active',remoteView);
  $('navLocal').setAttribute('aria-current',remoteView?'false':'page');
  $('navConnect').setAttribute('aria-current',remoteView?'page':'false');
  $('breadcrumbName').textContent=remoteView?'Connect · 원격 분석':'로그 분석';
  window.scrollTo({top:0,behavior:'instant'});
 }
 $('navLocal').addEventListener('click',()=>navigate(false));
 $('navConnect').addEventListener('click',()=>navigate(true));
 navigate(false);
})();
