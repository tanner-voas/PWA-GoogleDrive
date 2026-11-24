import {api} from './profiles.js';
/** Cloud snapshots are immutable JSON sections addressed by SHA-256. */
export const hex=bytes=>[...new Uint8Array(bytes)].map(b=>b.toString(16).padStart(2,'0')).join('');
export async function checksum(text){return hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)));}
const SESSION_KEY='pwa.sync.v1';
export function getSyncCursor(profileId,appId){try{return JSON.parse(localStorage.getItem(`${SESSION_KEY}:${profileId}:${appId}`)||'null');}catch{return null;}}
export function setSyncCursor(profileId,appId,cursor){localStorage.setItem(`${SESSION_KEY}:${profileId}:${appId}`,JSON.stringify(cursor));}
const CHUNK_SIZE=128;
function keyHash(s){let n=2166136261;for(let i=0;i<s.length;i++){n^=s.charCodeAt(i);n=Math.imul(n,16777619);}return (n>>>0)%32;}
// Preserve the existing array layout for dictionary and history data: those
// hashes are already separate from settings/progress and remain reusable.
// Reader chapters and nested skill schedules need more granular partitions.
const SKILL_PARTS=16;
// A cache belongs to one scheduler/profile. Only explicitly immutable fields
// may reuse serialization by identity; mutable fields compare actual JSON.
export const createBackupCache=({immutableFields=[]}={})=>({immutableFields:new Set(immutableFields),sections:new Map(),fields:new Map()});
export async function splitBackup(backup,{cache}={}){
 if(!backup||!backup.state||typeof backup.state!=='object')throw Error('Cannot synchronize an incomplete backup');
 const sections={},payloads={},layout={},nextSections=new Map(),nextFields=new Map();
 const stats={serialized:0,hashed:0,reusedHashes:0,identityReused:0};let fieldEntries=[],cachedChars=0;
 const CACHE_CHARS=8*1024*1024; // bound retained serialized data (UTF-16 code units)
 const record=(key,entry)=>{sections[key]=entry.hash;payloads[entry.hash]=entry.content;if(cache&&cachedChars+entry.content.length<=CACHE_CHARS){nextSections.set(key,entry);cachedChars+=entry.content.length;}fieldEntries.push([key,entry]);};
 const add=async(key,data)=>{const content=JSON.stringify(data===undefined?null:data);stats.serialized++;
  const old=cache?.sections.get(key);let entry;
  if(old?.content===content){entry=old;stats.reusedHashes++;}else{entry={content,hash:await checksum(content)};stats.hashed++;}
  record(key,entry);
 };
 for(const [key,data] of Object.entries(backup.state)){
  if(!/^[a-zA-Z0-9_-]{1,55}$/.test(key))throw Error('Invalid backup section');
  fieldEntries=[];
  const immutable=cache?.immutableFields.has(key)&&Array.isArray(data),prior=immutable?cache.fields.get(key):null;
  if(prior?.value===data){layout[key]=prior.layout;for(const [name,entry] of prior.entries){record(name,entry);stats.identityReused++;stats.reusedHashes++;}if(prior.entries.every(([name])=>nextSections.has(name)))nextFields.set(key,prior);continue;}
  if(key==='reader'&&data&&typeof data==='object'&&!Array.isArray(data)){
   const books=[];
   for(const [id,book] of Object.entries(data)){
    if(['__proto__','constructor','prototype'].includes(id))throw Error('Invalid reader ID');
    if(!book||typeof book!=='object'||!Array.isArray(book.chapters))throw Error('Invalid reader book in backup');
    const token=(await checksum(id)).slice(0,24),prefix=`reader_${token}`;
    if(books.some(item=>item.token===token))throw Error('Reader ID hash collision');
    const {chapters,...header}=book;
    // Keep large immutable dictionary/catalog data separate from the small
    // reader cursor and per-chapter bookmark changes.
    const fields=['current','progress','history'].filter(field=>Object.hasOwn(header,field));
    for(const field of fields){await add(`${prefix}_state_${field}`,header[field]);delete header[field];}
    await add(`${prefix}_meta`,header);
    const positions=[];
    for(let i=0;i<chapters.length;i++){
     const {position,...chapter}=chapters[i];
     await add(`${prefix}_${i}_content`,chapter);
     const hasPosition=Object.hasOwn(chapters[i],'position');positions.push(hasPosition);
     if(hasPosition)await add(`${prefix}_${i}_position`,position);
    }
    books.push({id,token,count:chapters.length,fields,positions});
   }
   layout[key]={type:'reader',books};
  }else if(key==='readerContent'&&data&&typeof data==='object'&&!Array.isArray(data)){
   // Optional user-supplied text: one immutable object per chapter digest.
   // The reader's content hash becomes the stable chunk identity.
   const digests=Object.keys(data).sort();
   for(const digest of digests){if(!/^[a-f0-9]{64}$/.test(digest)||typeof data[digest]!=='string')throw Error('Invalid portable reader text');
    await add(`readerText_${digest.slice(0,48)}`,data[digest]);
   }
   layout[key]={type:'reader-text',digests};
  }else if(key==='skillSchedules'&&data&&typeof data==='object'&&!Array.isArray(data)){
   const modes=Object.keys(data);
   layout[key]={type:'mode-buckets',modes,parts:SKILL_PARTS};
   for(const mode of modes){
    if(!/^[a-zA-Z0-9-]{1,32}$/.test(mode))throw Error('Invalid skill mode');
    const buckets=Array.from({length:SKILL_PARTS},()=>({}));
    for(const [id,value] of Object.entries(data[mode]||{}))buckets[keyHash(id)%SKILL_PARTS][id]=value;
    for(let i=0;i<SKILL_PARTS;i++)await add(`${key}_${mode}_${i}`,buckets[i]);
   }
  }else if(Array.isArray(data)&&data.length>CHUNK_SIZE){
   layout[key]={type:'array',count:data.length,parts:Math.ceil(data.length/CHUNK_SIZE)};
   for(let i=0;i<layout[key].parts;i++)await add(`${key}_${i}`,data.slice(i*CHUNK_SIZE,(i+1)*CHUNK_SIZE));
  }else if(key==='schedules'||key==='postponed'){
   const buckets=Array.from({length:32},()=>({}));
   for(const [k,v] of Object.entries(data||{}))buckets[keyHash(k)][k]=v;
   layout[key]={type:'buckets',parts:32};
   for(let i=0;i<32;i++)await add(`${key}_${i}`,buckets[i]);
  }else{layout[key]={type:'scalar'};await add(key,data);}
  if(immutable&&fieldEntries.every(([name])=>nextSections.has(name)))nextFields.set(key,{value:data,layout:layout[key],entries:fieldEntries});
 }
 if(cache){cache.sections=nextSections;cache.fields=nextFields;}
 return {sections,payloads,stats,meta:{format:backup.format,version:backup.version,appVersion:backup.appVersion,layout}};
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
  }else if(spec.type==='reader-text'){
   const content={};
   for(const digest of spec.digests){const text=entries[`readerText_${digest.slice(0,48)}`];if(typeof text!=='string')throw Error('Missing portable reader text');content[digest]=text;}
   state[key]=content;
  }else if(spec.type==='mode-buckets'){
   const modes={};
   for(const mode of spec.modes){const part={};for(let i=0;i<spec.parts;i++){
    const chunk=entries[`${key}_${mode}_${i}`];if(!chunk||Array.isArray(chunk))throw Error('Missing skill schedule partition');Object.assign(part,chunk);
   }modes[mode]=part;}state[key]=modes;
  }else if(spec.type==='reader'){
   const books={};
   for(const {id,token,count,fields=[],positions=[]} of spec.books){
    const header=entries[`reader_${token}_meta`];
    if(!header||typeof header!=='object'||Array.isArray(header))throw Error('Missing reader metadata');
    const chapters=[];
    for(let i=0;i<count;i++){
     const part=entries[`reader_${token}_${i}_content`];if(!part||typeof part!=='object'||Array.isArray(part))throw Error('Missing reader chapter');
     const hasPosition=positions[i];
     const position=entries[`reader_${token}_${i}_position`];
     if(hasPosition&&!Object.hasOwn(entries,`reader_${token}_${i}_position`))throw Error('Missing reader bookmark');
     chapters.push(hasPosition?{...part,position}:part);
    }
    const updated={...header};
    for(const field of fields){
     if(!Object.hasOwn(entries,`reader_${token}_state_${field}`))throw Error('Missing reader state');
     updated[field]=entries[`reader_${token}_state_${field}`];
    }
    books[id]={...updated,chapters};
   }
   state[key]=books;
  }else throw Error('Unsupported backup partition');
 }
 return {format:revision.meta.format,version:revision.meta.version,appVersion:revision.meta.appVersion,state};
}
export async function fetchRevision(profileId,appId){return api(`/profiles/${profileId}/apps/${appId}/head`);}
export async function downloadBackup(profileId,appId,revision,onProgress=()=>{}){
 if(!revision?.sections)throw Error('No cloud backup exists for this app');
 const hashes=[...new Set(Object.values(revision.sections))],values={};
 for(let i=0;i<hashes.length;i+=8){
  const group=hashes.slice(i,i+8);
  const response=await api('/objects/read-batch',{method:'POST',body:JSON.stringify({hashes:group})});
  Object.assign(values,response.objects);
  onProgress({completed:Math.min(i+8,hashes.length),total:hashes.length,stage:'downloading'});
 }
 const entries=Object.fromEntries(Object.entries(revision.sections).map(([key,hash])=>[key,values[hash]]));
 return reconstructBackup(revision,entries);
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
export async function uploadBackup(profileId,appId,backup,cursor,{onProgress=()=>{},cache}={}){
 const started=Date.now(),metrics={at:new Date(started).toISOString(),status:'error',sections:0,changed:0,reused:0,payloadBytes:0,objectsSent:0,objectsCreated:null,requests:0,driveCalls:null,driveRetries:null,indexHits:null,indexMisses:null,objectScans:null,hashed:0,hashesReused:0,serialized:0,identityReused:0,preflightReused:0,prepareMs:0,headMs:0,preflightMs:0,uploadMs:0,commitMs:0};
 const collect=response=>{for(const key of ['driveCalls','driveRetries','indexHits','indexMisses','objectScans']){
  const raw=response.headers.get(`X-PWA-${key}`);if(raw!==null&&/^\d+$/.test(raw))metrics[key]=(metrics[key]??0)+Number(raw);
 }};
 const call=async(path,opts={})=>{metrics.requests++;const start=Date.now();
  const metric=path.endsWith('/head')?'headMs':path.endsWith('/commit')?'commitMs':path==='/objects/missing'?'preflightMs':'uploadMs';
  try{return await api(path,{...opts,onResponse:collect});}finally{metrics[metric]+=Date.now()-start;}
 };
 const finish=result=>{metrics.status=result.status;return result;};
 try{
  const data=await splitBackup(backup,{cache});metrics.prepareMs=Date.now()-started;
  const revisionId=cursor?.pendingRevisionId||crypto.randomUUID(),operationId=cursor?.pendingOperationId||crypto.randomUUID();
  metrics.sections=Object.keys(data.sections).length;metrics.hashed=data.stats.hashed;metrics.hashesReused=data.stats.reusedHashes;metrics.serialized=data.stats.serialized;metrics.identityReused=data.stats.identityReused;
  const remote=await call(`/profiles/${profileId}/apps/${appId}/head`),expected=cursor?.head??null;
  const known=new Set(Object.values(remote.head?.sections||{}));
  metrics.changed=Object.values(data.sections).filter(hash=>!known.has(hash)).length;metrics.reused=metrics.sections-metrics.changed;
  if((remote.head?.id??null)!==expected){
   if(remote.head?.operationId===operationId)return finish({status:'committed',head:remote.head,stale:!sameMap(remote.head.sections,data.sections)});
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
   return finish({status:'committed',head:done.head});
  }catch(error){if(error.status===409)return finish({status:'divergent',head:error.details.head,expected});throw error;}
 }catch(error){metrics.httpStatus=Number.isInteger(error.status)?error.status:null;throw error;}
 finally{if(!metrics.objectsSent)metrics.objectsCreated=0;metrics.durationMs=Date.now()-started;rememberDiagnostic(profileId,appId,metrics);}
}
/** Debounced sync, visible progress and a truthful manual completion result. */
export function createSyncScheduler({profileId,appId,readBackup,onStatus,onDivergence,immutableFields=[]}){
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
     const confirmed=reconcilePendingCommit(cursor,head);
     if(confirmed){cursor=confirmed;persist();}
    }
    // Never reuse an immutable revision name for a different snapshot.
    cursor.pendingOperationId=crypto.randomUUID();cursor.pendingRevisionId=crypto.randomUUID();
   }
   cursor.pendingLocalRevision=input.revision;persist();
   const result=await uploadBackup(profileId,appId,input.backup,{...cursor},{cache,onProgress:progress=>publish('syncing',progress)});
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
