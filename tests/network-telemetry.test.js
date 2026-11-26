import test from 'node:test';
import assert from 'node:assert/strict';
import {AccountCoordinator} from '../worker/index.js';
import {NetworkTelemetry,TELEMETRY_LIMIT,FIRST_DELAY,FLUSH_INTERVAL,RETENTION_MS,classifyRequest,readClientSamples} from '../worker/network-telemetry.js';
import {sanitizeBackupSample} from '../src/network-telemetry.js';
const metaKey='network-telemetry:v1:meta';
function store(){const rows=new Map();let alarm=null;return {rows,get:async k=>structuredClone(rows.get(k)),put:async(k,v)=>{if(typeof k==='string')rows.set(k,structuredClone(v));else for(const [key,val] of Object.entries(k))rows.set(key,structuredClone(val));},delete:async k=>{for(const key of Array.isArray(k)?k:[k])rows.delete(key);},list:async({prefix})=>new Map([...rows].filter(([k])=>k.startsWith(prefix)).map(([k,v])=>[k,structuredClone(v)])),getAlarm:async()=>alarm,setAlarm:async at=>{alarm=at;},deleteAlarm:async()=>{alarm=null;},fire:()=>{alarm=null;}};}
function driveMock(){const files=new Map(),calls=[];let lost=false;return {files,calls,loseNextAck(){lost=true;},root:async()=>{calls.push('root');return 'root';},folder:async(parent,name)=>{assert.equal(name,'telemetry');calls.push('folder');return 'telemetry';},list:async(folder,name)=>{assert.equal(folder,'telemetry');calls.push('list');return [...files].filter(([k])=>!name||k===name).map(([name])=>({id:name,name}));},content:async id=>{calls.push('read');return files.get(id);},createJSON:async(folder,name,text)=>{assert.equal(folder,'telemetry');calls.push('create');assert(!files.has(name));files.set(name,text);if(lost){lost=false;throw Error('lost response');}return {id:name};},remove:async id=>{calls.push('remove');files.delete(id);}};}
const sample=(n=0)=>({kind:'request',app:'ciyan',operation:'commit',at:new Date().toISOString(),status:200,serviceMs:n});
const backupSample=()=>({app:'ciyan',eventId:crypto.randomUUID(),at:new Date().toISOString(),status:'committed',commitMs:1000,payloadBytes:28,profileId:'sensitive',profileName:'sensitive',rawText:'secret',url:'/profiles/secret'});
test('classification and client sanitization never include raw paths, profile IDs, hashes, text or arbitrary fields',()=>{
 assert.deepEqual(classifyRequest('POST','/profiles/secret-profile/apps/ciyan/commit'),{app:'ciyan',operation:'commit'});
 assert.deepEqual(classifyRequest('PUT','/objects/'+'a'.repeat(64),'secret-profile'),{app:'other',operation:'object_write'});
 assert.equal(classifyRequest('POST','/revoke'),null);
 const value=sanitizeBackupSample(backupSample());assert.equal(value.commitMs,1000);assert.equal(value.payloadBytes,28);assert(!JSON.stringify(value).includes('secret'));assert(!JSON.stringify(value).includes('sensitive'));
 const wire=JSON.stringify({scope:'old',samples:[backupSample()]});assert.equal(readClientSamples(wire,'new'),null);assert.equal(readClientSamples('x'.repeat(4097),'old'),null);assert.equal(readClientSamples(wire,'old').length,1);
});
test('journal bounds storage and reports overflow; no Drive calls until alarm; persisted rows survive coordinator restart',async()=>{
 const s=store(),drive=driveMock(),now=Date.now(),journal=new NetworkTelemetry(s);await s.put('refresh','encrypted');
 for(let i=0;i<TELEMETRY_LIMIT+11;i++)await journal.append([sample(i)],now);
 assert.equal(drive.calls.length,0);assert.equal(await s.getAlarm(),now+FIRST_DELAY);assert.equal((await s.list({prefix:'network-telemetry:v1:pending:'})).size,TELEMETRY_LIMIT);
 s.fire();await new NetworkTelemetry(s).flush(drive,now+FIRST_DELAY);assert.equal(drive.files.size,1);const batch=JSON.parse([...drive.files.values()][0]);assert.equal(batch.events.length,TELEMETRY_LIMIT);assert.equal(batch.droppedEvents,11);assert.equal(batch.events[0].serviceMs,11);assert.equal(await s.getAlarm(),null);
 const next=new NetworkTelemetry(s);await next.append([sample(77)],now+FIRST_DELAY+1);assert.equal(await s.getAlarm(),now+FIRST_DELAY+FLUSH_INTERVAL);
});
test('lost telemetry write acknowledgement retries same frozen payload; new samples are separate',async()=>{
 const s=store(),drive=driveMock(),now=Date.now(),j=new NetworkTelemetry(s);await s.put('refresh','encrypted');await j.append([sample(1)],now);drive.loseNextAck();s.fire();await j.flush(drive,now+FIRST_DELAY);const original=[...drive.files.entries()][0];assert.equal((await s.get(metaKey)).staged.count,1);await j.append([sample(2)],now+FIRST_DELAY+1);
 s.fire();await new NetworkTelemetry(s).flush(drive,now+FIRST_DELAY+FLUSH_INTERVAL);assert.equal(drive.files.size,1);assert.deepEqual([...drive.files.entries()][0],original);assert.equal(drive.calls.filter(c=>c==='create').length,1);
 s.fire();await new NetworkTelemetry(s).flush(drive,now+FIRST_DELAY+2*FLUSH_INTERVAL);assert.equal(drive.files.size,2);assert.deepEqual([...drive.files.values()].map(x=>JSON.parse(x).events[0].serviceMs),[1,2]);
});
test('retention only touches owned old telemetry files, never backup files; revocation drops pending telemetry',async()=>{
 const s=store(),d=driveMock(),now=Date.now(),j=new NetworkTelemetry(s);await s.put('refresh','encrypted');
 const old=`network-v1-${new Date(now-RETENTION_MS-2*86400000).toISOString().slice(0,10)}-${crypto.randomUUID()}.json`;
 d.files.set(old,'{}');d.files.set('head.json','{}');d.files.set('my-notes.json','{}');await j.append([sample()],now);s.fire();await j.flush(d,now+FIRST_DELAY);assert(!d.files.has(old));assert(d.files.has('head.json'));assert(d.files.has('my-notes.json'));
 await j.append([sample()],now+FIRST_DELAY+1);await s.delete('refresh');s.fire();await j.flush(d,now+FIRST_DELAY+FLUSH_INTERVAL);assert.equal((await s.list({prefix:'network-telemetry:v1:'})).size,0);assert.equal(d.files.size,3);
});
test('authenticated route records status and metrics with no Drive telemetry write; storage failure is fail-open',async()=>{
 const s=store();await s.put('session:safe-session',{exp:Date.now()+60000});await s.put('refresh','encrypted');
 const c=new AccountCoordinator({storage:s},{});c.route=async()=>{c.bump('driveCalls',2);return Response.json({head:'actual-private-content'});};
 const call=(path,method='GET',telemetry=null,sid='safe-session')=>c.fetch(new Request('https://internal/api',{method:'POST',body:JSON.stringify({sid,path,method,body:method==='POST'?'{"private":"body"}':null,telemetry,telemetryApp:'ciyan'})}));
 const initial=await call('/status'),scope=initial.headers.get('X-PWA-Telemetry-Scope');assert.match(scope,/^[a-f0-9]{64}$/);
 const reply=await call('/profiles/private-profile/apps/ciyan/commit','POST',JSON.stringify({scope,samples:[backupSample()]}));assert.equal(reply.status,200);assert.equal(reply.headers.get('X-PWA-Telemetry-Ack'),'1');assert.equal(reply.headers.get('X-PWA-driveCalls'),'2');assert.deepEqual(await reply.json(),{head:'actual-private-content'});
 const rows=[...(await s.list({prefix:'network-telemetry:v1:pending:'})).values()];assert.equal(rows.length,0);const totals=Object.values(await s.get('workspace-regular-usage'))[0];assert.equal(totals.requests,1);assert.equal(totals.backupCount,1);assert.equal(totals.driveCalls,2);assert(!JSON.stringify(totals).includes('private'));assert(!JSON.stringify(totals).includes(scope));
 const wrong=await call('/status','GET',JSON.stringify({scope:'different',samples:[backupSample()]}));assert.equal(wrong.headers.get('X-PWA-Telemetry-Ack'),null);
 const unauth=await call('/profiles','GET',null,'bad-session');assert.equal(unauth.status,401);assert.equal((await s.list({prefix:'network-telemetry:v1:pending:'})).size,0);
 s.put=async()=>{throw Error('telemetry storage failed');};const still=await call('/profiles/private-profile/apps/ciyan/commit','POST');assert.equal(still.status,200);assert.deepEqual(await still.json(),{head:'actual-private-content'});
});
test('browser piggybacks on a subsequent request, retains until receipt, survives reload and discards other session',async()=>{
 const original=globalThis.sessionStorage,m=new Map();globalThis.sessionStorage={getItem:k=>m.get(k)||null,setItem:(k,v)=>m.set(k,v),removeItem:k=>m.delete(k)};
 try{const a=await import('../src/network-telemetry.js?client-a'),response=(scope,ack=false)=>new Response(null,{headers:{'X-PWA-Telemetry-Scope':scope,...(ack?{'X-PWA-Telemetry-Ack':'1'}:{})}});
  a.beginTelemetry().finish(response('a'));a.queueBackupTelemetry('ciyan',backupSample());const first=a.beginTelemetry('ciyan');assert.equal(JSON.parse(first.headers['X-PWA-Telemetry']).samples.length,1);first.finish(undefined);
  const reloaded=await import('../src/network-telemetry.js?client-b');assert.equal(reloaded.beginTelemetry().headers['X-PWA-Telemetry'],undefined);reloaded.beginTelemetry().finish(response('a'));const retry=reloaded.beginTelemetry();assert.equal(JSON.parse(retry.headers['X-PWA-Telemetry']).samples.length,1);retry.finish(response('a',true));assert.equal(reloaded.beginTelemetry().headers['X-PWA-Telemetry'],undefined);
  reloaded.queueBackupTelemetry('ciyan',backupSample());reloaded.beginTelemetry().finish(response('b'));assert.equal(reloaded.beginTelemetry().headers['X-PWA-Telemetry'],undefined);assert.equal(m.size,0);
 }finally{if(original===undefined)delete globalThis.sessionStorage;else globalThis.sessionStorage=original;}
});

test('persistent Drive failures stop idle retry alarms after three attempts; new traffic can resume',async()=>{
 const s=store(),d=driveMock(),now=Date.now(),j=new NetworkTelemetry(s);await s.put('refresh','encrypted');await j.append([sample()],now);d.root=async()=>{throw Error('quota');};
 for(let i=0;i<3;i++){s.fire();await j.flush(d,now+FIRST_DELAY+i*FLUSH_INTERVAL);}
 assert.equal(await s.getAlarm(),null);assert.equal((await s.get(metaKey)).failures,3);assert.equal((await s.get(metaKey)).staged.count,1);
 await j.append([sample(2)],now+FIRST_DELAY+2*FLUSH_INTERVAL+1);assert.equal(await s.getAlarm(),now+FIRST_DELAY+3*FLUSH_INTERVAL);
});

test('R8.1 regular usage is compact, backed up under one owned file and verified',async()=>{const s=store();await s.put('refresh','encrypted');const c=new AccountCoordinator({storage:s},{}),files=new Map();Object.assign(c,{root:async()=> 'root',folder:async()=> 'telemetry',list:async()=>[...files.values()],content:async id=>files.get(id).text,createJSON:async(parent,name,text,metadata)=>{const f={id:'owned',name,text,...metadata};files.set(f.id,f);return f;},replaceJSON:async(id,text)=>files.get(id).text=text});await c.recordRegularUsage([{kind:'request',driveCalls:2,requestChars:10,responseChars:4},{kind:'backup'}]);await s.put('workspace-regular-due',Date.now()-1);await c.flushRegularUsage();assert.equal(files.size,1);assert.equal((await s.get('workspace-regular-due')),undefined);let value=JSON.parse(files.get('owned').text);assert.equal(Object.values(value.days)[0].driveCalls,2);assert.equal(Object.values(value.days)[0].backupCount,1);await c.recordRegularUsage([{kind:'request',driveCalls:3}]);await s.put('workspace-regular-due',Date.now()-1);await c.flushRegularUsage();value=JSON.parse(files.get('owned').text);assert.equal(Object.values(value.days)[0].driveCalls,5);assert.equal(files.size,1);assert(!JSON.stringify(value).includes('events'));});
test('R10 regular usage backup exposes verification failure and clears it after successful retry',async()=>{const s=store(),c=new AccountCoordinator({storage:s},{});await s.put('refresh','encrypted');let text;Object.assign(c,{root:async()=> 'root',folder:async()=> 'telemetry',list:async()=>text?[{id:'owned',appProperties:{pwaTelemetry:'regular-v1'}}]:[],content:async()=>text,createJSON:async(parent,name,value)=>{text=value;return{id:'owned'};}});await c.recordRegularUsage([{kind:'request',driveCalls:3}]);const content=c.content;c.content=async()=> 'corrupt';await s.put('workspace-regular-due',Date.now()-1);await c.flushRegularUsage();assert.equal(await s.get('workspace-regular-backup-error'),'verification-unavailable');assert.equal(await s.get('workspace-regular-last-backup'),undefined);assert.ok((await s.get('workspace-regular-due'))>Date.now());c.content=content;await s.put('workspace-regular-due',Date.now()-1);await c.flushRegularUsage();assert.equal(await s.get('workspace-regular-backup-error'),undefined);assert.ok(await s.get('workspace-regular-last-backup'));assert.equal(await s.get('workspace-regular-due'),undefined);});
test('R10 account alarm attempts regular backup even if detailed archive flush fails and rearms due usage',async()=>{const s=store(),c=new AccountCoordinator({storage:s},{NETWORK_TELEMETRY:'off'});const due=Date.now()+3600000;await s.put('refresh','encrypted');await s.put('workspace-regular-due',due);c.flushWorkspace=async()=>{throw Error('archive unavailable');};let invoked=0;const flush=c.flushRegularUsage.bind(c);c.flushRegularUsage=async()=>{invoked++;return flush();};await assert.rejects(c.alarm(),/archive unavailable/);assert.equal(invoked,1);assert.equal(await s.getAlarm(),due);});
