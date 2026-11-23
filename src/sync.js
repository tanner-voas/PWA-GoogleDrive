import {api} from './profiles.js';
/** Cloud snapshots are immutable JSON sections addressed by SHA-256. */
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export const hex=bytes=>[...new Uint8Array(bytes)].map(b=>b.toString(16).padStart(2,'0')).join('');
export async function checksum(text){return hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)));}
const SESSION_KEY='pwa.sync.v1';
export function getSyncCursor(profileId,appId){try{return JSON.parse(localStorage.getItem(`${SESSION_KEY}:${profileId}:${appId}`)||'null');}catch{return null;}}
export function setSyncCursor(profileId,appId,cursor){localStorage.setItem(`${SESSION_KEY}:${profileId}:${appId}`,JSON.stringify(cursor));}
const CHUNK_SIZE=128;
function keyHash(s){let n=2166136261;for(let i=0;i<s.length;i++){n^=s.charCodeAt(i);n=Math.imul(n,16777619);}return (n>>>0)%32;}
export async function splitBackup(backup){
 if(!backup||!backup.state||typeof backup.state!=='object')throw Error('Cannot synchronize an incomplete backup');
 const sections={},payloads={},layout={};
 const add=async(key,data)=>{const content=JSON.stringify(data===undefined?null:data),hash=await checksum(content);sections[key]=hash;payloads[hash]=content;};
 for(const [key,data] of Object.entries(backup.state)){
  if(!/^[a-zA-Z0-9_-]{1,55}$/.test(key))throw Error('Invalid backup section');
  if(Array.isArray(data)&&data.length>CHUNK_SIZE){
   layout[key]={type:'array',count:data.length,parts:Math.ceil(data.length/CHUNK_SIZE)};
   for(let i=0;i<layout[key].parts;i++)await add(`${key}_${i}`,data.slice(i*CHUNK_SIZE,(i+1)*CHUNK_SIZE));
  }else if(key==='schedules'||key==='skillSchedules'||key==='postponed'){
   // Per-key deterministic buckets prevent unrelated schedule changes from reuploading.
   const buckets=Array.from({length:32},()=>({}));
   for(const [k,v] of Object.entries(data||{}))buckets[keyHash(k)][k]=v;
   layout[key]={type:'buckets',parts:32};
   for(let i=0;i<32;i++)await add(`${key}_${i}`,buckets[i]);
  }else{layout[key]={type:'scalar'};await add(key,data);}
 }
 return {sections,payloads,meta:{format:backup.format,version:backup.version,appVersion:backup.appVersion,layout}};
}
export function reconstructBackup(revision,entries){
 const layout=revision.meta.layout||{},state={};
 if(!Object.keys(layout).length)return {format:revision.meta.format,version:revision.meta.version,appVersion:revision.meta.appVersion,state:Object.fromEntries(entries)};
 for(const [key,spec] of Object.entries(layout)){
  if(spec.type==='scalar')state[key]=entries[key];
  else if(spec.type==='array'){
   const parts=[];for(let i=0;i<spec.parts;i++){if(!Array.isArray(entries[`${key}_${i}`]))throw Error('Missing history partition');parts.push(...entries[`${key}_${i}`]);}
   if(parts.length!==spec.count)throw Error('Incomplete history partition');state[key]=parts;
  }else if(spec.type==='buckets'){
   const parts={};for(let i=0;i<spec.parts;i++){const chunk=entries[`${key}_${i}`];if(!chunk||Array.isArray(chunk))throw Error('Missing dictionary partition');Object.assign(parts,chunk);}state[key]=parts;
  }else throw Error('Unsupported backup partition');
 }
 return {format:revision.meta.format,version:revision.meta.version,appVersion:revision.meta.appVersion,state};
}
export async function fetchRevision(profileId,appId){return api(`/profiles/${profileId}/apps/${appId}/head`);}
export async function downloadBackup(profileId,appId,revision){
 if(!revision?.sections)throw Error('No cloud backup exists for this app');
 const entries=await Promise.all(Object.entries(revision.sections).map(async([key,hash])=>[key,(await api(`/objects/${hash}`)).value]));
 return reconstructBackup(revision,Object.fromEntries(entries));
}
/** Return committed, unchanged, or divergent. Network failures never produce forks. */
export async function uploadBackup(profileId,appId,backup,cursor){
 const data=await splitBackup(backup);const revisionId=crypto.randomUUID(),operationId=cursor?.pendingOperationId||crypto.randomUUID();
 const remote=await fetchRevision(profileId,appId);
 // On reconnect, verify the last known parent; if it changed, let caller fork.
 const expected=cursor?.head??null;
 if(remote.head?.id!==expected){
  if(remote.head?.operationId===operationId)return {status:'committed',head:remote.head,stale:JSON.stringify(remote.head.sections)!==JSON.stringify(data.sections)};
  return {status:'divergent',head:remote.head,expected};
 }
 if(remote.head&&JSON.stringify(remote.head.sections)===JSON.stringify(data.sections))return {status:'unchanged',head:remote.head};
 const known=new Set(Object.values(remote.head?.sections||{}));
 for(const [hash,content] of Object.entries(data.payloads)){
  if(known.has(hash))continue;
  await api(`/objects/${hash}`,{method:'PUT',headers:{'Content-Type':'application/json','X-PWA-CSRF':'1'},body:content});
 }
 const revision={format:1,id:revisionId,operationId,parent:expected,sections:data.sections,meta:data.meta,at:new Date().toISOString()};
 try{const done=await api(`/profiles/${profileId}/apps/${appId}/commit`,{method:'POST',body:JSON.stringify({expected,revision})});return {status:'committed',head:done.head};}
 catch(error){if(error.status===409)return {status:'divergent',head:error.details.head,expected};throw error;}
}
/** Debounced; only one upload at a time; retries retain the same operation ID. */
export function createSyncScheduler({profileId,appId,readBackup,onStatus,onDivergence}){
 let timer=null,maxTimer=null,running=false,dirty=false,stopped=false,lastRun=0,failures=0;
 let cursor=getSyncCursor(profileId,appId)||{head:null,localRevision:null,pendingOperationId:null};
 const publish=(phase,extra={})=>onStatus?.({phase,...extra});
 const persist=()=>setSyncCursor(profileId,appId,cursor);
 async function flush(){if(stopped||running||!dirty)return;if(!cursor.pendingOperationId){cursor.pendingOperationId=crypto.randomUUID();persist();}clearTimeout(timer);clearTimeout(maxTimer);maxTimer=null;running=true;dirty=false;publish('syncing');
  try{
   const input=await readBackup(),result=await uploadBackup(profileId,appId,input.backup,cursor);
   if(result.status==='divergent'){
    // Do not fork on an error, timeout, or merely stale local metadata.
    // Caller must verify remote and local revisions and complete the fork atomically.
    publish('conflict');await onDivergence?.(result,input,cursor);return;
   }
   cursor={head:result.head?.id||null,localRevision:result.stale?-1:input.revision,pendingOperationId:null};persist();failures=0;lastRun=Date.now();if(result.stale){dirty=true;publish('pending');}else publish('synced',{revision:input.revision});
  }catch(error){dirty=true;failures++;publish('error',{error});}
  finally{running=false;if(dirty&&!stopped){if(!cursor.pendingOperationId){cursor.pendingOperationId=crypto.randomUUID();persist();}schedule(failures?Math.min(60000,2000*2**Math.min(failures,5)):4000);}}
 }
 function schedule(ms=5000){if(stopped)return;clearTimeout(timer);timer=setTimeout(flush,ms);}
 function changed(){if(stopped)return;dirty=true;if(!cursor.pendingOperationId){cursor.pendingOperationId=crypto.randomUUID();persist();}schedule(5000);if(!maxTimer)maxTimer=setTimeout(()=>void flush(),60000);}
 async function now(){if(stopped)return;dirty=true;clearTimeout(timer);clearTimeout(maxTimer);await flush();}
 function stop(){stopped=true;clearTimeout(timer);clearTimeout(maxTimer);}
 return {changed,now,stop,flush,get cursor(){return cursor;}};
}
