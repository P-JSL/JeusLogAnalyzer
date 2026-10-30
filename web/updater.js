'use strict';
// Update credentials remain only in this browser tab and in one same-origin
// request. The server fetches and hashes the executable before atomic swap.
(function(){
 const el=id=>document.getElementById(id);
 const checkButton=el('updateCheck'),applyButton=el('updateApply'),status=el('updateStatus');
 const token=el('updateToken'),auto=el('updateAutoCheck'),mode=el('updateMode');
 let busy=false,ready=false,interval=null,disposed=false;
 async function api(endpoint){
  const res=await fetch('/api/update/'+endpoint,{
   method:'POST',headers:{'Content-Type':'application/json'},
   cache:'no-store',body:JSON.stringify({token:token.value})
  });
  let data;
  try{data=await res.json()}catch{throw Error('업데이트 서버가 올바르지 않은 응답을 보냈습니다 (HTTP '+res.status+').')}
  if(!res.ok)throw Error(String(data.error||'업데이트 요청 실패').slice(0,400));
  return data;
 }
 function failure(error){
  ready=false;applyButton.disabled=true;
  status.textContent='업데이트 확인 실패 · '+String(error.message||error).slice(0,400);
 }
 async function apply(){
  if(busy||!ready)return;
  busy=true;applyButton.disabled=true;checkButton.disabled=true;
  status.textContent='GitHub 실행 파일 다운로드 및 SHA-256 검증 중…';
  try{
   const data=await api('apply');
   status.textContent='업데이트 '+data.version+' 설치 준비 완료 · 프로그램이 종료되고 새 버전으로 자동 재실행됩니다.';
   ready=false;
  }catch(error){failure(error)}
  finally{busy=false;checkButton.disabled=false;applyButton.disabled=!ready}
 }
 async function check(silent=false){
  if(busy||disposed)return;
  if(silent&&!auto.checked)return;
  busy=true;checkButton.disabled=true;applyButton.disabled=true;
  if(!silent)status.textContent='GitHub 최신 정식 릴리즈 정보를 확인 중…';
  try{
   const data=await api('check');
   ready=Boolean(data.updateAvailable);
   if(ready){
    status.textContent='새 버전 '+data.latestVersion+' 발견 · 설치 대상: '+data.runtime.toUpperCase()+
      ' · '+Number(data.size).toLocaleString('ko-KR')+' bytes';
    applyButton.disabled=!data.installSupported;
    if(!data.installSupported)status.textContent+=' · 이 환경은 Windows 자동 설치를 지원하지 않습니다.';
   }else{status.textContent='최신 버전 사용 중 · v'+data.currentVersion;applyButton.disabled=true}
  }catch(error){failure(error)}
  finally{busy=false;checkButton.disabled=false}
  if(ready&&mode.value==='automatic')await apply();
 }
 function schedule(){
  if(interval)clearInterval(interval);
  interval=null;
  if(auto.checked)interval=setInterval(()=>{if(!document.hidden)void check(true)},30*60*1000);
 }
 checkButton.addEventListener('click',()=>void check());
 applyButton.addEventListener('click',()=>void apply());
 auto.addEventListener('change',schedule);
 // A session-scoped token may be entered for private releases. Never persist it.
 token.addEventListener('change',()=>{ready=false;applyButton.disabled=true;if(token.value||auto.checked)void check(true)});
 mode.addEventListener('change',()=>{if(mode.value==='automatic'&&ready)void apply()});
 window.addEventListener('pagehide',()=>{disposed=true;if(interval)clearInterval(interval);token.value='';});
 schedule();
 // Initial background check is safe: anonymous 404 is displayed only in
 // the update panel, not as an application error or credential prompt.
 void check(true);
})();
