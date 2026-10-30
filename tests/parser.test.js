const assert=require('node:assert/strict');
const {test}=require('node:test');
const {Parser,header,determineLevel,hasFailure,signature}=require('../web/parser.js');
function parse(lines){const events=[];const p=new Parser(e=>events.push(e));lines.forEach(l=>p.ingest(l));p.finish();return events;}
test('JEUS 8/9 standard numeric levels and fields',()=>{
 const events=parse([
 '[2026.10.23 10:00:01][2] [ms1-1] [SERVER-0248] The JEUS server is STARTING.',
 '[2026.10.23 10:00:02][1] [ms1-2] [SERVER-0999] Thread pool warning',
 '[2026.10.23 10:00:03][0] [ms1-3] [SERVER-0555] Failed to deploy'
 ]);
 assert.deepEqual(events.map(e=>e.level),['info','warning','error']);
 assert.equal(events[0].time,'2026.10.23 10:00:01');assert.equal(events[0].thread,'ms1-1');assert.equal(events[0].code,'SERVER-0248');
 assert.deepEqual(events.map(e=>e.line),[1,2,3]);assert.deepEqual(events.map(e=>e.endLine),[1,2,3]);
});
test('JEUS numeric level 3-7 is general not errors',()=>{
 const ev=parse([3,4,5,6,7].map(i=>`[2026.10.23 11:00:01][${i}] [server-1] [APP-1234] ordinary`));
 assert.ok(ev.every(e=>e.level==='info'));
});
test('Java multiline stack trace associates with one error and proper end line',()=>{
 const ev=parse(['[2026.10.23 10:05:00][0] [ms1-1] [WEB-0009] Request failed',
 'java.lang.NullPointerException: Unable to process','\tat com.demo.Service.run(Service.java:31)','Caused by: java.sql.SQLException: connection lost','\tat com.demo.DB.get(DB.java:5)',
 '[2026.10.23 10:05:01][2] [ms1-1] [WEB-0001] next']);
 assert.equal(ev.length,2);assert.equal(ev[0].line,1);assert.equal(ev[0].endLine,5);assert.equal(ev[1].line,6);assert.equal(ev[0].group,'NullPointerException');assert.match(ev[0].raw,/Caused by/);
});
test('JEUS timestamp with milliseconds, spaces and severity',()=>{
 assert.equal(header('[2024.09.25 16:01:33:105][2] [ms1-1] [SERVER-0248] Ready').level,'info');
 assert.equal(header('[2024.09.25 16:01:33][0] [ms1-1] [SERVER-0248] Error').level,'error');
});
test('Common dated Java level formats',()=>{
 const ev=parse(['2026-10-23 11:30:00,125 INFO App initialized','2026-10-23 11:30:01,200 ERROR Database down','[2026-10-23 11:30:02] [WARN] slow']);
 assert.deepEqual(ev.map(e=>e.level),['info','error','warning']);
});
test('Undated plain log and severity inference',()=>{
 const ev=parse(['INFO server is ready','WARN low memory','java.lang.OutOfMemoryError: Java heap space','  at com.example.A.a(A.java:1)','ERROR Request failed']);
 assert.deepEqual(ev.map(e=>e.level),['info','warning','error','error']);
 assert.equal(ev[2].endLine,4);
});
test('Explicit INFO overrides non-error mention of exception',()=>{
 const ev=parse(['[2026.10.23 10:00:00][2] [x-1] [SERVER-0010] Installed ExceptionHandler']);
 assert.equal(ev[0].level,'info');
});
test('Unknown format falls back to information, not guessed healthy',()=>{
 assert.equal(parse(['Started listening on port 8080'])[0].level,'info');
});
test('Recognizes exception standalone',()=>{assert.equal(hasFailure('Caused by: java.sql.SQLException: failed'),true);assert.equal(determineLevel(null,'NullPointerException: fail'),'error');});
test('Limits unusually long individual multiline messages',()=>{
 const events=[];const p=new Parser(e=>events.push(e));p.ingest('java.lang.RuntimeException: bad');for(let i=0;i<2000;i++)p.ingest(' '+ 'a'.repeat(200));p.finish();
 assert.equal(events.length,1);assert.match(events[0].raw,/이벤트가 너무 길어/);assert.ok(events[0].raw.length<70000);
});
test('No execution or HTML interpretation of suspicious text',()=>{
 const ev=parse(['[2026.10.23 10:00:00][0] [x-1] [SERVER-3333] <img src=x onerror=alert(1)>']);
 assert.ok(ev[0].message.includes('<img src=x onerror=alert(1)>'));
});

test('actual MES JEUS seven-bracket header captures thread and request identity',()=>{
 const line='[2026-10-22 00:00:00.025][INFO][DefaultDevScheduler_Worker-1][102][TESTTRACE0000000000000000000000000001][SchedulerMessage][SQLService] - [ORACLE] Begin SELECT 1 FROM DUAL';
 const h=header(line);assert.ok(h);assert.equal(h.level,'info');assert.equal(h.thread,'DefaultDevScheduler_Worker-1');
 assert.equal(h.contextId,'TESTTRACE0000000000000000000000000001');assert.equal(h.component,'SQLService');
 assert.equal(h.message,'[ORACLE] Begin SELECT 1 FROM DUAL');
 const e=parse([line,'Caused by: java.sql.SQLException: ORA-12899 too large','[2026-10-22 00:00:00.027][ERROR][webtob-listener-hth0-5][101][REQ01][HttpMessage][MessageProxy2] - failed']);
 assert.equal(e.length,2);assert.equal(e[0].level,'info');assert.equal(e[0].contextId,h.contextId);
 assert.equal(e[1].thread,'webtob-listener-hth0-5');assert.equal(e[1].level,'error');
});
