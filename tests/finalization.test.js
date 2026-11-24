import test from 'node:test';
import assert from 'node:assert/strict';
import {createSyncScheduler,splitBackup,setSyncCursor,getSyncCursor,reconcilePendingCommit,syncDiagnostics} from '../src/sync.js';
import {AccountCoordinator} from '../worker/index.js';
const snapshot=n=>({format:'test',version:1,state:{revision:n,settings:{bookmark:n}}});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
for(const lostAck of [false,true])test(`edit same chunk during commit${lostAck?' with lost acknowledgement':''} preserves both versions`,async()=>{
 const originalFetch=globalThis.fetch,originalStorage=globalThis.localStorage,store=new Map();
 globalThis.localStorage={getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,v)};
 const profile='p',app='ciyan';let local=1,head=null,conflicts=0;const objects=new Map(),revisions=[],entered=deferred(),release=deferred();
 const statuses=[];globalThis.fetch=async(url,opts={})=>{
  const path=String(url);if(path.endsWith('/head'))return Response.json({head});
  if(path.endsWith('/objects/batch')){for(const o of JSON.parse(opts.body).objects)objects.set(o.hash,o.content);return Response.json({created:1});}
  if(path.endsWith('/commit')){const {expected,revision}=JSON.parse(opts.body);assert.equal(expected,head?.id??null);assert.equal(revision.parent,expected);for(const h of Object.values(revision.sections))assert(objects.has(h));
   if(revisions.length===0){entered.resolve();await release.promise;head=revision;revisions.push(revision);if(lostAck)throw Error('lost acknowledgement');}
   else{head=revision;revisions.push(revision);}return Response.json({head});}
  throw Error(`unexpected ${path}`);
 };
 const scheduler=createSyncScheduler({profileId:profile,appId:app,readBackup:async()=>({backup:snapshot(local),revision:local}),onStatus:x=>statuses.push(x.phase),onDivergence:()=>{conflicts++;}});
 try{scheduler.changed();const first=scheduler.flush();const firstResult=first.catch(e=>e);await entered.promise;local=2;scheduler.changed();assert.equal(statuses.at(-1),'syncing');release.resolve();
  const result=await firstResult;if(lostAck){assert.match(result.message,/lost acknowledgement/);assert.equal(getSyncCursor(profile,app).pendingLocalRevision,1);}else assert.equal(result.status,'pending');
  await scheduler.now();assert.equal(conflicts,0);assert.equal(revisions.length,2);assert.notEqual(revisions[0].id,revisions[1].id);assert.equal(revisions[1].parent,revisions[0].id);
  assert.equal(JSON.parse(objects.get(revisions[0].sections.settings)).bookmark,1);assert.equal(JSON.parse(objects.get(revisions[1].sections.settings)).bookmark,2);assert.equal(getSyncCursor(profile,app).localRevision,2);assert.equal(statuses.at(-1),'synced');assert.equal((await scheduler.now()).status,'unchanged');assert.equal(revisions.length,2);
  assert(Number.isFinite(syncDiagnostics(profile,app)[0].commitMs));
 }finally{scheduler.stop();globalThis.fetch=originalFetch;if(originalStorage===undefined)delete globalThis.localStorage;else globalThis.localStorage=originalStorage;}
});
test('restart receipt is accepted only for matching pending operation, revision and parent',()=>{
 const cursor={head:'previous',localRevision:9,pendingOperationId:'op',pendingRevisionId:'r10',pendingLocalRevision:10};
 const head={id:'r10',operationId:'op',parent:'previous'};
 assert.deepEqual(reconcilePendingCommit(cursor,head),{head:'r10',localRevision:10,pendingOperationId:null,pendingRevisionId:null,pendingLocalRevision:null});
 for(const changed of [{id:'other'},{operationId:'other'},{parent:'other'}])assert.equal(reconcilePendingCommit(cursor,{...head,...changed}),null);
});
test('commit locates head and retry revision together, still checks all objects and writes history before head',async()=>{
 const data=await splitBackup(snapshot(2)),base={id:'base',operationId:'baseop',parent:null,sections:data.sections},calls=[];
 const coord=new AccountCoordinator({storage:{},waitUntil(){}},{});coord.appFolder=async()=> 'app';coord.folders=async()=>({objects:'objects'});
 coord.list=async(folder,names)=>{calls.push(['list',folder,names]);assert.deepEqual(names,['head.json','r_next.json']);return [{name:'head.json',id:'head-id'}];};
 coord.content=async id=>{calls.push(['read',id]);return JSON.stringify(base);};
 coord.resolveObjects=async(folder,hashes)=>{calls.push(['verify',folder]);return new Map(hashes.map(h=>[h,h]));};
 coord.createJSON=async(folder,name)=>{calls.push(['create',name]);return {id:name};};coord.replaceJSON=async(id)=>calls.push(['replace',id]);
 const revision={format:1,id:'next',operationId:'nextop',parent:'base',sections:data.sections,meta:data.meta,at:new Date().toISOString()};
 const result=await coord.route({method:'POST',path:'/profiles/p/apps/ciyan/commit',body:JSON.stringify({expected:'base',revision})});
 assert.equal(result.status,200);assert.deepEqual(calls,[['list','app',['head.json','r_next.json']],['read','head-id'],['verify','objects'],['create','r_next.json'],['replace','head-id']]);
});
