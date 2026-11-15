import fs from "node:fs";
const port = process.argv[2] || "9253";
const deadline = Date.now() + 30000; let target;
while (Date.now() < deadline) {
  try { const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json()); target = targets.find(x => x.type === "page" && x.url.includes("yuque.com")); if (target) break; } catch {}
  await new Promise(r => setTimeout(r, 300));
}
if (!target) throw new Error("未找到语雀页面");
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((ok, bad) => { ws.addEventListener("open", ok, {once:true}); ws.addEventListener("error", bad, {once:true}); });
let id=0; const pending=new Map(); ws.addEventListener("message", e => { const m=JSON.parse(e.data); pending.get(m.id)?.(m); pending.delete(m.id); });
const call=(method,params={})=>new Promise(ok=>{const n=++id;pending.set(n,ok);ws.send(JSON.stringify({id:n,method,params}));});
await call("Runtime.enable"); await new Promise(r=>setTimeout(r,5000));
const source=fs.readFileSync(new URL("../../apps/browser-extension/extractor.js", import.meta.url),"utf8");
const expression=`${source}\n(() => { const data=new ReadBridgeUniversalContentExtractor(document,{maxLength:20000,maxBlocks:100}).extract(); const types={}; for(const b of data?.content_blocks||[]) types[b.type]=(types[b.type]||0)+1; const heading=[...document.querySelectorAll('h1,h2,h3,[role=heading]')].find(x=>x.textContent.includes('ESP32可编程RTU')); const ancestors=[]; for(let n=heading;n&&ancestors.length<7;n=n.parentElement) ancestors.push({tag:n.tagName,id:n.id||'',class:typeof n.className==='string'?n.className.slice(0,160):'',role:n.getAttribute?.('role')||''}); const selectorStats=['.lake-engine','.lake-content','.ne-viewer-body','.ne-renderer','.ne-doc-major','.ne-typography','.doc-reader','.yuque-doc-content','#doc-reader-content'].map(s=>{const n=document.querySelector(s);return {selector:s,found:!!n,len:n?.textContent?.length||0,class:typeof n?.className==='string'?n.className.slice(0,160):''}}); const root=document.querySelector('.ne-viewer-body'); const classCounts={}; root?.querySelectorAll('[class]').forEach(n=>{const c=typeof n.className==='string'?n.className:''; if(c && n.textContent.trim().length>5) classCounts[c]=(classCounts[c]||0)+1}); const commonClasses=Object.entries(classCounts).sort((a,b)=>b[1]-a[1]).slice(0,20); const direct=[...(root?.children||[])].slice(0,30).map(n=>({tag:n.tagName,class:typeof n.className==='string'?n.className.slice(0,120):'',len:n.textContent.length,text:n.textContent.trim().slice(0,60)})); return {title:data?.title,strategy:data?.strategy,textLength:data?.text?.length||0,blockCount:data?.content_blocks?.length||0,blockTypes:types,truncated:data?.truncated,duplicateCount:data?.metrics?.duplicateCount||0,extractMs:data?.metrics?.extractMs||0,textHash:data?.text ? String(data.text.length)+'-'+data.text.charCodeAt(0) : '',containsV1V2:data?.text?.includes('V1和V2')||false,containsTypeC:/type.?c/i.test(data?.text||''),containsNavigation:/HaaS506-WIKI|首页\s*目录\s*搜索/.test(data?.text||''),headings:document.querySelectorAll('h1,h2,h3,h4').length,ancestors,selectorStats,commonClasses,direct,sample:(data?.content_blocks||[]).slice(0,8).map(b=>({id:b.id,type:b.type,text:b.text.slice(0,80)}))}; })()`;
const result=await call("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true}); ws.close();
if(result.result?.exceptionDetails) throw new Error(result.result.exceptionDetails.text);
console.log(JSON.stringify(result.result?.result?.value,null,2));
