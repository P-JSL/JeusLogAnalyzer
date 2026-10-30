'use strict';
// No remote credentials, request IDs or raw responses are written to storage.
// Only direct user's local-origin POST can access the server's read-only SFTP endpoint.
(function(){
 const el=id=>document.getElementById(id);
 const button=el('remoteRead'),status=el('remoteStatus'),output=el('remoteOutput');
 let busy=false,refresh=null;
 const fields=['remoteHost','remotePort','remoteUser','remotePass','remoteFingerprint','remotePath'];
 function values(){
  return {host:el('remoteHost').value.trim(),port:Number(el('remotePort').value),user:el('remoteUser').value,
   password:el('remotePass').value,fingerprint:el('remoteFingerprint').value.trim(),path:el('remotePath').value.trim(),maxBytes:512*1024};
 }
 async function read(){
  if(busy||document.hidden)return;
  busy=true;button.disabled=true;status.textContent='SFTP 읽기 전용 조회 중…';
  try{
   const response=await fetch('/api/remote-tail',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(values()),cache:'no-store'});
   if(!response.ok){
    const error=await response.json().catch(()=>({error:'원격 조회 실패'}));
    throw Error(error.error||'원격 조회 실패');
   }
   const data=await response.json();
   const binary=atob(data.data||'');
   const bytes=new Uint8Array(binary.length);
   for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
   const decoded=new TextDecoder(el('remoteEncoding').value,{fatal:false}).decode(bytes);
   output.textContent=(data.partial?'[파일 끝부분 512KiB만 표시합니다. 앞부분은 포함되지 않습니다.]\n':'')+decoded;
   status.textContent='조회 완료 · 원격 크기 '+Number(data.size).toLocaleString('ko-KR')+' bytes · '+new Date().toLocaleTimeString('ko-KR');
  }catch(error){
   status.textContent='원격 조회 실패: '+String(error.message||error);
   // Do not keep retrying with a wrong host key or credentials.
   el('remoteAuto').checked=false;stopAuto();
  }finally{busy=false;button.disabled=false}
 }
 function stopAuto(){if(refresh){clearInterval(refresh);refresh=null}}
 function updateAuto(){stopAuto();if(el('remoteAuto').checked)refresh=setInterval(()=>{if(!document.hidden)void read()},10000)}
 button.addEventListener('click',()=>void read());
 el('remoteAuto').addEventListener('change',updateAuto);
 for(const id of fields){el(id).addEventListener('change',()=>{el('remoteAuto').checked=false;stopAuto()})}
 window.addEventListener('pagehide',stopAuto);
})();
