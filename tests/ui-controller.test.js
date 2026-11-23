import test from 'node:test';
import assert from 'node:assert/strict';
import {installProfileUI} from '../src/ui.js';

// Simulate two independently imported copies of the shared UI in one document.
// The AbortController contract must remove the first instance's listeners.
test('only the most recently installed profile manager owns a click on the document',async()=>{
 const previous={document:globalThis.document,window:globalThis.window,localStorage:globalThis.localStorage,sessionStorage:globalThis.sessionStorage,fetch:globalThis.fetch};
 const callbacks=new Map(),appended=[];
 const document={
  head:{append(){}},body:{append(el){appended.push(el);},style:{removeProperty(){}}},
  getElementById(){return null;},createElement(tag){
   if(tag==='style')return {textContent:'',id:''};
   const panel={innerHTML:'',setAttribute(){}};
   return {className:'',innerHTML:'',style:{},addEventListener(){},remove(){},querySelector(){return panel;}};
  },
  addEventListener(type,fn,{signal}={}){
   const set=callbacks.get(type)||new Set();set.add(fn);callbacks.set(type,set);
   signal?.addEventListener('abort',()=>set.delete(fn),{once:true});
  }
 };
 globalThis.document=document;
 globalThis.window={addEventListener(){}};
 globalThis.localStorage={getItem(){return null;},setItem(){}};
 globalThis.sessionStorage={getItem(){return null;}};
 globalThis.fetch=async()=>new Response(JSON.stringify({connected:false}),{headers:{'Content-Type':'application/json'}});
 try{
  const first=installProfileUI();
  assert.equal(callbacks.get('click').size,1);
  const second=installProfileUI();
  assert.equal(callbacks.get('click').size,1);
  assert.notEqual(first,second);
  assert.equal(document[Symbol.for('pwa.profile.manager.controller')],second);
  const click={target:{closest:selector=>selector==='[data-pwa-profile-button]'?{}:null},preventDefault(){}};
  for(const handler of callbacks.get('click'))handler(click);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(appended.length,1,'one profile overlay should open, not two');
  second.destroy();
  assert.equal(callbacks.get('click').size,0);
  assert.equal(document[Symbol.for('pwa.profile.manager.controller')],undefined);
 }finally{
  for(const [key,value] of Object.entries(previous)){
   if(value===undefined)delete globalThis[key];else globalThis[key]=value;
  }
 }
});

test('archive Push opens a single menu and invokes a verified first upload',async()=>{
 const previous={document:globalThis.document,window:globalThis.window,localStorage:globalThis.localStorage,sessionStorage:globalThis.sessionStorage,fetch:globalThis.fetch};
 const records=new Map(),panels=[];
 const storage=new Map();
 globalThis.document={
  head:{append(){}},body:{append(node){panels.push(node);},style:{removeProperty(){}}},
  getElementById(){return null;},
  createElement(tag){if(tag==='style')return {};
   const panel={innerHTML:'',setAttribute(){}};
   return {className:'',innerHTML:'',addEventListener(){},remove(){},querySelector(){return panel;}};},
  addEventListener(type,fn,{signal}={}){const items=records.get(type)||new Set();items.add(fn);records.set(type,items);signal?.addEventListener('abort',()=>items.delete(fn),{once:true});}
 };
 globalThis.window={addEventListener(){}};
 globalThis.localStorage={getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)};
 globalThis.sessionStorage={getItem(){return null;}};
 globalThis.fetch=async url=>{
  const path=new URL(url,'https://example.org').pathname;
  return new Response(JSON.stringify(path.endsWith('/status')?{connected:true,email:'test@example.org'}:{profiles:[]}),{headers:{'Content-Type':'application/json'}});
 };
 let count=0;
 try{
  const controller=installProfileUI({adapter:{
   onPush:async ({targetId,name})=>{count++;assert.equal(targetId,null);assert.equal(name,'Default');return {id:'cloud-first',head:{id:'revision-ok'}};},
   statusText:()=> 'Local profile'
  }});
  await controller.open('push');
  assert.equal(count,1,'Push must call the actual backup callback');
  assert.equal(panels.length,1,'Push should create only one dialog');
  assert.equal(records.get('click').size,1);
  controller.destroy();
 }finally{
  for(const [key,value] of Object.entries(previous)){
   if(value===undefined)delete globalThis[key];else globalThis[key]=value;
  }
 }
});
