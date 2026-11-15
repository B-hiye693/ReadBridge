import fs from "node:fs";
import crypto from "node:crypto";
const port=process.argv[2]||"9253", api=process.argv[3]||"http://127.0.0.1:8000";
const targets=await fetch(`http://127.0.0.1:${port}/json/list`).then(r=>r.json());
const target=targets.find(x=>x.type==="page"&&x.url.includes("yuque.com")); if(!target) throw new Error("未找到语雀页面");
const ws=new WebSocket(target.webSocketDebuggerUrl); await new Promise((ok,bad)=>{ws.addEventListener("open",ok,{once:true});ws.addEventListener("error",bad,{once:true});});
let seq=0;const waits=new Map();ws.addEventListener("message",e=>{const m=JSON.parse(e.data);waits.get(m.id)?.(m);waits.delete(m.id)});
const call=(method,params={})=>new Promise(ok=>{const id=++seq;waits.set(id,ok);ws.send(JSON.stringify({id,method,params}))});
await call("Runtime.enable");const source=fs.readFileSync(new URL("../../apps/browser-extension/extractor.js",import.meta.url),"utf8");
const evaluated=await call("Runtime.evaluate",{expression:`${source}\nnew ReadBridgeUniversalContentExtractor(document,{maxLength:20000,maxBlocks:100}).extract()`,returnByValue:true});ws.close();
const article=evaluated.result?.result?.value;if(!article?.text) throw new Error("语雀正文提取失败");
const requestId=crypto.randomUUID();const started=performance.now();
const response=await fetch(`${api}/api/easy-read`,{method:"POST",headers:{"Content-Type":"application/json","X-Request-ID":requestId},body:JSON.stringify(article)});
const result=await response.json();const types={};for(const b of article.content_blocks||[])types[b.type]=(types[b.type]||0)+1;
console.log(JSON.stringify({requestId,status:response.status,elapsedMs:Math.round(performance.now()-started),title:article.title,strategy:article.strategy,
  textLength:article.text.length,blockCount:article.content_blocks?.length||0,blockTypes:types,truncated:article.truncated,
  textHash:crypto.createHash("sha256").update(article.text).digest("hex").slice(0,12),
  cache:response.headers.get("X-ReadBridge-Cache"),success:Boolean(result.success),error:result.error||null,
  output:result.data?{sections:result.data.sections?.length||0,keyPoints:result.data.key_points?.length||0,difficultWords:result.data.difficult_words?.length||0}:null},null,2));
