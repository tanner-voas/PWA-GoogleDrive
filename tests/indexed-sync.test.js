import test from 'node:test';
import assert from 'node:assert/strict';
import {AccountCoordinator} from '../worker/index.js';
import {createBackupCache,splitBackup,uploadBackup,syncDiagnostics,checksum} from '../src/sync.js';
const hash=i=>i.toString(16).padStart(64,'0');
const storage=()=>{const data=new Map();return {data,get:async k=>Array.isArray(k)?new Map(k.filter(x=>data.has(x)).map(x=>[x,data.get(x)])):data.get(k),put:async(k,v)=>{if(typeof k==='string')data.set(k,v);else for(const [key,val] of Object.entries(k))data.set(key,val);},delete:async k=>{for(const key of Array.isArray(k)?k:[k])data.delete(key);}};};
const context=store=>({storage:store,waitUntil(){}});
const fixture=(store,files)=>{const coord=new AccountCoordinator(context(store),{}),calls=[];
 coord.folders=async()=>({objects:'objects',profiles:'profiles'});
 coord.list=async(folder,names)=>{calls.push({folder,names});if(folder!=='objects')return [];const wanted=Array.isArray(names)?new Set(names):names?new Set([names]):null;return [...files.values()].filter(f=>!wanted||wanted.has(f.name));};
 coord.createJSON=async(folder,name,content)=>{const file={id:'id-'+crypto.randomUUID(),name,content,createdTime:new Date().toISOString()};files.set(file.id,file);return file;};
 coord.content=async id=>{if(!files.has(id))throw Error('Drive API 404');return files.get(id).content;};
 coord.remove=async id=>files.delete(id);
 return {coord,calls};};
const route=(coord,path,body,method='POST')=>coord.route({method,path,body:typeof body==='string'?body:JSON.stringify(body)});
test('10k historical objects: cold lookup once, warm and restarted workers reuse index; new object uses targeted lookup',async()=>{
 const files=new Map(Array.from({length:10000},(_,i)=>['id'+i,{id:'id'+i,name:hash(i)+'.json'}])),store=storage();
 const first=fixture(store,files),wanted=Array.from({length:250},(_,i)=>hash(i));
 assert.equal((await first.coord.resolveObjects('objects',wanted)).size,250);
 assert.equal(first.calls.length,1);assert.equal(first.calls[0].names,undefined);
 const second=fixture(store,files);
 assert.equal((await second.coord.resolveObjects('objects',wanted)).size,250);assert.equal(second.calls.length,0);
 const content=JSON.stringify({new:'bookmark'}),h=await checksum(content);
 const response=await route(second.coord,'/objects/batch',{objects:[{hash:h,content}]});assert.equal(response.status,200);assert.equal((await response.json()).created,1);
 assert.equal(second.calls.length,1);assert.deepEqual(second.calls[0].names,[h+'.json']);
 assert.equal((await second.coord.resolveObjects('objects',[...wanted,h])).size,251);assert.equal(second.calls.length,1);
 const read=await route(second.coord,'/objects/read-batch',{hashes:[h]});assert.equal(read.status,200);assert.deepEqual((await read.json()).objects[h],{new:'bookmark'});assert.equal(second.calls.length,1);
});
test('expired entries reconcile; a stale file ID repairs on verified read; missing objects are not cached',async()=>{
 const store=storage(),content='{"word":1}',h=await checksum(content),files=new Map([['old',{id:'old',name:h+'.json',content}]]),{coord,calls}=fixture(store,files);
 assert.equal((await coord.resolveObjects('objects',[h])).get(h),'old');
 files.delete('old');files.set('replacement',{id:'replacement',name:h+'.json',content});
 const read=await route(coord,'/objects/read-batch',{hashes:[h]});assert.equal(read.status,200);assert.deepEqual((await read.json()).objects[h],{word:1});assert.equal(calls.length,2);
 const key=`object-index:v1:objects:${h}`;assert.equal(store.data.get(key).id,'replacement');
 files.delete('replacement');store.data.get(key).checkedAt=0;
 assert.equal((await coord.resolveObjects('objects',[h])).size,0);assert(!store.data.has(key));
 files.set('again',{id:'again',name:h+'.json',content});assert.equal((await coord.resolveObjects('objects',[h])).get(h),'again');
 files.get('again').content='{"word":2}';await assert.rejects(route(coord,'/objects/read-batch',{hashes:[h]}),/integrity/);assert(!store.data.has(key));
});
test('GC invalidates index before deleting orphan, never removes a referenced object',async()=>{
 const store=storage(),a=hash(1),b=hash(2),old=new Date(Date.now()-8*86400000).toISOString(),files=new Map([['a',{id:'a',name:a+'.json',createdTime:old}],['b',{id:'b',name:b+'.json',createdTime:old}]]),{coord}=fixture(store,files);
 await coord.resolveObjects('objects',[a,b]);const list=coord.list;
 coord.list=async(folder,name)=>folder==='profiles'?[{id:'p',mimeType:'application/vnd.google-apps.folder'}]:folder==='p'?[{id:'app',mimeType:'application/vnd.google-apps.folder'}]:folder==='app'?[{id:'head',name:'head.json'}]:list(folder,name);
 const get=coord.content;coord.content=async id=>id==='head'?JSON.stringify({format:1,id:'head',operationId:'op',sections:{keep:a}}):get(id);
 const remove=coord.remove;coord.remove=async id=>{assert(!store.data.has(`object-index:v1:objects:${b}`));await remove(id);};
 await coord.collectGarbage();assert(files.has('a'));assert(!files.has('b'));assert(store.data.has(`object-index:v1:objects:${a}`));
});
test('per-session cache skips immutable dictionary serialization and rehashes only changed mutable sections',async()=>{
 const cache=createBackupCache({immutableFields:['cards','grammar']}),backup={format:'test',version:2,appVersion:'1',state:{cards:Array.from({length:1000},(_,i)=>({id:'w'+i,hanzi:'字'})),grammar:[{id:'g'}],settings:{x:1},revision:1}};
 const first=await splitBackup(backup,{cache});assert.equal(first.stats.hashed,Object.keys(first.sections).length);
 const second=await splitBackup({...backup,state:{...backup.state,revision:2,settings:{x:1}}},{cache});
 assert.equal(second.stats.hashed,1);assert.equal(second.stats.identityReused,9);assert.equal(second.stats.serialized,2);
 const modified={...backup,state:{...backup.state,cards:backup.state.cards.map((c,i)=>i===0?{...c,hanzi:'词'}:c),revision:3}};
 const third=await splitBackup(modified,{cache});const uncached=await splitBackup(modified);assert.deepEqual(third.sections,uncached.sections);assert.notEqual(third.sections.cards_0,first.sections.cards_0);assert.equal(third.stats.hashed,2);
 const mutable={format:'test',version:2,state:{settings:{a:1}}},generic=createBackupCache();const old=await splitBackup(mutable,{cache:generic});mutable.state.settings.a=2;assert.notEqual((await splitBackup(mutable,{cache:generic})).sections.settings,old.sections.settings);
});
test('large upload preflight reuses retained content and sends oversized section using single PUT',async()=>{
 const backup={format:'test',version:2,state:{cards:Array.from({length:1600},(_,i)=>({id:i})),large:'x'.repeat(2*1024*1024)}},split=await splitBackup(backup),large=split.sections.large;
 const original=globalThis.fetch,oldStorage=globalThis.localStorage,mem=new Map();globalThis.localStorage={getItem:k=>mem.get(k)||null,setItem:(k,v)=>mem.set(k,v)};
 const calls=[];globalThis.fetch=async(url,opts)=>{const path=String(url);calls.push(path);
  const response=value=>Response.json(value,{headers:{'X-PWA-driveCalls':'1','X-PWA-indexHits':'2'}});
  if(path.endsWith('/head'))return response({head:null});
  if(path.endsWith('/objects/missing'))return response({missing:JSON.parse(opts.body).hashes.filter(h=>h===large)});
  if(path.endsWith('/objects/'+large)){assert.equal(opts.method,'PUT');assert.equal(opts.body,split.payloads[large]);return response({stored:true,created:1});}
  if(path.endsWith('/commit'))return response({head:JSON.parse(opts.body).revision});throw Error('Unexpected '+path);
 };
 try{assert.equal((await uploadBackup('p','ciyan',backup,{head:null})).status,'committed');assert.equal(calls.length,4);const [stats]=syncDiagnostics('p','ciyan');assert.equal(stats.objectsSent,1);assert.equal(stats.preflightReused,Object.keys(split.payloads).length-1);assert.equal(stats.driveCalls,4);assert.equal(stats.payloadBytes,2*1024*1024+2);assert.equal(stats.objectsCreated,1);assert(!JSON.stringify(stats).includes('xxxxx'));}
 finally{globalThis.fetch=original;if(oldStorage===undefined)delete globalThis.localStorage;else globalThis.localStorage=oldStorage;}
});
test('a missing previously referenced section is repaired without a fork or a different operation ID',async()=>{
 const before={format:'test',version:2,state:{cards:[{id:'a'}],settings:{x:1}}},old=await splitBackup(before),backup={...before,state:{...before.state,settings:{x:2}}},missing=old.sections.cards,head={id:'base',sections:old.sections,meta:old.meta};let commits=0;const sent=[],original=globalThis.fetch;
 globalThis.fetch=async(url,opts)=>{const path=String(url);
  if(path.endsWith('/head'))return Response.json({head});
  if(path.endsWith('/objects/batch')){sent.push(...JSON.parse(opts.body).objects.map(o=>o.hash));return Response.json({created:1});}
  if(path.endsWith('/commit')){const {revision}=JSON.parse(opts.body);assert.equal(revision.id,'pending');assert.equal(revision.operationId,'operation');if(++commits===1)return Response.json({error:'Missing',missingHashes:[missing]},{status:422});return Response.json({head:revision});}throw Error(path);
 };
 try{const result=await uploadBackup('p','ciyan',backup,{head:'base',pendingRevisionId:'pending',pendingOperationId:'operation'});assert.equal(result.status,'committed');assert.equal(commits,2);assert.equal(sent.at(-1),missing);assert.equal(sent.length,2);}
 finally{globalThis.fetch=original;}
});
test('transient safe Drive reads retry; permission failures and ambiguous writes do not',async()=>{
 const coord=new AccountCoordinator(context(storage()),{});coord.token=async()=> 'fake';const original=globalThis.fetch;let calls=0;
 try{globalThis.fetch=async()=>++calls===1?Response.json({error:{errors:[{reason:'userRateLimitExceeded'}]}},{status:403}):Response.json({ok:true});assert.equal((await coord.drive('https://drive.test')).status,200);assert.equal(calls,2);
  calls=0;globalThis.fetch=async()=>{calls++;return Response.json({error:{errors:[{reason:'insufficientPermissions'}]}},{status:403});};await assert.rejects(coord.drive('https://drive.test'),/403/);assert.equal(calls,1);
  calls=0;globalThis.fetch=async()=>{calls++;return Response.json({},{status:503});};await assert.rejects(coord.drive('https://drive.test',{method:'POST'}),/503/);assert.equal(calls,1);
 }finally{globalThis.fetch=original;}
});
test('Drive targeted names retain pagination and escape query syntax',async()=>{
 const coord=new AccountCoordinator(context(storage()),{}),urls=[];
 coord.drive=async url=>{const parsed=new URL(url);urls.push(parsed);return Response.json(urls.length===1?{files:[{id:'first'}],nextPageToken:'next'}:{files:[{id:'second'}]});};
 const files=await coord.list('parent',[hash(1)+'.json',hash(2)+'.json']);assert.deepEqual(files.map(f=>f.id),['first','second']);
 assert.match(urls[0].searchParams.get('q'),/trashed = false and \(name = '[a-f0-9]{64}\.json' or name = '[a-f0-9]{64}\.json'\)/);
 assert.equal(urls[1].searchParams.get('pageToken'),'next');
});
test('commit with an expired deleted object reports repair hashes before writing a revision',async()=>{
 const store=storage(),h=hash(1),files=new Map([['old',{id:'old',name:h+'.json'}]]),{coord}=fixture(store,files);
 await coord.resolveObjects('objects',[h]);files.clear();store.data.get(`object-index:v1:objects:${h}`).checkedAt=0;
 coord.appFolder=async()=> 'app';coord.head=async()=>({folder:'app',file:null,head:null});
 coord.createJSON=async()=>{throw Error('must not write a revision or head');};
 const revision={format:1,id:'r',operationId:'op',parent:null,sections:{cards:h},meta:{layout:{}},at:new Date().toISOString()};
 const response=await route(coord,'/profiles/p/apps/ciyan/commit',{expected:null,revision});assert.equal(response.status,422);assert.deepEqual((await response.json()).missingHashes,[h]);
});
