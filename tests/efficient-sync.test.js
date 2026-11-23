import test from 'node:test';
import assert from 'node:assert/strict';
import {splitBackup,reconstructBackup,createSyncScheduler,setSyncCursor} from '../src/sync.js';

const snapshot=()=>({format:'ciyan-backup',version:2,appVersion:'0.9.11',state:{
 cards:Array.from({length:260},(_,i)=>({id:`w-${i}`,hanzi:`字${i}`})),
 grammar:Array.from({length:260},(_,i)=>({id:`g-${i}`,markup:`语${i}`})),
 settings:{voice:'default'},
 reader:{panlong:{current:1,items:{term:{kind:'term',hanzi:'盘龙'}},progress:{},chapters:[{digest:'a',position:{offset:10},all:Array(200).fill('word')},{digest:'b',position:{offset:9},all:Array(250).fill('sentence')}] }},
 skillSchedules:{grammar:{a:{difficulty:4},b:{difficulty:2}},drawing:{},particles:{},listening:{}}
}});

test('reader edits upload only the touched chapter plus small status, never dictionary chunks',async()=>{
 const original=snapshot(),before=await splitBackup(original),changed=structuredClone(original);
 changed.state.reader.panlong.chapters[0].position.offset=11;
 const after=await splitBackup(changed);
 const delta=Object.keys(after.sections).filter(k=>after.sections[k]!==before.sections[k]);
 assert.equal(delta.length,1);assert.match(delta[0],/^reader_[a-f0-9]{24}_0_position$/);
 assert.equal(after.sections.cards_0,before.sections.cards_0);
 assert.equal(after.sections.grammar_0,before.sections.grammar_0);
 assert.deepEqual(reconstructBackup({meta:after.meta},Object.fromEntries(Object.entries(after.sections).map(([k,h])=>[k,JSON.parse(after.payloads[h])]))).state,changed.state);
});

test('chapter selection changes only reader cursor and never chapter text',async()=>{
 const before=await splitBackup(snapshot()),changed=snapshot();
 changed.state.reader.panlong.current=2;
 const after=await splitBackup(changed);
 const delta=Object.keys(after.sections).filter(k=>after.sections[k]!==before.sections[k]);
 assert.equal(delta.length,1);
 assert.match(delta[0],/^reader_[a-f0-9]{24}_state_current$/);
});

test('skill mode schedules update only one per-ID bucket',async()=>{
 const before=await splitBackup(snapshot()),changed=snapshot();
 changed.state.skillSchedules.grammar.a.difficulty=5;
 const after=await splitBackup(changed);
 const delta=Object.keys(after.sections).filter(k=>after.sections[k]!==before.sections[k]);
 assert.equal(delta.length,1);assert.match(delta[0],/^skillSchedules_grammar_\d+$/);
 assert.deepEqual(reconstructBackup({meta:after.meta},Object.fromEntries(Object.entries(after.sections).map(([k,h])=>[k,JSON.parse(after.payloads[h])]))).state,changed.state);
});

test('an already synchronized exit makes no network request, but force explicitly checks',async()=>{
 const previousStorage=globalThis.localStorage,stored=new Map();
 globalThis.localStorage={getItem:k=>stored.get(k)||null,setItem:(k,v)=>stored.set(k,v)};
 const id='test-'+crypto.randomUUID(),appId='ciyan';
 setSyncCursor(id,appId,{head:'known',localRevision:9,pendingOperationId:null});
 let calls=0;const original=globalThis.fetch;
 globalThis.fetch=async()=>{calls++;return new Response(JSON.stringify({head:{id:'known',sections:{}}}),{status:200,headers:{'Content-Type':'application/json'}})};
 const scheduler=createSyncScheduler({profileId:id,appId,readBackup:async()=>({backup:{format:'ciyan-backup',version:2,appVersion:'0.9.11',state:{}},revision:9})});
 try{
  assert.equal((await scheduler.now()).status,'unchanged');assert.equal(calls,0);
  assert.equal((await scheduler.now({force:true})).status,'unchanged');assert.equal(calls,1);
 }finally{scheduler.stop();globalThis.fetch=original;if(previousStorage===undefined)delete globalThis.localStorage;else globalThis.localStorage=previousStorage;}
});

test('legacy scalar reader layout is still reconstructible',()=>{
 const reader={panlong:{chapters:[{position:{offset:1}}]}};
 const legacy={meta:{format:'ciyan-backup',version:2,appVersion:'0.9.10',layout:{reader:{type:'scalar'}}}};
 assert.deepEqual(reconstructBackup(legacy,{reader}).state,{reader});
});
