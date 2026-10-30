'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const vm=require('node:vm');const fs=require('node:fs');const path=require('node:path');
const script=fs.readFileSync(path.join(__dirname,'../web/search-worker.js'),'utf8');
async function runSearch(events,query,group){
 let offset=0;const descriptors=new Uint8Array(events.length*24);const view=new DataView(descriptors.buffer);
 const bytes=[];for(let i=0;i<events.length;i++){const e=events[i],chunk=new TextEncoder().encode(e.text);bytes.push(chunk);view.setBigUint64(i*24,BigInt(offset),true);view.setUint32(i*24+8,chunk.length,true);view.setUint8(i*24+20,e.level);view.setUint8(i*24+21,e.category);view.setUint8(i*24+22,e.subtype||0);offset+=chunk.length;}
 const file=new File(bytes,'log.txt');
 const messages=[];const sandbox={TextDecoder,URL,Uint8Array,DataView,Date,File,postMessage:v=>messages.push(v),fetch:async()=>new Response(descriptors,{status:200})};
 vm.runInNewContext(script,sandbox);
 sandbox.onmessage({data:{file,id:'test',encoding:'utf-8',query,group,total:events.length}});
 const started=Date.now();while(!messages.some(m=>m.type==='complete'||m.type==='error')){await new Promise(r=>setTimeout(r,25));if(Date.now()-started>5000)throw Error('timeout')}
 return messages.find(m=>m.type==='complete'||m.type==='error');
}
test('SQL subtype keyword matches only matching events',async()=>{
 const events=[{text:'ORA-00904 syntax error',level:1,category:1,subtype:1},{text:'ORA-00001 same user name',level:1,category:1,subtype:2},{text:'ORA-00904 informational explanation',level:3,category:0,subtype:0}];
 const result=await runSearch(events,'ora-00904','sql:1');assert.equal(result.type,'complete');assert.equal(result.totalMatches,1);assert.deepEqual(Array.from(result.indices),[0]);
});
test('Search UTF-8 Korean token crossing a 256KiB chunk boundary of one large event',async()=>{
 const boundary=256*1024;const content='A'.repeat(boundary-3)+'SQL 오류 발생: ORA-00904'+'Z'.repeat(9*1024*1024);
 const result=await runSearch([{text:content,level:1,category:1,subtype:1}],'SQL 오류 발생','sql:1');
 assert.equal(result.type,'complete');assert.equal(result.totalMatches,1);
});

test('review filter matches metadata bit 23 without escalating INFO level',async()=>{
 const events=[{text:'ORA-12899 INFO evidence',level:3,category:1,subtype:8,review:1},{text:'INFO normal',level:3,category:0,review:0},{text:'ERROR',level:1,category:0,review:0}];
 const filtered=await runSearch(events,'ORA-12899','review');
 assert.equal(filtered.type,'complete');assert.deepEqual(Array.from(filtered.indices),[0]);
});
