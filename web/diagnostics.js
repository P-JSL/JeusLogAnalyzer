/* Evidence-based fault location and failing-input extraction. Runs only against
 * user-selected original File bytes on demand; nothing is added to disk indexes.
 * A stack frame identifies a recorded failure site, not necessarily its cause.
 */
(function (root) {
  'use strict';
  const FRAME=/^\s*at\s+([\w.$<>/]+)\(([^():]+):(\d+)\)/;
  const EXCEPTION=/(?:[\w$]+\.)*[A-Za-z_$][\w$]*(?:Exception|Error)\b/;
  const ERROR_CODE=/\b(?:ORA|PLS)-\d{4,5}\b|\bSQL\s*STATE\s*[:=]?\s*[A-Z0-9]{5}\b/i;
  const SQL=/^\s*(?:(?:==>|#{3})\s*)?(?:Preparing|Executing SQL|SQL|Query|Statement)\s*[:=]\s*(.+)$/i;
  const ORACLE_SQL=/\[SQLService\]\s*-\s*\[ORACLE\]\s*Begin\s+((?:SELECT|INSERT|UPDATE|DELETE|MERGE|WITH|BEGIN|CALL)\b.*)$/i;
  const EXCEPTION_LINE=/^\s*(?:(Caused by|Suppressed)\s*:\s*|#{3}\s*Cause\s*:\s*)?((?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*(?:Exception|Error))\b/;
  const DB_CODE_ALL=/\b(?:ORA|PLS)-\d{4,5}\b/gi;
  const SQL_STATE_ALL=/\bSQL\s*STATE\s*[:=]?\s*([A-Z0-9]{5})\b/gi;
  const BIND=/^\s*(?:==>\s*)?(?:Parameters|Bind(?:ing)?\s*(?:values?|parameters?))\s*[:=]\s*(.+)$/i;
  const FIELD=/\b([A-Za-z][A-Za-z0-9_.-]{1,55})\s*[:=]\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,;|}\]]{1,300})/g;
  const SENSITIVE=/(?:pass(?:word|wd)?|secret|token|auth(?:orization)?|api[_-]?key|credential|private[_-]?key|session|cookie|resident|jumin|ssn|(?:^|[_-])pin(?:$|[_-]))/i;
  const NOISE=new Set(['at','caused','by','java','jdbc','exception','error','sql','state','select','update','insert','delete','where','from','and','or','set','values','info','warn','warning','debug','trace','level','time','thread']);
  function mask(key,value) {return SENSITIVE.test(key)?'•••• (민감정보 마스킹)':String(value).slice(0,1400);}
  function splitBindings(text){
    // MyBatis Parameters: val(String), 42(Integer). Respect quoted commas.
    const parts=[];let quote='',escape=false,depth=0,start=0;
    for(let i=0;i<text.length;i++){
      const c=text[i];if(escape){escape=false;continue;}if(quote){if(c==='\\')escape=true;else if(c===quote)quote='';continue;}
      if(c==='"'||c==="'"){quote=c;continue;}if(c==='(')depth++;else if(c===')')depth=Math.max(0,depth-1);
      else if(c===','&&depth===0){parts.push(text.slice(start,i).trim());start=i+1;}
    }
    parts.push(text.slice(start).trim());return parts.filter(Boolean).slice(0,40);
  }
  function diagnose(raw,firstLine=1,level='error'){
    const lines=String(raw||'').split(/\r?\n/),evidence=[],unique=new Set(),causes=[],frames=[];
    const exceptions=[],sqlCodes=[],sqlStates=[],codeSeen=new Set(),stateSeen=new Set();
    let rootCause=null,sqlCause=null;
    const add=(kind,name,value,index)=>{
      value=String(value||'').trim();if(!value||evidence.length>=80)return;
      const key=kind+'\0'+name+'\0'+value+'\0'+index;if(unique.has(key))return;
      unique.add(key);evidence.push({kind,name,value:mask(name,value),line:firstLine+index});
    };
    let rootIndex=-1,firstException=-1,firstCode=-1;
    for(let i=0;i<lines.length;i++){
      const line=lines[i];
      if(/^\s*(?:Caused by|Suppressed)\s*:/.test(line)){
        causes.push({line:firstLine+i,message:line.trim()});
        if(/^\s*Caused by\s*:/.test(line))rootIndex=i;
      }
      if(firstException<0 && EXCEPTION.test(line))firstException=i;
      const em=EXCEPTION_LINE.exec(line);
      if(em && exceptions.length<32)exceptions.push({type:em[2],role:em[1]||(/^\s*#{3}\s*Cause\s*:/i.test(line)?'SQL cause':'exception'),line:firstLine+i});
      if(/^\s*Caused by\s*:/.test(line))rootCause={message:line.trim(),line:firstLine+i};
      else if(!sqlCause && /^\s*#{3}\s*Cause\s*:/i.test(line))sqlCause={message:line.trim(),line:firstLine+i};
      for(const m of line.matchAll(DB_CODE_ALL)){
        const code=m[0].toUpperCase();
        if(!codeSeen.has(code)&&sqlCodes.length<32){codeSeen.add(code);sqlCodes.push({code,line:firstLine+i});}
      }
      for(const m of line.matchAll(SQL_STATE_ALL)){
        const code=m[1].toUpperCase();
        if(!stateSeen.has(code)&&sqlStates.length<32){stateSeen.add(code);sqlStates.push({code,line:firstLine+i});}
      }
      if(firstCode<0 && ERROR_CODE.test(line))firstCode=i;
      const fm=FRAME.exec(line);
      if(fm)frames.push({method:fm[1],source:fm[2],sourceLine:Number(fm[3]),logLine:firstLine+i,at:i});
      const oracle=ORACLE_SQL.exec(line);
      if(oracle)add('sql','SQL',oracle[1],i);
      const sm=SQL.exec(line);
      if(sm && (/\b(?:SELECT|INSERT|UPDATE|DELETE|MERGE|WITH|CALL|BEGIN|CREATE|ALTER|DROP)\b/i.test(sm[1]) || /^SQL\s*[:=]/i.test(line)))add('sql','SQL',sm[1],i);
      const bm=BIND.exec(line);
      if(bm){
        const val=bm[1];
        if(/\b[A-Za-z][\w.-]*\s*[:=]/.test(val)){
          FIELD.lastIndex=0;for(const m of val.matchAll(FIELD))add('bind',m[1],m[2],i);
        }else for(const [k,v] of splitBindings(val).entries())add('bind','bind['+(k+1)+']',v,i);
      }
      // Named inputs from the same event. Do not infer database values that were not logged.
      if(!fm && !/^\s*(?:(?:Caused by|Suppressed)\b|#{3}\s*Cause\s*:|SQL\s*STATE\s*[:=])/i.test(line) && !sm && !oracle){
        const fieldLine=line.replace(/^\s*(?:Payload|Data|Request|Params?|Context|Input)\s*[:=]\s*(?=[\w.-]+\s*[:=])/i,'');
        FIELD.lastIndex=0;
        for(const m of fieldLine.matchAll(FIELD)){
          if(NOISE.has(m[1].toLowerCase()) || m[1].length>55)continue;
          if (/^(?:https?:|file:)/i.test(m[2]))continue;
          add('field',m[1],m[2],i);
        }
      }
    }
    let position=null;
    if(rootIndex>=0){const f=frames.find(x=>x.at>rootIndex);if(f)position=f;}
    if(!position && frames.length)position=frames[0];
    let focusLine=position?.logLine ?? (rootIndex>=0?firstLine+rootIndex:firstCode>=0?firstLine+firstCode:firstException>=0?firstLine+firstException:firstLine);
    const location=position?{logLine:focusLine,source:position.source,sourceLine:position.sourceLine,method:position.method,kind:'stack'}:{logLine:focusLine,source:'',sourceLine:null,method:'',kind:'log'};
    return {location,causes,frames:frames.slice(0,32),exceptions,sqlCodes,sqlStates,rootCause:rootCause||sqlCause,evidence,focusLine,hasData:evidence.length>0,mode:level};
  }
  const api={diagnose,splitBindings,mask};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  root.JeusDiagnostics=api;
})(typeof self!=='undefined'?self:globalThis);
