'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const {diagnose,splitBindings,mask}=require('../web/diagnostics.js');
test('pinpoints deepest Java cause and exact original line and source frame',()=>{
 const raw='[2026.10.23 10:00:00][0] ERROR failed\njava.lang.IllegalStateException: service failed\n at com.acme.Service.run(Service.java:91)\nCaused by: java.sql.SQLException: ORA-00904 invalid identifier\n at com.acme.DbMapper.save(DbMapper.java:184)';
 const d=diagnose(raw,300);assert.deepEqual(d.location,{kind:'stack',logLine:304,source:'DbMapper.java',sourceLine:184,method:'com.acme.DbMapper.save'});
 assert.match(d.causes[0].message,/ORA-00904/);assert.equal(d.focusLine,304);
});
test('fallback when stack lacks source line or error contains only ORA code',()=>{
 let d=diagnose('ERROR ORA-00001: unique constraint violated',18);assert.equal(d.location.kind,'log');assert.equal(d.location.logLine,18);
 d=diagnose('java.lang.IllegalArgumentException: bad\n at java.base/java.lang.Thread.run(Unknown Source)',21);assert.equal(d.location.source,'');assert.equal(d.location.logLine,21);
});
test('extracts MyBatis SQL and positional bindings with quoted commas',()=>{
 const raw='[2026.10.23][0] SQL error\n==> Preparing: INSERT INTO X (LOT_ID, NAME) VALUES (?, ?)\n==> Parameters: 001-LOT(String), "Kim, Park"(String)\nCaused by: java.sql.SQLException';
 const e=diagnose(raw,100).evidence;
 assert.ok(e.some(x=>x.kind==='sql'&&x.value.includes('INSERT INTO X')&&x.line===101));
 assert.ok(e.some(x=>x.name==='bind[1]'&&x.value==='001-LOT(String)'&&x.line===102));
 assert.ok(e.some(x=>x.name==='bind[2]'&&x.value==='"Kim, Park"(String)'&&x.line===102));
 assert.deepEqual(splitBindings('1(Integer), "a,b"(String), 2(Integer)'),['1(Integer)','"a,b"(String)','2(Integer)']);
});
test('extracts identifiable error data but masks secrets',()=>{
 const raw='[2026.10.23][0] failed LOT_ID=0044-26-0072 EQUIPMENT_ID=MTM40\nPayload: PASSWORD=superSecret TOKEN=abcdefgh API_KEY=1234 PARAMETER_VALUE=0.3';
 const e=diagnose(raw,1).evidence;
 assert.equal(e.find(x=>x.name==='LOT_ID').value,'0044-26-0072');
 assert.equal(e.find(x=>x.name==='EQUIPMENT_ID').value,'MTM40');
 assert.match(e.find(x=>x.name==='PASSWORD').value,/마스킹/);
 assert.match(e.find(x=>x.name==='TOKEN').value,/마스킹/);
 assert.match(e.find(x=>x.name==='API_KEY').value,/마스킹/);
 assert.equal(e.find(x=>x.name==='PARAMETER_VALUE').value,'0.3');
 assert.equal(mask('secretKey','sensitive').includes('sensitive'),false);
});
test('never invents input values when absent',()=>{
 const d=diagnose('ERROR NullPointerException\n at com.test.Svc.call(Svc.java:12)',10);
 assert.equal(d.hasData,false);assert.equal(d.location.logLine,11);
});
test('non-Java stack does not claim a source location',()=>{
 const d=diagnose('[2026.10.23][0] java.sql.SQLException ORA-01013',25);
 assert.equal(d.location.kind,'log');assert.equal(d.location.sourceLine,null);
});

test('extracts MyBatis ### SQL, ### Cause, and multiple vendor/SQLSTATE markers without guessing',()=>{
 const raw=[
  '[2026.10.30 08:00:00][0] database access failed',
  '### SQL: SELECT * FROM T WHERE LOT_ID = ?',
  '### Cause: java.sql.SQLSyntaxErrorException: ORA-00942 missing table',
  'SQLState: 42000',
  'Caused by: java.sql.SQLException: ORA-01031 permission denied',
  ' at com.example.Dao.run(Dao.java:137)'
 ].join('\n');
 const d=diagnose(raw,70);
 assert.ok(d.evidence.some(x=>x.kind==='sql'&&x.value.includes('SELECT * FROM T')&&x.line===71));
 assert.deepEqual(d.sqlCodes.map(x=>[x.code,x.line]),[['ORA-00942',72],['ORA-01031',74]]);
 assert.deepEqual(d.sqlStates.map(x=>[x.code,x.line]),[['42000',73]]);
 assert.deepEqual(d.exceptions.map(x=>x.type),['java.sql.SQLSyntaxErrorException','java.sql.SQLException']);
 assert.equal(d.rootCause.line,74);
 assert.ok(!d.evidence.some(x=>x.name==='Cause'||x.name==='SQLState'), 'diagnostic metadata is not business input');
 assert.equal(d.location.source,'Dao.java');
 assert.equal(d.location.logLine,75);
});
test('SQL-only ### Cause is an observed cause hint, not a fabricated Java source frame',()=>{
 const d=diagnose('### Cause: java.sql.SQLException: ORA-00001 unique constraint',42);
 assert.equal(d.rootCause.line,42);
 assert.equal(d.location.kind,'log');
 assert.equal(d.sqlCodes[0].code,'ORA-00001');
 assert.equal(d.exceptions[0].role,'SQL cause');
});
test('SQL evidence deduplicates observed DB codes without discarding first source line',()=>{
 const d=diagnose('ORA-00904 invalid\nORA-00904 repeated\nPLS-00201 undeclared',10);
 assert.deepEqual(d.sqlCodes.map(x=>x.line),[10,12]);
 assert.deepEqual(d.sqlCodes.map(x=>x.code),['ORA-00904','PLS-00201']);
});

test('MES SQLService ORACLE Begin emits SQL evidence with exact original log line',()=>{
 const raw='[2026-10-22 09:00:00.000][INFO][worker-1][102][TRACE001][RequestMessage][SQLService] - [ORACLE] Begin SELECT COUNT(*) FROM DUAL';
 const d=diagnose(raw,470);
 assert.ok(d.evidence.some(x=>x.kind==='sql'&&x.value==='SELECT COUNT(*) FROM DUAL'&&x.line===470));
});
