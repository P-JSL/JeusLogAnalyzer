/* Pure parser shared with Web Worker and Node.js regression tests. */
(function (root) {
  'use strict';
  // MES/SmartUX JEUS logs: [time][level][thread][numeric id][request id][kind][component] - message.
  const PLATFORM = /^\[(\d{4}[.\-/]\d{1,2}[.\-/]\d{1,2}[ T]\d{2}:\d{2}:\d{2}(?:[.:,]\d{3})?)\]\[([0-7]|SEVERE|WARNING|WARN|INFO|ERROR|FATAL|DEBUG|TRACE)\]\[([^\]\r\n]{1,256})\]\[(\d{1,12})\]\[([^\]\r\n]{1,160})\]\[([^\]\r\n]{1,80})\]\[([^\]\r\n]{1,160})\]\s*-\s*(.*)$/i;
  const JEUS = /^\[(\d{4}[.\-/]\d{1,2}[.\-/]\d{1,2}[ T]\d{2}:\d{2}:\d{2}(?:[.:,]\d{3})?(?:Z|[+-]\d{2}:?\d{2})?)\]\s*\[([0-7]|SEVERE|WARNING|WARN|INFO|CONFIG|FINE|FINER|FINEST|ALL|ERROR|FATAL|DEBUG|TRACE)\]\s*(?:\[([^\]\r\n]*)\])?\s*(?:\[([A-Za-z][\w.-]*-\d+)\])?\s*(.*)$/i;
  const DATED = /^\[?(\d{4}[.\-/]\d{1,2}[.\-/]\d{1,2}[ T]\d{2}:\d{2}:\d{2}(?:[.:,]\d{3})?(?:Z|[+-]\d{2}:?\d{2})?)\]?\s*[-|:]?\s*(?:\[?(SEVERE|ERROR|FATAL|WARN(?:ING)?|INFO|DEBUG|TRACE|CONFIG|FINE(?:R|ST)?|ALL)\]?)?\s*(.*)$/i;
  const LEVEL_LINE = /^\s*\[(ERROR|SEVERE|FATAL|WARN(?:ING)?|INFO|DEBUG|TRACE)\]\s*(.*)$/i;
  const EXCEPTION = /(?:^|\s|:)(?:[a-zA-Z_$][\w$]*\.)*[A-Za-z_$][\w$]*(?:Exception|Error)(?=\s|:|$|\()/;
  const STACK = /^\s*(?:at\s+(?:[\w.$<>/]+)\([^)]*\)|Caused by\s*:|Suppressed\s*:|\.\.\.\s+\d+\s+more\b|<<__Exception__>>|\[STDERR\])|^\s*(?:Exception in thread|Traceback \(most recent call last\))/i;
  const MESSAGE_CODE = /\b([A-Za-z][\w.-]*-\d{3,})\b/;
  const SEVERITIES = { '0':'error','1':'warning','2':'info','3':'info','4':'info','5':'info','6':'info','7':'info', severe:'error',error:'error',fatal:'error',warning:'warning',warn:'warning',info:'info',config:'info',fine:'info',finer:'info',finest:'info',all:'info',debug:'info',trace:'info' };
  function clean(s){return String(s ?? '').replace(/\r$/, '');}
  function hasFailure(text){return EXCEPTION.test(text) || /^\s*(?:Caused by\s*:|<<__Exception__>>|Exception in thread\b)/im.test(text);}
  function header(line){
    const s=clean(line); let m=PLATFORM.exec(s);
    if(m){return {time:m[1],level:SEVERITIES[m[2].toLowerCase()],source:m[2],thread:m[3],sequence:m[4],contextId:m[5],kind:m[6],component:m[7],code:'',message:m[8],isHeader:true};}
    m=JEUS.exec(s);
    if(m){return {time:m[1],level:SEVERITIES[m[2].toLowerCase()],source:m[2],thread:m[3]||'',code:m[4]||'',message:m[5]||'',isHeader:true};}
    m=DATED.exec(s);
    if(m){return {time:m[1],level:m[2]?SEVERITIES[m[2].toLowerCase()]:null,source:m[2]||'',thread:'',code:'',message:m[3]||'',isHeader:true};}
    m=LEVEL_LINE.exec(s);
    if(m){return {time:'',level:SEVERITIES[m[1].toLowerCase()],source:m[1],thread:'',code:'',message:m[2]||'',isHeader:true};}
    return null;
  }
  function labelLevel(level){return level==='error'?'오류':level==='warning'?'경고':'일반';}
  function determineLevel(head, raw){
    if(head && head.level) return head.level; // JEUS explicit level is authoritative.
    if(hasFailure(raw)) return 'error';
    if(/(?:^|[\s:[(])(?:ERROR|FATAL|SEVERE)(?:\b|\])/i.test(raw.slice(0,250))) return 'error';
    if(/(?:^|[\s:[(])(?:WARN|WARNING)(?:\b|\])/i.test(raw.slice(0,250))) return 'warning';
    return 'info';
  }
  function signature(event){
    const errorClass=String(event.raw).match(/(?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*(?:Exception|Error)\b/);
    if(errorClass) return errorClass[0].split('.').pop();
    if(event.code) return event.code;
    return (event.message||'분류되지 않은 오류').replace(/\b\d+\b/g,'#').slice(0,90);
  }
  class Parser {
    constructor(onEntry){this.onEntry=onEntry;this.line=0;this.current=null;this.ended=false;}
    ingest(text){if(this.ended)throw Error('parser finalized');this.line++; const s=clean(text); const h=header(s);
      if(h){this.flush(this.line-1);this.current={head:h,firstLine:this.line,lines:[s],chars:s.length,truncated:false};return;}
      if(!this.current){if(!s.trim())return;this.current={head:null,firstLine:this.line,lines:[s],chars:s.length,truncated:false};return;}
      // Undated plain-text logs: treat non-indented lines as separate events.
      if(!this.current.head && s.trim() && !/^\s/.test(s) && !STACK.test(s)){
         this.flush(this.line-1);this.current={head:null,firstLine:this.line,lines:[s],chars:s.length,truncated:false};return;
      }
      // Cap an individual event to avoid uncontrolled memory from malformed files.
      if(this.current.chars+s.length<65536 && this.current.lines.length<1000){this.current.lines.push(s);this.current.chars+=s.length+1;}
      else {this.current.truncated=true;}
    }
    flush(endLine=this.line){if(!this.current)return;const a=this.current;this.current=null;
      const raw=a.lines.join('\n')+(a.truncated?'\n[이벤트가 너무 길어 이후 부분 생략]':'');
      const h=a.head;const m=h?h.message:a.lines[0];
      const level=determineLevel(h,raw);
      const code=(h&&h.code)||((raw.match(MESSAGE_CODE)||[])[1]||'');
      const event={id:a.firstLine,time:h?h.time:'',level,code,thread:h?h.thread:'',contextId:h?.contextId||'',component:h?.component||'',message:(m||'').trim()||a.lines[0].trim(),line:a.firstLine,endLine,raw};
      event.group=level==='error'?signature(event):'';
      this.onEntry(event);
    }
    finish(){if(!this.ended){this.flush();this.ended=true;}}
  }
  const api={Parser,header,determineLevel,hasFailure,signature,labelLevel};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  root.JeusParser=api;
})(typeof self!=='undefined'?self:globalThis);
