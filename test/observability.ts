import assert from "node:assert/strict";
import { summaryCompleter, resolveSummaryModel } from "../extension/summary-model.ts";
const model:any={provider:"fake",id:"offline",api:"openai-responses",contextWindow:200000,maxTokens:8192};
const selected=resolveSummaryModel({model,modelRegistry:{} as any});
let settled=false;
let lastSignal:AbortSignal;
const registry:any={streamSimple(_model:any,_input:any,options:any){
  lastSignal=options.signal;settled=false;
  const message={role:"assistant",provider:"fake",model:"offline",api:"openai-responses",timestamp:Date.now(),
    content:[{type:"text",text:"reply"}],stopReason:"stop",usage:{cost:{total:.01}}};
  let finish!:(value:any)=>void;
  const done=new Promise(resolve=>{finish=resolve});
  options.signal.addEventListener("abort",()=>{setTimeout(()=>{settled=true;finish({...message,stopReason:"aborted"})},5)},{once:true});
  return {async *[Symbol.asyncIterator](){
    yield {type:"thinking_delta",delta:"visible thought"};yield {type:"text_delta",delta:"reply"};
    settled=true;finish(message);
  },result:()=>done};
}};
const events:any[]=[];let cost=0;
const result=await summaryCompleter(registry,selected,undefined,event=>events.push(event),usage=>cost+=usage.cost.total)("SYSTEM","INPUT");
assert.equal(result.text,"reply");assert.deepEqual(events.map(e=>e.type),["start","delta","delta","end"]);
assert.equal(events[0].systemPrompt,"SYSTEM");assert.equal(events[0].messages[0].content,"INPUT");
assert.equal(events[1].channel,"thinking");assert.equal(events[2].channel,"text");assert.equal(events[3].message.role,"assistant");assert.equal(cost,.01);
cost=0;
await assert.rejects(summaryCompleter(registry,selected,undefined,event=>{
  if(event.type==="delta")throw new Error("transcript unavailable");
},usage=>cost+=usage.cost.total)("SYSTEM","INPUT"),/transcript unavailable/);
assert.equal(lastSignal!.aborted,true);assert.equal(settled,true);assert.equal(cost,.01);
console.log("observability tests passed (native messages, streaming, tracing failure abort/settle/accounting)");
