'use strict';
// Global sorting always runs on the entire matching event set, not the visible
// 100-row page. Keep original log bytes in the user-owned File, outside the
// Go/Rust metadata archive. The worker holds only sortable keys and event IDs.
importScripts('parser.js');
const collator=new Intl.Collator('ko',{numeric:true,sensitivity:'base'});
let ordered=[];
const maximumRaw=128*1024;
const fetchBytes=async url=>{
 const response=await fetch(url,{cache:'no-store'});
 if(!response.ok)throw Error('전체 정렬에 필요한 인덱스를 읽지 못했습니다 (HTTP '+response.status+').');
 return new DataView(await response.arrayBuffer());
};
function eventKey(raw,by){
 const first=raw.slice(0,raw.indexOf('\n')<0?raw.length:raw.indexOf('\n'));
 const h=JeusParser.header(first);
 if(by==='time')return h?.time||'';
 if(by==='message')return (h?.message||first).trim().slice(0,1000);
 if(by==='code'){
  const code=(raw.match(/\b(?:ORA|PLS)-\d{4,5}\b/i)||[])[0]||h?.code||((raw.match(/\b[A-Za-z][\w.-]*-\d{3,}\b/)||[])[0]||'');
  return [code,h?.thread||''].filter(Boolean).join(' / ');
 }
 throw Error('지원하지 않는 정렬 열입니다.');
}
async function sortAll({file,id,encoding,total,by,filterId,filterTotal,searchIds}){
 if(!file||!['time','message','code','level','line'].includes(by))throw Error('전체 정렬 설정이 잘못되었습니다.');
 const selection=searchIds!==null?'search':filterId&&filterId!=='all'?'filter':'all';
 let selectedPos=0,selectedChunk=new Uint32Array(0),selectedOffset=0;
 const selectedTotal=selection==='search'?searchIds.length:selection==='filter'?filterTotal:total;
 async function nextSelected(){
  if(selection==='all')return Infinity;
  if(selection==='search')return selectedPos<searchIds.length?searchIds[selectedPos++]:Infinity;
  if(selectedOffset>=selectedChunk.length){
   if(selectedPos>=selectedTotal)return Infinity;
   const count=Math.min(50000,selectedTotal-selectedPos);
   const bytes=await fetchBytes('/api/filter-indices?id='+encodeURIComponent(id)+'&filterId='+encodeURIComponent(filterId)+'&start='+selectedPos+'&count='+count);
   if(bytes.byteLength!==count*8)throw Error('필터 인덱스 크기가 일치하지 않습니다.');
   selectedChunk=new Uint32Array(count);
   for(let i=0;i<count;i++){
    const value=Number(bytes.getBigUint64(i*8,true));
    if(!Number.isSafeInteger(value)||value>=total)throw Error('필터 인덱스가 손상되었습니다.');
    selectedChunk[i]=value;
   }
   selectedOffset=0;selectedPos+=count;
  }
  return selectedChunk[selectedOffset++];
 }
 let next=selection==='all'?Infinity:await nextSelected();
 const textDecoder=new TextDecoder(encoding,{fatal:false});
 const result=[];
 let pending=[],start=-1,end=0,lastProgress=0;
 async function flush(){
  if(!pending.length)return;
  if(by==='level'||by==='line'){
   for(const r of pending)result.push({id:r.id,key:by==='level'?r.level===1?0:r.level===2?1:2:r.line});
  }else{
   const buffer=new Uint8Array(await file.slice(start,end).arrayBuffer());
   for(const r of pending){
    const low=r.offset-start,high=low+r.limit;
    const raw=textDecoder.decode(buffer.subarray(low,high)).replace(/\r?\n$/,'');
    result.push({id:r.id,key:eventKey(raw,by)});
   }
  }
  pending=[];start=-1;end=0;
 }
 for(let cursor=0;cursor<total;cursor+=16000){
  const count=Math.min(16000,total-cursor);
  const data=await fetchBytes('/api/index?id='+encodeURIComponent(id)+'&start='+cursor+'&count='+count);
  if(data.byteLength!==count*24)throw Error('로그 인덱스의 길이가 일치하지 않습니다.');
  for(let i=0;i<count;i++){
   const original=cursor+i;
   if(selection!=='all'){
    if(original<next)continue;
    if(original!==next)throw Error('필터 인덱스의 정렬 상태가 올바르지 않습니다.');
    next=await nextSelected();
   }
   const pos=i*24,off=Number(data.getBigUint64(pos,true)),length=data.getUint32(pos+8,true),line=data.getUint32(pos+12,true);
   if(!Number.isSafeInteger(off)||off+length>file.size)throw Error('원본 파일과 분석 인덱스가 일치하지 않습니다.');
   const limit=Math.min(length,maximumRaw);
   if(pending.length&&by!=='line'&&by!=='level'&&(off+limit-start>4*1024*1024))await flush();
   if(start<0)start=off;
   end=Math.max(end,off+limit);
   pending.push({id:original,offset:off,limit,level:data.getUint8(pos+20),line});
  }
  await flush();
  if(Date.now()-lastProgress>180){lastProgress=Date.now();postMessage({type:'progress',scanned:cursor+count,total,found:result.length});}
 }
 if(selection!=='all'&&next!==Infinity)throw Error('필터 인덱스의 일부를 읽지 못했습니다.');
 if(result.length!==selectedTotal)throw Error('정렬 대상 건수와 실제 인덱스 건수가 일치하지 않습니다.');
 result.sort((a,b)=>{
  const compared=by==='level'||by==='line'?a.key-b.key:collator.compare(a.key,b.key);
  return compared||a.id-b.id;
 });
 ordered=result.map(entry=>entry.id);
 postMessage({type:'ready',total:ordered.length});
}
function page(request,page,asc){
 const begin=Math.max(0,(page-1)*100),part=[];
 for(let i=begin;i<begin+100&&i<ordered.length;i++){
  part.push(ordered[asc?i:ordered.length-1-i]);
 }
 postMessage({type:'page',request,indices:part,total:ordered.length});
}
onmessage=event=>{
 const d=event.data;
 if(d.type==='sort'){ordered=[];sortAll(d).catch(e=>postMessage({type:'error',message:String(e.message||e)}));}
 else if(d.type==='page')page(d.request,d.page,d.asc);
};
