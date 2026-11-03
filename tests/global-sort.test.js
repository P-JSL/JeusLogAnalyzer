'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const workerSource=fs.readFileSync(path.join(__dirname,'../web/global-sort-worker.js'),'utf8');
const parserSource=fs.readFileSync(path.join(__dirname,'../web/parser.js'),'utf8');
const encoder=new TextEncoder();
const entries=Array.from({length:240},(_,i)=>{
 const n=239-i,time='2026.10.23 12:'+String(Math.floor(n/60)).padStart(2,'0')+':'+String(n%60).padStart(2,'0');
 return {line:'['+time+']['+(i%3===0?'0':i%3===1?'1':'2')+'] [ms1-1] [APP-'+String(3000+i).padStart(4,'0')+'] message-'+String(n).padStart(4,'0'),level:i%3+1};
});
function fixture(){
 const data=encoder.encode(entries.map(x=>x.line).join('\n')+'\n');
 const index=new Uint8Array(entries.length*24);
 const view=new DataView(index.buffer);
 let offset=0;
 entries.forEach((e,i)=>{
  const length=encoder.encode(e.line+'\n').length,p=i*24;
  view.setBigUint64(p,BigInt(offset),true);view.setUint32(p+8,length,true);
  view.setUint32(p+12,i+1,true);view.setUint32(p+16,i+1,true);
  view.setUint8(p+20,e.level);offset+=length;
 });
 const selected=entries.map((_,i)=>i).filter(i=>i%2===0);
 const filter=new Uint8Array(selected.length*8);const f=new DataView(filter.buffer);
 selected.forEach((n,i)=>f.setBigUint64(i*8,BigInt(n),true));
 return {index,filter,data,selected};
}
function setup(){
 const fixtureData=fixture(),events=[];
 const context=vm.createContext({TextDecoder,Uint8Array,Uint32Array,DataView,Intl,Date,Number,Error,Math,BigInt,Blob,
  postMessage:data=>events.push(data),fetch:async url=>{
   const parsed=new URL(url,'http://127.0.0.1'),isFilter=parsed.pathname.includes('filter-indices');
   const start=Number(parsed.searchParams.get('start')),count=Number(parsed.searchParams.get('count'));
   const stride=isFilter?8:24,source=isFilter?fixtureData.filter:fixtureData.index;
   const bytes=source.slice(start*stride,(start+count)*stride);
   return {ok:true,status:200,arrayBuffer:async()=>bytes.buffer};
  }});
 context.importScripts=()=>vm.runInContext(parserSource,context);
 vm.runInContext(workerSource,context);
 async function ready(options){
  context.onmessage({data:{type:'sort',id:'a'.repeat(32),file:new Blob([fixtureData.data]),
   encoding:'utf-8',total:entries.length,filterId:'all',filterTotal:entries.length,searchIds:null,...options}});
  for(let attempt=0;attempt<200;attempt++){
   const error=events.find(e=>e.type==='error');if(error)throw Error(error.message);
   if(events.some(e=>e.type==='ready'))return;
   await new Promise(r=>setTimeout(r,5));
  }
  throw Error('global sorter did not finish');
 }
 function page(p,asc=true){
  const request=events.length+1;context.onmessage({data:{type:'page',page:p,asc,request}});
  const result=events.find(e=>e.type==='page'&&e.request===request);
  assert.ok(result);return result.indices;
 }
 return {ready,page,events,fixtureData};
}
test('timestamp order covers all 240 events across three pages, not 100 visible rows',async()=>{
 const w=setup();await w.ready({by:'time'});
 assert.equal(w.events.find(e=>e.type==='ready').total,240);
 assert.deepEqual(w.page(1),Array.from({length:100},(_,i)=>239-i));
 assert.deepEqual(w.page(2),Array.from({length:100},(_,i)=>139-i));
 assert.deepEqual(w.page(3),Array.from({length:40},(_,i)=>39-i));
 assert.deepEqual(w.page(1,false),Array.from({length:100},(_,i)=>i));
});
test('message/code ordering and filtered 8-byte indices are global',async()=>{
 for(const by of ['message','code']){
  const w=setup();await w.ready({by});
  assert.equal(w.events.find(e=>e.type==='ready').total,240);
  const merged=[...w.page(1),...w.page(2),...w.page(3)];
  assert.equal(new Set(merged).size,240);
 }
 const f=setup();
 await f.ready({by:'time',filterId:'f1',filterTotal:f.fixtureData.selected.length});
 assert.deepEqual(f.page(1),f.fixtureData.selected.slice().reverse().slice(0,100));
 assert.deepEqual(f.page(2),f.fixtureData.selected.slice().reverse().slice(100));
});
test('in-memory search result sorting respects complete selected set',async()=>{
 const w=setup();const chosen=[5,87,170,239];
 await w.ready({by:'level',searchIds:chosen});
 const sorted=[...chosen].sort((a,b)=>entries[a].level-entries[b].level||a-b);
 assert.deepEqual(w.page(1),sorted);
 assert.deepEqual(w.page(1,false),sorted.reverse());
});
