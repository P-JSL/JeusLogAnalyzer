'use strict';
// Full-text search is performed against the browser-owned original File.
// It never sends raw log bytes to /api/filter or writes raw bytes to storage.
function accept(level,cat,group,subtype){switch(group){case'sql':return cat===1;case'otherError':return cat===0&&level===1;case'error':return level===1;case'warning':return level===2;case'info':return level===3;default:if(group.startsWith('sql:'))return cat===1&&Number(group.slice(4))===subtype;return true;}}
async function search({file,id,encoding,query,group,total,caseSensitive=false}){
 const decoder=new TextDecoder(encoding);const needle=caseSensitive?query:query.toLocaleLowerCase();let indices=[];let totalMatches=0;const cap=100000;let cursor=0;let lastReport=0;
 // Read up to 16k fixed-size descriptors per request (384 KiB), reducing HTTP overhead.
 // Raw source slices remain capped at 8 MiB; no event text is kept in metadata.
 while(cursor<total){const count=Math.min(16000,total-cursor);const res=await fetch(`/api/index?id=${id}&start=${cursor}&count=${count}`,{cache:'no-store'});if(!res.ok)throw Error('메타데이터 인덱스를 읽을 수 없습니다.');const data=new DataView(await res.arrayBuffer());if(data.byteLength!==count*24)throw Error('인덱스 길이가 불일치합니다.');
 let groupStart=-1,groupEnd=0,pending=[];
 const flush=async()=>{if(!pending.length)return;const bytes=new Uint8Array(await file.slice(groupStart,groupEnd).arrayBuffer());for(const p of pending){const low=p.start-groupStart,high=p.end-groupStart;const text=(caseSensitive?decoder.decode(bytes.subarray(low,high)):decoder.decode(bytes.subarray(low,high)).toLocaleLowerCase());if(text.includes(needle)){totalMatches++;if(indices.length<cap)indices.push(p.index);}}pending=[];groupStart=-1;groupEnd=0;};
 for(let i=0;i<count;i++){const pos=i*24;const level=data.getUint8(pos+20),cat=data.getUint8(pos+21);if(!accept(level,cat,group,data.getUint8(pos+22)))continue;const start=Number(data.getBigUint64(pos,true)),length=data.getUint32(pos+8,true),end=start+length;if(!Number.isSafeInteger(start)||end>file.size)throw Error('원본 파일과 메타데이터의 크기가 불일치합니다.');
 // Long individual events are searched in bounded chunks with overlap.
 if(length>8*1024*1024){await flush();let tail='';let found=false;const streamDecoder=new TextDecoder(encoding),overlap=Math.max(1024,needle.length*2+4);for(let at=start;at<end;at+=256*1024){const part=new Uint8Array(await file.slice(at,Math.min(end,at+256*1024)).arrayBuffer());const text=tail+(caseSensitive?streamDecoder.decode(part,{stream:true}):streamDecoder.decode(part,{stream:true}).toLocaleLowerCase());if(text.includes(needle)){found=true;break;}tail=text.slice(-overlap);}if(found){totalMatches++;if(indices.length<cap)indices.push(cursor+i);}continue;}
 if(pending.length&&(end-groupStart>8*1024*1024)){await flush();}
 if(!pending.length)groupStart=start;
 groupEnd=end;pending.push({index:cursor+i,start,end});
 }
 await flush();cursor+=count;if(Date.now()-lastReport>120){lastReport=Date.now();postMessage({type:'progress',scanned:cursor,matches:indices.length});}
 }
 postMessage({type:'complete',indices,totalMatches,limited:totalMatches>cap});
}
onmessage=e=>{search(e.data).catch(err=>postMessage({type:'error',message:err.message||String(err)}));};
