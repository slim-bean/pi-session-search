import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { SessionIndex } from '../extension/indexer.ts';
import { registerSummaryMaintenance } from '../extension/maintenance.ts';
import { loadConversation } from '../extension/summarizer.ts';
import { fingerprint } from '../extension/session-file.ts';
const dir=mkdtempSync(join(tmpdir(),'summary-maintenance-'));
const previous=process.env.PI_CODING_AGENT_DIR;
// Reproduce a configured-root alias vs maintenance's canonical ownership path
// on every platform, not only macOS's /var -> /private/var alias.
const alias=join(dir,'agent-alias');symlinkSync(dir,alias,'dir');
process.env.PI_CODING_AGENT_DIR=alias;
const root=join(dir,'sessions','fixture');mkdirSync(root,{recursive:true});
const path=join(root,'session.jsonl');
writeFileSync(path,[{type:'session',id:'fixture',cwd:dir},
 {type:'message',id:'a',parentId:null,message:{role:'user',content:'main question'}},
 {type:'message',id:'b',parentId:'a',message:{role:'assistant',content:[{type:'text',text:'main branch'}]}},
 {type:'message',id:'c',parentId:'a',message:{role:'assistant',content:[{type:'text',text:'valuable sidequest'}]}},
].map(e=>JSON.stringify(e)).join('\n')+'\n');
const index=new SessionIndex(join(dir,'index.db'));
const bus=new EventEmitter();const hooks=new Map<string,Function>();let calls=0;let spend=0;
const modelEvents:any[]=[];
const pi:any={events:{on:(c:string,h:Function)=>bus.on(c,h as any)},on:(c:string,h:Function)=>hooks.set(c,h)};
const model:any={provider:'fake',id:'offline',contextWindow:200000,maxTokens:8192};
const ctx:any={model,modelRegistry:{find:()=>model,hasConfiguredAuth:()=>true,streamSimple(_m:any,input:any){
 calls++;assert.match(input.messages[0].content,/valuable sidequest/);
 const response={role:'assistant',provider:'fake',model:'offline',api:'openai-responses',timestamp:Date.now(),stopReason:'stop',content:[{type:'text',text:JSON.stringify({overview:'all branches',topics:[{title:'Sidequest',summary:'useful',keywords:[],entries:[3]}]})}],usage:{cost:{total:.01}}};
 return {async *[Symbol.asyncIterator](){yield {type:'text_delta',delta:response.content[0].text};},result:async()=>response};
}}};
const adapter=registerSummaryMaintenance(pi,()=>index);
try {
 const request:any={protocol:1,operation:'status',context:ctx,path:realpathSync(path),sourceHash:fingerprint(loadConversation(path))};
 bus.emit('pi-session-search:maintenance:v1',request);const status=await request.result;
 assert.equal(status.complete,false);assert.equal(calls,0);
 const indexedPath=join(alias,'sessions','fixture','session.jsonl');
 assert.ok(index.db.prepare('SELECT 1 FROM sessions WHERE path = ?').get(indexedPath));
 assert.equal(index.db.prepare('SELECT 1 FROM sessions WHERE path = ?').get(realpathSync(path)),undefined);
 request.operation='run';request.onUsage=(u:any)=>spend+=u.cost.total;request.onModelEvent=(event:any)=>modelEvents.push(event);
 bus.emit('pi-session-search:maintenance:v1',request);const outcome=await request.result;
 assert.equal(outcome.complete,true);assert.equal(calls,1);assert.equal(spend,.01);
 assert.deepEqual(modelEvents.map(e=>e.type),['start','delta','end']);
 assert.match(modelEvents[0].messages[0].content,/valuable sidequest/);
 assert.equal(modelEvents[2].message.role,'assistant');
 assert.equal(modelEvents[1].channel,'text');
 bus.emit('pi-session-search:maintenance:v1',request);await request.result;assert.equal(calls,1);
 request.sourceHash='wrong';bus.emit('pi-session-search:maintenance:v1',request);
 await assert.rejects(request.result,/source changed/);
 const outside=join(dir,'outside.jsonl');writeFileSync(outside,JSON.stringify({type:'session',id:'outside',cwd:dir})+'\n');
 request.path=outside;request.operation='status';bus.emit('pi-session-search:maintenance:v1',request);
 await assert.rejects(request.result,/Search scans .*retrying alone cannot index/s);
 assert.equal(calls,1);
 console.log('maintenance adapter tests passed (all branches, cache reuse, freshness, cost, no implicit calls)');
} finally {
 await adapter.stop();await index.dispose();
 if(previous===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previous;
 rmSync(dir,{recursive:true,force:true});
}
