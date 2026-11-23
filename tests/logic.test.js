import test from 'node:test';import assert from 'node:assert/strict';
import {retainedIds,checkRevision} from '../src/retention.js';
import {readRegistry,renameProfile,selectProfile,upsertProfile} from '../src/profiles.js';
const mock=()=>{const data=new Map();return {getItem:key=>data.get(key)||null,setItem:(k,v)=>data.set(k,v)};};
test('initial profile persists a permanent ID and allows rename',()=>{
 const storage=mock();const a=readRegistry(storage);assert.equal(a.profiles[0].name,'Default');assert.equal(readRegistry(storage).active,a.active);
 renameProfile(a.active,'Tanner GD',storage);assert.equal(readRegistry(storage).profiles[0].name,'Tanner GD');
});
test('switch cannot select unknown profiles',()=>{const storage=mock();readRegistry(storage);assert.throws(()=>selectProfile('missing',storage));upsertProfile({id:'profile-other',name:'Study'},storage);selectProfile('profile-other',storage);assert.equal(readRegistry(storage).active,'profile-other');});
test('rolling retention preserves recent snapshots and unknown timestamps',()=>{const now=Date.UTC(2026,10,23);const items=Array.from({length:50},(_,i)=>({id:`${i}`,at:new Date(now-i*86400000).toISOString()}));items.push({id:'unknown',at:'bad'});const keep=retainedIds(items,now);assert(keep.has('0'));assert(keep.has('unknown'));assert(keep.size<items.length);});
test('revision validation rejects corrupt hashes',()=>{assert.throws(()=>checkRevision({format:1,id:'x',operationId:'op',sections:{settings:'oops'}}));});
import {splitBackup,reconstructBackup,uploadBackup} from '../src/sync.js';
test('partitioned backups reconstruct completely',async()=>{
 const source={format:'ciyan-backup',version:2,appVersion:'0.9.7',state:{history:Array.from({length:280},(_,i)=>({i})),schedules:{alpha:{n:1},beta:{n:2}},cards:[{id:'a'}],speechVault:{salt:'secret'}}};
 const split=await splitBackup(source),entries=Object.fromEntries(Object.entries(split.sections).map(([key,hash])=>[key,JSON.parse(split.payloads[hash])]));
 const actual=reconstructBackup({meta:split.meta},entries);assert.deepEqual(actual.state,source.state);
});
test('changing one schedule changes only one bucket, not dictionary content',async()=>{
 const original={format:'ciyan-backup',version:2,appVersion:'0.9.7',state:{cards:[{id:'word',hanzi:'词'}],schedules:{alpha:{grade:1},beta:{grade:2}},history:[]}};
 const before=await splitBackup(original);
 const changed=structuredClone(original);changed.state.schedules.alpha.grade=3;
 const after=await splitBackup(changed);
 assert.equal(after.sections.cards,before.sections.cards);
 const delta=Object.keys(before.sections).filter(k=>before.sections[k]!==after.sections[k]);
 assert.equal(delta.length,1);assert.match(delta[0],/^schedules_\d+$/);
});

test('lost commit response never marks newer local changes as uploaded',async()=>{
 const original={format:'ciyan-backup',version:2,appVersion:'0.9.7',state:{cards:[{id:'a'}],history:[]}};
 const old=await splitBackup(original);const newer=structuredClone(original);newer.state.history.push({cardId:'a',grade:3});
 const cursor={head:null,pendingOperationId:'previous-upload'};
 const saved=globalThis.fetch;
 globalThis.fetch=async(url)=>{assert.match(String(url),/\/head$/);return new Response(JSON.stringify({head:{id:'old-commit',operationId:'previous-upload',sections:old.sections}}),{status:200,headers:{'Content-Type':'application/json'}});};
 try{const result=await uploadBackup('profile','ciyan',newer,cursor);assert.equal(result.status,'committed');assert.equal(result.stale,true);assert.equal(result.head.id,'old-commit');}
 finally{globalThis.fetch=saved;}
});
