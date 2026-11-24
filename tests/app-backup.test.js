import test from 'node:test';
import assert from 'node:assert/strict';
import {createAppBackupAdapter} from '../src/app-backup.js';
import {createBackupCache,createSyncScheduler,uploadBackup,downloadBackup,getSyncCursor,checksum} from '../src/sync.js';
import {AccountCoordinator} from '../worker/index.js';

// Deliberately synthetic app state: not a proposed WorldGen/Ascendant schema.
const snapshot=(n=1)=>({format:'fixture-backup',version:1,appVersion:'1.0.0',state:{reader:{name:'not a Ciyan reader'},settings:{n}}});
const fixture=(appId='fixture-a',overrides={})=>createAppBackupAdapter({appId,format:'fixture-backup',version:1,
 partition:state=>({sections:{reader:state.reader,settings:state.settings},layout:{type:'fixture'}}),
 assemble:(entries,layout)=>{assert.equal(layout.type,'fixture');return entries;},
 validate:state=>!!state&&Object.keys(state).length===2&&typeof state.reader?.name==='string'&&Number.isInteger(state.settings?.n),
 readSnapshot:async()=>({backup:snapshot(),revision:1}),restore:async()=>{},...overrides});
const revision=(split,id='r1')=>({format:1,id,operationId:`op-${id}`,parent:null,sections:split.sections,meta:split.meta,at:new Date().toISOString()});
const entries=split=>Object.fromEntries(Object.entries(split.sections).map(([k,h])=>[k,JSON.parse(split.payloads[h])]));
const memory=()=>{const m=new Map();return {getItem:k=>m.get(k)??null,setItem:(k,v)=>m.set(k,v),removeItem:k=>m.delete(k),data:m};};
const globals=()=>{const old={fetch:globalThis.fetch,localStorage:globalThis.localStorage};globalThis.localStorage=memory();return ()=>{for(const [k,v] of Object.entries(old)){if(v===undefined)delete globalThis[k];else globalThis[k]=v;}};};

// Real Worker routes, an in-memory Drive file API, and a local browser store.
// This exercises object checksums, history-before-head publication, CAS and
// app/profile scoping without credentials or real Drive writes.
function cloud(){
 const files=new Map(),folders=new Set(),calls=[];
 const storage={get:async k=>k.startsWith('last-')?Date.now():undefined,put:async()=>{},delete:async()=>{}};
 const coord=new AccountCoordinator({storage,waitUntil(){}},{});
 coord.appFolder=async(p,a,create)=>{const key=`${p}/${a}`;if(create)folders.add(key);return folders.has(key)?key:null;};
 coord.folders=async()=>({objects:'objects',profiles:'profiles'});
 coord.list=async(folder,names)=>{const wanted=Array.isArray(names)?new Set(names):names?new Set([names]):null;return [...files.values()].filter(f=>f.folder===folder&&(!wanted||wanted.has(f.name)));};
 coord.content=async id=>{if(!files.has(id))throw Error('Missing Drive file');return files.get(id).content;};
 coord.createJSON=async(folder,name,content)=>{const id=crypto.randomUUID();const f={id,folder,name,content,createdTime:new Date().toISOString()};files.set(id,f);return f;};
 coord.replaceJSON=async(id,content)=>{files.get(id).content=content;};
 // Drive indexing is independently covered in indexed-sync.test.js.
 coord.resolveObjects=async(folder,hashes)=>new Map(hashes.flatMap(h=>{const f=[...files.values()].find(f=>f.folder===folder&&f.name===h+'.json');return f?[[h,f.id]]:[];}));
 coord.indexObject=async()=>{};
 const send=async(url,opts={})=>{const path=String(url).replace('/_profiles/v1','');calls.push(path);return coord.route({method:opts.method||'GET',path,body:opts.body});};
 globalThis.fetch=send;
 return {files,calls,send};
}

test('generic partition uses app fields, never Ciyan field-name heuristics',async()=>{
 const {codec}=fixture(),cache=createBackupCache();const first=await codec.splitBackup(snapshot(),{cache});
 const second=await codec.splitBackup(snapshot(2),{cache});
 assert.deepEqual(Object.keys(first.sections),['reader','settings']);assert.equal(second.stats.reusedHashes,1);
 assert.equal(first.sections.reader,second.sections.reader);assert.notEqual(first.sections.settings,second.sections.settings);
 assert.equal(first.sections.reader,await checksum(JSON.stringify(snapshot().state.reader)));
 assert.deepEqual(await codec.reconstructBackup(revision(first),entries(first)),snapshot());
});

test('explicit schema, app identity, safe JSON, and section size are enforced before requests',async()=>{
 const cleanup=globals();let calls=0;globalThis.fetch=async()=>{calls++;throw Error('unexpected request');};
 try{
  const a=fixture(),b=fixture('fixture-b'),split=await a.codec.splitBackup(snapshot());
  assert.throws(()=>fixture('ciyan'),/reserved/);assert.throws(()=>fixture('bad/id'),/identity/);
  assert.throws(()=>createSyncScheduler({profileId:'p',appId:'fixture-a'}),/explicit backup codec/);
  await assert.rejects(uploadBackup('p','fixture-b',snapshot(),null,{codec:a.codec}),/explicit backup codec/);
  await assert.rejects(downloadBackup('p','fixture-b',revision(split),undefined,{codec:b.codec}),/schema/);
  await assert.rejects(a.codec.splitBackup({...snapshot(),version:2}),/schema/);
  await assert.rejects(a.codec.splitBackup({...snapshot(),state:{...snapshot().state,x:NaN}}),/plain JSON/);
  await assert.rejects(a.codec.splitBackup({...snapshot(),state:{...snapshot().state,x:new Uint8Array(1)}}),/plain JSON/);
  await assert.rejects(fixture('fixture-a',{partition:()=>({sections:JSON.parse('{"__proto__":1}'),layout:{}})}).codec.splitBackup(snapshot()),/section/);
  await assert.rejects(fixture('fixture-a',{partition:()=>({sections:{huge:'x'.repeat(16*1024*1024)},layout:{}})}).codec.splitBackup(snapshot()),/16 MiB/);
  assert.equal(calls,0);
 }finally{cleanup();}
});

test('incomplete, wrongly decoded and schema-incompatible backups never reconstruct',async()=>{
 const a=fixture(),split=await a.codec.splitBackup(snapshot());
 await assert.rejects(a.codec.reconstructBackup(revision(split),{reader:snapshot().state.reader}),/Incomplete/);
 await assert.rejects(a.codec.reconstructBackup(revision(split),{...entries(split),settings:{n:'wrong'}}),/rejected/);
 const lossy=fixture('fixture-a',{assemble:parts=>({...parts,settings:{n:99}})});
 await assert.rejects(lossy.codec.reconstructBackup(revision(split),entries(split)),/round-trip/);
});

test('real Worker routes keep app/profile heads separate and restore exact history on a cold device',async()=>{
 const cleanup=globals();const {calls,files}=cloud();let local=1,restored=0;
 const a=fixture('fixture-a',{readSnapshot:async({profileId})=>{assert.equal(profileId,'p');return {backup:snapshot(local),revision:local};},restore:async({profileId,expectedRevision,backup})=>{assert.equal(profileId,'p');if(expectedRevision!==local)throw Error('Local revision changed');local=backup.state.settings.n;restored++;}});
 const b=fixture('fixture-b');const s=a.startSync({profileId:'p'}),t=b.startSync({profileId:'p'}),u=b.startSync({profileId:'q'});
 try{
  assert.equal(calls.length,0,'constructing adapters and schedulers never opts in automatically');
  s.changed();const first=await s.now();assert.equal(first.status,'committed');
  local=2;s.changed();const second=await s.now();assert.notEqual(first.head.id,second.head.id);
  t.changed();await t.now();u.changed();await u.now();
  assert.equal(getSyncCursor('p','fixture-a').head,second.head.id);assert.notEqual(getSyncCursor('p','fixture-b').head,second.head.id);assert.notEqual(getSyncCursor('q','fixture-b').head,getSyncCursor('p','fixture-b').head);
  assert.equal([...files.values()].filter(f=>f.folder==='objects').length,3,'identical content may deduplicate within the same account');
  globalThis.localStorage=memory();
  assert.deepEqual((await a.downloadRevision({profileId:'p'})).backup,snapshot(2));
  await assert.rejects(a.restoreRevision({profileId:'p',revisionId:first.head.id,expectedRevision:1}),/Local revision changed/);assert.equal(restored,0);assert.equal(local,2);
  await a.restoreRevision({profileId:'p',revisionId:first.head.id,expectedRevision:2});assert.equal(restored,1);assert.equal(local,1);
  assert.equal(getSyncCursor('p','fixture-a'),null,'history restore does not invent a sync cursor');
  await assert.rejects(b.downloadRevision({profileId:'p',revisionId:first.head.id}),/Revision not found/);
  assert.equal((await a.downloadRevision({profileId:'p'})).revision.id,second.head.id,'restore never writes a cloud head');
 }finally{s.stop();t.stop();u.stop();cleanup();}
});

test('missing and corrupt objects fail before restore and do not change local data',async()=>{
 const cleanup=globals();const {files,send}=cloud();let restored=0;
 const a=fixture('fixture-a',{restore:async()=>{restored++;}}),s=a.startSync({profileId:'p'});
 try{
  s.changed();const {head}=await s.now();
  globalThis.fetch=async(url,opts)=>String(url).endsWith('/read-batch')?Response.json({objects:{}}):send(url,opts);
  await assert.rejects(a.restoreRevision({profileId:'p',revisionId:head.id,expectedRevision:1}),/Missing backup section/);
  globalThis.fetch=send;
  const f=[...files.values()].find(f=>f.folder==='objects');f.content='{"tampered":true}';
  await assert.rejects(a.restoreRevision({profileId:'p',revisionId:head.id,expectedRevision:1}),/integrity/);assert.equal(restored,0);
 }finally{s.stop();cleanup();}
});

test('lost commit response with a newer local edit recovers exact receipt and both revisions',async()=>{
 const cleanup=globals();const {send,files}=cloud();let local=1,divergence=0,lost=true;
 const a=fixture('fixture-a',{readSnapshot:async()=>({backup:snapshot(local),revision:local})});
 const s=a.startSync({profileId:'p',onDivergence:()=>{divergence++;}});
 globalThis.fetch=async(url,opts)=>{const response=await send(url,opts);if(lost&&String(url).endsWith('/commit')){lost=false;local=2;s.changed();throw Error('lost response');}return response;};
 try{
  s.changed();await assert.rejects(s.flush(),/lost response/);const pending=getSyncCursor('p','fixture-a');assert.equal(pending.pendingLocalRevision,1);
  await s.now();assert.equal(divergence,0);assert.equal(getSyncCursor('p','fixture-a').localRevision,2);
  assert.deepEqual((await a.downloadRevision({profileId:'p',revisionId:pending.pendingRevisionId})).backup,snapshot(1));
  assert.deepEqual((await a.downloadRevision({profileId:'p'})).backup,snapshot(2));
  assert.equal([...files.values()].filter(f=>/^r_/.test(f.name)).length,2);
 }finally{s.stop();cleanup();}
});

test('cold cursor conflict preserves remote state; network error is never a divergence',async()=>{
 const cleanup=globals();const {send}=cloud();const a=fixture();const first=a.startSync({profileId:'p'});let conflicts=0;let s;
 try{
  first.changed();const {head}=await first.now();first.stop();globalThis.localStorage=memory();
  s=fixture('fixture-a',{readSnapshot:async()=>({backup:snapshot(2),revision:2})}).startSync({profileId:'p',onDivergence:()=>{conflicts++;}});
  globalThis.fetch=async()=>{throw Error('temporary offline');};s.changed();await assert.rejects(s.now(),/offline/);assert.equal(conflicts,0);
  globalThis.fetch=send;await assert.rejects(s.now(),/different cloud revision/);assert.equal(conflicts,1);assert.equal((await a.downloadRevision({profileId:'p'})).revision.id,head.id);
 }finally{first.stop();s?.stop();cleanup();}
});

test('generic commit acknowledgement must match exact revision and metadata',async()=>{
 const cleanup=globals();const {send}=cloud();const a=fixture(),s=a.startSync({profileId:'p'});
 globalThis.fetch=async(url,opts)=>{const result=await send(url,opts);if(String(url).endsWith('/commit')){const body=await result.json();body.head.id='wrong';return Response.json(body);}return result;};
 try{s.changed();await assert.rejects(s.now(),/did not confirm/);assert.equal(getSyncCursor('p','fixture-a').localRevision,null);}
 finally{s.stop();cleanup();}
});

test('an immutable revision collision without a confirmed head is not a profile conflict',async()=>{
 const cleanup=globals();const {send}=cloud();let conflicts=0;
 const s=fixture().startSync({profileId:'p',onDivergence:()=>{conflicts++;}});
 globalThis.fetch=async(url,opts)=>String(url).endsWith('/commit')?Response.json({error:'Revision ID already belongs to different content'},{status:409}):send(url,opts);
 try{s.changed();await assert.rejects(s.now(),/Revision ID already/);assert.equal(conflicts,0);}
 finally{s.stop();cleanup();}
});
