import test from 'node:test';import assert from 'node:assert/strict';
import {retainedIds,checkRevision} from '../src/retention.js';
import {readRegistry,renameProfile,selectProfile,upsertProfile,setProfileRemote} from '../src/profiles.js';
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

test('incomplete legacy cloud profile can return to local mode without losing identity',()=>{const storage=mock();const p=readRegistry(storage);setProfileRemote(p.active,true,storage);assert.equal(readRegistry(storage).profiles[0].remote,true);setProfileRemote(p.active,false,storage);assert.equal(readRegistry(storage).profiles[0].remote,false);assert.equal(readRegistry(storage).active,p.active);});

import {ProfileRegistryCorruptError,candidateRegistry,recoverRegistry} from '../src/profiles.js';
test('damaged profile registry is never replaced silently',()=>{
 const examples=['{bad JSON','{"version":2,"profiles":[]}',JSON.stringify({version:1,active:'a',legacyId:'a',profiles:[{id:'a',name:'A'},{id:'a',name:'Duplicate'}]})];
 for(const raw of examples){const storage=mock();storage.setItem('pwa.profiles.v1',raw);
  assert.throws(()=>readRegistry(storage),ProfileRegistryCorruptError);
  assert.equal(storage.getItem('pwa.profiles.v1'),raw);
 }
});
test('recovery rescues recognizable IndexedDB identities and preserves raw metadata',()=>{
 const storage=mock(),raw='{bad';storage.setItem('pwa.profiles.v1',raw);
 const candidate=candidateRegistry(raw,['ciyan-mandarin','ciyan-mandarin-profile-recovered_1']);
 assert.equal(candidate.profiles.length,2);assert(candidate.profiles.some(p=>p.id==='recovered_1'));
 recoverRegistry(candidate,storage);
 assert.equal(storage.getItem('pwa.profiles.v1.recovery-source'),raw);
 assert.deepEqual(readRegistry(storage),candidate);
});
test('recovery handles an inconsistent but parseable legacy registry',()=>{
 const raw=JSON.stringify({version:1,active:'missing',legacyId:'legacy',profiles:[{id:'legacy',name:'Original'},{id:'profile2',name:'Study'}]});
 const candidate=candidateRegistry(raw,['ciyan-mandarin','ciyan-mandarin-profile-profile2']);
 assert.equal(candidate.active,'legacy');assert.equal(candidate.profiles.length,2);
});
