// Counts/shapes only; never prints content.
import { createReadStream, readdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path"; import { homedir } from "node:os";
const files=[]; const walk=(d)=>{for(const e of readdirSync(d,{withFileTypes:true})){const p=join(d,e.name); e.isDirectory()?walk(p):e.name.endsWith(".jsonl")&&files.push(p)}};
walk(join(homedir(),".codex/sessions")); try{walk(join(homedir(),".codex/archived_sessions"))}catch{}
const c={}; const inc=(k)=>c[k]=(c[k]??0)+1;
const shape=(v)=>Array.isArray(v)?"["+(v.length?shape(v[0]):"")+"]":v&&typeof v==="object"?"{"+Object.keys(v).sort().join(",")+"}":typeof v;
for(const f of files){ let sub=false;
 for await(const l of createInterface({input:createReadStream(f)})){ let d; try{d=JSON.parse(l)}catch{continue}
  const p=d.payload??{};
  if(d.type==="session_meta"&&p.source?.subagent) sub=true;
  const it=p.item;
  if(p.type==="item_completed"&&it){
   if(it.type==="UserMessage"){ for(const b of it.content) { inc("user.content:"+b.type); if(b.type==="text"){ inc("user.text.startsLT:"+/^\s*</.test(b.text)); const m=b.text.match(/^\s*<([a-z_]+)/); if(m) inc("user.tag:"+m[1]); } } inc("user.sub:"+sub); }
   if(it.type==="SubAgentActivity") inc("subagent.shape:"+shape(it));
   if(it.type==="Extension") inc("ext:"+it.kind+":"+shape(it));
   if(it.type==="CommandExecution"){ inc("cmd.argv0:"+(it.command[0]??"").split("/").pop()+" argc="+it.command.length+" "+(it.command[1]??"")); inc("cmd.status:"+it.status); inc("cmd.src:"+it.source); }
   if(it.type==="McpToolCall"){ inc("mcp.result:"+shape(it.result)); inc("mcp.status:"+it.status); if(it.result?.content) for(const b of it.result.content) inc("mcp.block:"+b.type); }
   if(it.type==="FileChange") for(const ch of Object.values(it.changes)) inc("fc:"+ch.type+" keys="+Object.keys(ch).sort().join(","));
   if(it.type==="AgentMessage") { inc("agent.phase:"+it.phase); for(const b of it.content) inc("agent.block:"+b.type); }
   if(it.type==="ImageView") inc("img:"+shape(it));
   if(it.type==="WebSearch") inc("ws.action:"+it.action?.type);
  }
  if(d.type==="compacted") inc("compacted.msg.nonempty:"+Boolean(p.message)+" rh="+Array.isArray(p.replacement_history));
  if(p.type==="thread_rolled_back") inc("rolled_back");
  if(d.type==="event_msg"&&!["item_completed","token_count","task_started","task_complete","thread_settings_applied","turn_aborted"].includes(p.type)) inc("evt:"+p.type);
 }}
for(const k of Object.keys(c).sort()) console.log(c[k],k.slice(0,200));
