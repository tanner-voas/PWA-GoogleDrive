import {queueBackupTelemetry,telemetryScope} from './network-telemetry.js';
import {api} from './profiles.js';
/** Cloud snapshots are immutable JSON sections addressed by SHA-256. */
export {hex,checksum} from './backup-hash.js';
import {ciyanCodec,createBackupCache} from './ciyan-codec.js';
// Preserve the existing Ciyan imports and serialized backup layout.
export {splitBackup,reconstructBackup,createBackupCache} from './ciyan-codec.js';

function resolveCodec(appId,codec){
 const selected=codec??(appId==='ciyan'?ciyanCodec:null);
 if(!selected||selected.appId!==appId||typeof selected.splitBackup!=='function'||typeof selected.reconstructBackup!=='function')throw Error('An explicit backup codec is required for this app');
 return selected;
}
const SESSION_KEY='pwa.sync.v1';
export function getSyncCursor(profileId,appId){try{return JSON.parse(localStorage.getItem(`${SESSION_KEY}:${profileId}:${appId}`)||'null');}catch{return null;}}
export function setSyncCursor(profileId,appId,cursor){localStorage.setItem(`${SESSION_KEY}:${profileId}:${appId}`,JSON.stringify(cursor));}
export async function fetchRevision(profileId,appId){return api(`/profiles/${profileId}/apps/${appId}/head`);}
export async function downloadBackup(profileId,appId,revision,onProgress=()=>{},{codec}={}){
 const selected=resolveCodec(appId,codec);
 selected.validateRevision?.(revision);
 if(!revision?.sections)throw Error('No cloud backup exists for this app');
 const hashes=[...new Set(Object.values(revision.sections))],values={};
 for(let i=0;i<hashes.length;i+=8){
  const group=hashes.slice(i,i+8);
  const response=await api('/objects/read-batch',{method:'POST',body:JSON.stringify({hashes:group}),telemetryApp:appId});
  for(const hash of group){
   if(!Object.hasOwn(response.objects??{},hash))throw Error('Missing backup section');
   values[hash]=response.objects[hash];
  }
  onProgress({completed:Math.min(i+8,hashes.length),total:hashes.length,stage:'downloading'});
 }
 const entries=Object.fromEntries(Object.entries(revision.sections).map(([key,hash])=>[key,values[hash]]));
 return selected.reconstructBackup(revision,entries);
}
// Store a small, content-free diagnostic history per local profile. Storage
// quota/privacy errors must never prevent a successful backup from completing.
const diagnosticKey=(profileId,appId)=>`pwa.sync.metrics.v1:${profileId}:${appId}`;
export function syncDiagnostics(profileId,appId){try{const value=JSON.parse(localStorage.getItem(diagnosticKey(profileId,appId))||'[]');return Array.isArray(value)?value.filter(entry=>entry&&typeof entry==='object'&&typeof entry.at==='string'&&['committed','unchanged','divergent','error'].includes(entry.status)).slice(0,10):[];}catch{return [];}}
function rememberDiagnostic(profileId,appId,entry){try{localStorage.setItem(diagnosticKey(profileId,appId),JSON.stringify([entry,...syncDiagnostics(profileId,appId)].slice(0,10)));}catch{}}
export const sameMap=(a,b)=>Object.keys(a||{}).length===Object.keys(b||{}).length&&Object.entries(a||{}).every(([k,v])=>b?.[k]===v);
/** Recognize a successful write whose acknowledgement was lost. Only the
 * exact durable pending operation and its parent can advance our cursor. */
export function reconcilePendingCommit(cursor,head){
 if(!cursor?.pendingOperationId||!cursor.pendingRevisionId||!Number.isSafeInteger(cursor.pendingLocalRevision)||cursor.pendingLocalRevision<0||
    head?.operationId!==cursor.pendingOperationId||head.id!==cursor.pendingRevisionId||(head.parent??null)!==(cursor.head??null))return null;
 return {head:head.id,localRevision:cursor.pendingLocalRevision,pendingOperationId:null,pendingRevisionId:null,pendingLocalRevision:null};
}
/** Return committed, unchanged, or divergent. Network failures never produce forks. */
export async function uploadBackup(profileId,appId,backup,cursor,{onProgress=()=>{},cache,codec}={}){
 const selected=resolveCodec(appId,codec);
 const started=Date.now(),scope=telemetryScope(),metrics={at:new Date(started).toISOString(),status:'error',sections:0,changed:0,reused:0,payloadBytes:0,objectsSent:0,objectsCreated:null,requests:0,driveCalls:null,driveRetries:null,indexHits:null,indexMisses:null,objectScans:null,hashed:0,hashesReused:0,serialized:0,identityReused:0,preflightReused:0,prepareMs:0,headMs:0,preflightMs:0,uploadMs:0,commitMs:0};
 const collect=response=>{for(const key of ['driveCalls','driveRetries','indexHits','indexMisses','objectScans']){
  const raw=response.headers.get(`X-PWA-${key}`);if(raw!==null&&/^\d+$/.test(raw))metrics[key]=(metrics[key]??0)+Number(raw);
 }};
 const call=async(path,opts={})=>{metrics.requests++;const start=Date.now();
  const metric=path.endsWith('/head')?'headMs':path.endsWith('/commit')?'commitMs':path==='/objects/missing'?'preflightMs':'uploadMs';
  try{return await api(path,{...opts,telemetryApp:appId,onResponse:collect});}finally{metrics[metric]+=Date.now()-start;}
 };
 const finish=result=>{metrics.status=result.status;return result;};
 try{
  const data=await selected.splitBackup(backup,{cache});metrics.prepareMs=Date.now()-started;
  const revisionId=cursor?.pendingRevisionId||crypto.randomUUID(),operationId=cursor?.pendingOperationId||crypto.randomUUID();
  metrics.sections=Object.keys(data.sections).length;metrics.hashed=data.stats.hashed;metrics.hashesReused=data.stats.reusedHashes;metrics.serialized=data.stats.serialized;metrics.identityReused=data.stats.identityReused;
  const remote=await call(`/profiles/${profileId}/apps/${appId}/head`),expected=cursor?.head??null;
  if(remote.head)selected.validateRevision?.(remote.head);
  const known=new Set(Object.values(remote.head?.sections||{}));
  metrics.changed=Object.values(data.sections).filter(hash=>!known.has(hash)).length;metrics.reused=metrics.sections-metrics.changed;
  if((remote.head?.id??null)!==expected){
   if(remote.head?.operationId===operationId&&(!selected.validateRevision||reconcilePendingCommit(cursor,remote.head)))return finish({status:'committed',head:remote.head,stale:!sameMap(remote.head.sections,data.sections)||!!selected.validateRevision&&JSON.stringify(remote.head.meta)!==JSON.stringify(data.meta)});
   return finish({status:'divergent',head:remote.head,expected});
  }
  if(remote.head&&sameMap(remote.head.sections,data.sections)&&JSON.stringify(remote.head.meta??data.meta)===JSON.stringify(data.meta))return finish({status:'unchanged',head:remote.head});
  let pending=Object.keys(data.payloads).filter(hash=>!known.has(hash));
  // An initial push or a large import may reuse objects in another profile or
  // retained history. Ask once in bounded groups rather than send them again.
  // Small routine changes skip the extra round trip. Older Workers return 404.
  if(pending.length>=12||pending.some(h=>data.payloads[h].length>512*1024)){
   const missing=[];let supported=true;
   for(let i=0;i<pending.length;i+=128){const group=pending.slice(i,i+128);
    try{const result=await call('/objects/missing',{method:'POST',body:JSON.stringify({hashes:group})});
     if(!Array.isArray(result.missing)||result.missing.some(h=>!group.includes(h)))throw Error('Invalid object availability response');
     missing.push(...new Set(result.missing));
    }catch(e){if(e.status===404){supported=false;break;}throw e;}
   }
   if(supported){metrics.preflightReused=pending.length-missing.length;pending=missing;}
  }
  async function send(hashes){
   const batches=[];let batch=[],bytes=0;
   for(const hash of hashes){const content=data.payloads[hash],size=new TextEncoder().encode(content).length;
    if(size>16*1024*1024)throw Error('Backup section exceeds 16 MiB');
    if(batch.length&&(batch.length>=12||bytes+size>512*1024)){batches.push(batch);batch=[];bytes=0;}
    batch.push({hash,content,size});bytes+=size;
   }
   if(batch.length)batches.push(batch);
   let completed=0;onProgress({completed,total:hashes.length,stage:'uploading'});
   for(const group of batches){
    metrics.payloadBytes+=group.reduce((n,x)=>n+x.size,0);metrics.objectsSent+=group.length;
    // The batch endpoint allows only 1 MiB; a large independent chapter uses
    // the existing single-object PUT endpoint (16 MiB), not an oversized batch.
    const result=group.length===1&&group[0].size>512*1024
     ?await call(`/objects/${group[0].hash}`,{method:'PUT',body:group[0].content})
     :await call('/objects/batch',{method:'POST',body:JSON.stringify({objects:group.map(({hash,content})=>({hash,content}))})});
    if(Number.isInteger(result.created)&&result.created>=0)metrics.objectsCreated=(metrics.objectsCreated??0)+result.created;
    completed+=group.length;onProgress({completed,total:hashes.length,stage:'uploading'});
   }
   onProgress({completed,total:hashes.length,stage:'committing'});
  }
  await send(pending);
  const revision={format:1,id:revisionId,operationId,parent:expected,sections:data.sections,meta:data.meta,at:new Date().toISOString()};
  const commit=()=>call(`/profiles/${profileId}/apps/${appId}/commit`,{method:'POST',body:JSON.stringify({expected,revision})});
  try{
   let done;try{done=await commit();}catch(error){
    // Index reconciliation can discover an externally deleted object reused by
    // the head. Repair only hashes in our own snapshot, never arbitrary data.
    const missing=error.details?.missingHashes;
    if(error.status!==422||!Array.isArray(missing)||!missing.length||missing.some(h=>!Object.hasOwn(data.payloads,h)))throw error;
    await send([...new Set(missing)]);done=await commit();
   }
   if(selected.validateRevision){
    selected.validateRevision(done.head);
    if(done.head.id!==revision.id||done.head.operationId!==revision.operationId||(done.head.parent??null)!==expected||!sameMap(done.head.sections,data.sections)||JSON.stringify(done.head.meta)!==JSON.stringify(data.meta))throw Error('Cloud did not confirm the requested backup revision');
   }
   return finish({status:'committed',head:done.head});
  }catch(error){
   if(error.status===409){
    const head=error.details?.head;
    // A staged immutable-revision collision is not a confirmed changed head.
    if(selected.validateRevision){if(!head||head.id===expected)throw error;selected.validateRevision(head);}
    return finish({status:'divergent',head,expected});
   }
   throw error;
  }
 }catch(error){metrics.httpStatus=Number.isInteger(error.status)?error.status:null;throw error;}
 finally{if(!metrics.objectsSent)metrics.objectsCreated=0;metrics.durationMs=Date.now()-started;rememberDiagnostic(profileId,appId,metrics);queueBackupTelemetry(appId,{...metrics,appVersion:backup?.appVersion},scope);}
}
/** Debounced sync, visible progress and a truthful manual completion result. */
export function createSyncScheduler({profileId,appId,readBackup,onStatus,onDivergence,immutableFields=[],codec}){
 const selected=resolveCodec(appId,codec);
 const cache=createBackupCache({immutableFields});
 let timer=null,maxTimer=null,running=null,dirty=false,stopped=false,failures=0;
 let cursor=getSyncCursor(profileId,appId)||{head:null,localRevision:null,pendingOperationId:null,pendingRevisionId:null,pendingLocalRevision:null};
 const publish=(phase,extra={})=>onStatus?.({phase,...extra});
 const persist=()=>setSyncCursor(profileId,appId,cursor);
 function schedule(ms=5000){if(stopped)return;clearTimeout(timer);timer=setTimeout(()=>{void flush().catch(()=>{});},ms);}
 async function execute(){
  if(stopped)throw Error('Synchronization is stopped');
  dirty=false;publish('syncing');
  try{
   const input=await readBackup();
   if(cursor.pendingLocalRevision!==null&&cursor.pendingLocalRevision!==undefined&&cursor.pendingLocalRevision!==input.revision){
    // A previous commit may already be durable even if its response was lost.
    // Confirm that receipt BEFORE retiring its operation/revision identifiers.
    // If the head is unrelated, ordinary CAS/divergence handling still applies.
    if(cursor.pendingOperationId&&cursor.pendingRevisionId){
     const {head}=await fetchRevision(profileId,appId);
     if(head)selected.validateRevision?.(head);
     const confirmed=reconcilePendingCommit(cursor,head);
     if(confirmed){cursor=confirmed;persist();}
    }
    // Never reuse an immutable revision name for a different snapshot.
    cursor.pendingOperationId=crypto.randomUUID();cursor.pendingRevisionId=crypto.randomUUID();
   }
   cursor.pendingLocalRevision=input.revision;persist();
   const result=await uploadBackup(profileId,appId,input.backup,{...cursor},{cache,codec:selected,onProgress:progress=>publish('syncing',progress)});
   if(result.status==='divergent'){
    publish('conflict');const resolution=await onDivergence?.(result,input,cursor);
    if(resolution?.cursor){cursor=resolution.cursor;persist();failures=0;
     if(dirty||cursor.localRevision!==input.revision){dirty=true;publish('pending');return {status:'pending'};}
     publish('synced',{revision:input.revision});return {status:'unchanged',head:{id:cursor.head}};}
    if(resolution?.retry)throw Error('Cloud revision could not be confirmed; synchronization will retry.');
    return {status:'conflict'};
   }
   cursor={head:result.head?.id||null,localRevision:result.stale?-1:input.revision,pendingOperationId:null,pendingRevisionId:null,pendingLocalRevision:null};
   persist();failures=0;
   if(result.stale||dirty){dirty=true;publish('pending');}
   else publish('synced',{revision:input.revision});
   return {status:dirty?'pending':result.status,head:result.head};
  }catch(error){dirty=true;failures++;publish('error',{error});throw error;}
  finally{if(dirty&&!stopped)schedule(failures?Math.min(60000,2000*2**Math.min(failures,5)):4000);}
 }
 function flush(){
  if(stopped)return Promise.reject(Error('Synchronization is stopped'));
  if(running)return running;
  if(!dirty)return Promise.resolve({status:'unchanged',head:cursor.head});
  if(!cursor.pendingOperationId){cursor.pendingOperationId=crypto.randomUUID();cursor.pendingRevisionId=crypto.randomUUID();cursor.pendingLocalRevision=null;persist();}
  else if(!cursor.pendingRevisionId){cursor.pendingRevisionId=crypto.randomUUID();persist();}
  clearTimeout(timer);clearTimeout(maxTimer);maxTimer=null;
  running=execute().finally(()=>{running=null;});
  return running;
 }
 function changed(){
  if(stopped)return;
  dirty=true;
  if(!cursor.pendingOperationId){cursor.pendingOperationId=crypto.randomUUID();cursor.pendingRevisionId=crypto.randomUUID();cursor.pendingLocalRevision=null;persist();}
  else if(!cursor.pendingRevisionId){cursor.pendingRevisionId=crypto.randomUUID();persist();}
  schedule();if(!maxTimer)maxTimer=setTimeout(()=>{void flush().catch(()=>{});},60000);
  if(!running)publish('pending');
 }
 async function now({force=false}={}){
  if(stopped)throw Error('Synchronization is stopped');
  if(running){const active=await running;if(active.status==='conflict')throw Error('A different cloud revision was found; local data was preserved');}
  // Home/Refresh must not issue a network request when local data is already
  // confirmed. The manual Sync button may still explicitly check the head.
  if(!dirty&&!force)return {status:'unchanged',head:cursor.head};
  if(force&&!dirty)dirty=true;
  const result=await flush();
  if(result.status==='conflict')throw Error('A different cloud revision was found; local data was preserved');
  if(result.status==='pending')return now(); // Retry a newer local revision after a lost response.
  return result;
 }
 function stop(){stopped=true;clearTimeout(timer);clearTimeout(maxTimer);}
 return {changed,now,stop,flush,get cursor(){return cursor;}};
}
