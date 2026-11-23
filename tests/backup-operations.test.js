import test from 'node:test';
import assert from 'node:assert/strict';
import {splitBackup,uploadBackup,downloadBackup,createSyncScheduler} from '../src/sync.js';
import {AccountCoordinator} from '../worker/index.js';
const response=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
const sample=()=>({format:'ciyan-backup',version:2,appVersion:'0.9.8',state:{cards:Array.from({length:270},(_,i)=>({id:`card-${i}`,hanzi:`词${i}`})),history:[{id:'h1'}],settings:{theme:'light'}}});

test('first push uploads grouped sections, then commits and can be downloaded',async()=>{
 const backup=sample(),split=await splitBackup(backup),calls=[],store=new Map(),original=globalThis.fetch;
 globalThis.fetch=async(url,opts={})=>{
  const path=new URL(url,'https://host.test').pathname.replace('/_profiles/v1','');calls.push({path,method:opts.method});
  if(path.endsWith('/head'))return response({head:null});
  if(path==='/objects/batch'){
   const batch=JSON.parse(opts.body).objects;assert(batch.length<=12);
   for(const entry of batch)store.set(entry.hash,JSON.parse(entry.content));return response({stored:batch.length});
  }
  if(path.endsWith('/commit')){const data=JSON.parse(opts.body);assert.equal(data.expected,null);assert.deepEqual(data.revision.sections,split.sections);return response({head:data.revision});}
  if(path==='/objects/read-batch'){const hashes=JSON.parse(opts.body).hashes;return response({objects:Object.fromEntries(hashes.map(hash=>[hash,store.get(hash)]))});}
  throw Error(`Unexpected ${path}`);
 };
 try{
  const progress=[];const sent=await uploadBackup('p','ciyan',backup,{head:null},{onProgress:x=>progress.push(x)});
  assert.equal(sent.status,'committed');assert(calls.some(x=>x.path==='/objects/batch'));assert.equal(calls.filter(x=>x.path.endsWith('/commit')).length,1);
  assert(progress.some(x=>x.stage==='committing'));
  const restored=await downloadBackup('p','ciyan',sent.head);
  assert.deepEqual(restored.state,backup.state);
 }finally{globalThis.fetch=original;}
});

test('failed upload never commits or silently becomes successful',async()=>{
 const original=globalThis.fetch,calls=[];
 globalThis.fetch=async(url)=>{
  const path=new URL(url,'https://host.test').pathname;calls.push(path);
  if(path.endsWith('/head'))return response({head:null});
  if(path.endsWith('/objects/batch'))return response({error:'Drive API 403',stage:'/objects/batch'},502);
  throw Error(`Unexpected ${path}`);
 };
 try{await assert.rejects(uploadBackup('p','ciyan',sample(),{head:null}),/Drive API 403/);assert(!calls.some(path=>path.endsWith('/commit')));}
 finally{globalThis.fetch=original;}
});

test('Worker commits using one object listing rather than per-section Drive requests',async()=>{
 const objects=new Set(),stored=[];
 const coord=new AccountCoordinator({storage:{},waitUntil(){}},{});
 coord.folders=async()=>({objects:'objects'});
 coord.appFolder=async()=> 'app';
 coord.head=async()=>({head:null,file:null});
 coord.list=async(parent,name)=>{if(parent==='objects'){stored.push(name);return [...objects].map(name=>({name}));}return [];};
 coord.createJSON=async(parent,name,text)=>{stored.push(name);return {id:name};};
 const split=await splitBackup(sample());
 for(const hash of Object.values(split.sections))objects.add(`${hash}.json`);
 const revision={format:1,id:'r1',operationId:'o1',parent:null,sections:split.sections,meta:split.meta,at:new Date().toISOString()};
 const result=await coord.route({method:'POST',path:'/profiles/p/apps/ciyan/commit',body:JSON.stringify({expected:null,revision})});
 assert.equal(result.status,200);
 assert.equal(stored.filter(item=>item===null).length,0);
 assert.equal(stored.filter(item=>item===undefined).length,1); // One list for all object names
});

test('retry after interrupted head update resumes immutable revision without duplicating it',async()=>{
 const data=await splitBackup(sample()),files=new Map(),writes=[],known=new Set(Object.values(data.sections).map(h=>`${h}.json`));
 const ctx={storage:{get:async()=>Date.now(),put:async()=>{}},waitUntil(){}},coord=new AccountCoordinator(ctx,{});
 coord.folders=async()=>({objects:'objects'});coord.appFolder=async()=> 'app';
 coord.head=async()=>({folder:'app',head:files.has('head.json')?JSON.parse(files.get('head.json')):null,file:files.has('head.json')?{id:'head.json'}:null});
 coord.list=async(folder,name)=>folder==='objects'?[...known].map(x=>({name:x})):name&&files.has(name)?[{name,id:name}]:[];
 coord.content=async id=>files.get(id);
 let failHead=true;
 coord.createJSON=async(_folder,name,content)=>{
  writes.push(name);
  if(name==='head.json'&&failHead){failHead=false;throw Error('Drive API 503');}
  files.set(name,content);return {id:name};
 };
 coord.replaceJSON=async(id,content)=>{files.set(id,content);};
 const revision={format:1,id:'revision-one',operationId:'operation-one',parent:null,sections:data.sections,meta:data.meta,at:new Date().toISOString()};
 const commit=()=>coord.route({method:'POST',path:'/profiles/profile/apps/ciyan/commit',body:JSON.stringify({expected:null,revision})});
 await assert.rejects(commit(),/503/);
 assert(files.has('r_revision-one.json'));
 const retry={...revision,at:new Date(Date.now()+40000).toISOString()};
 const recovered=await coord.route({method:'POST',path:'/profiles/profile/apps/ciyan/commit',body:JSON.stringify({expected:null,revision:retry})});assert.equal(recovered.status,200);
 assert.equal(writes.filter(x=>x==='r_revision-one.json').length,1);
 assert.equal(JSON.parse(files.get('head.json')).id,'revision-one');
});

test('portable reader content is independently chunked and reconstructs on a cold device',async()=>{
 const chapter='{"novel":"custom-book","number":1,"paragraphs":[]}',digest='f'.repeat(64);
 const backup={format:'ciyan-backup',version:2,appVersion:'0.9.11',state:{readerContent:{[digest]:chapter},cards:[{id:'word'}],settings:{cloudIncludeCustomText:true}}};
 const split=await splitBackup(backup),entries=Object.fromEntries(Object.entries(split.sections).map(([key,h])=>[key,JSON.parse(split.payloads[h])]));
 assert(split.meta.layout.readerContent.type==='reader-text');
 assert.deepEqual(Object.keys(split.sections).filter(k=>k.startsWith('readerText_')).length,1);
 assert.deepEqual((await import('../src/sync.js')).reconstructBackup({meta:split.meta},entries).state,backup.state);
});
