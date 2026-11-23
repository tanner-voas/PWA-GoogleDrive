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
export async function splitBackup(backup){
 if(!backup||!backup.state||typeof backup.state!=='object')throw Error('Cannot synchronize an incomplete backup');
 const sections={},payloads={},layout={};
 const add=async(key,data)=>{const content=JSON.stringify(data===undefined?null:data),hash=await checksum(content);sections[key]=hash;payloads[hash]=content;};
 for(const [key,data] of Object.entries(backup.state)){
  if(!/^[a-zA-Z0-9_-]{1,55}$/.test(key))throw Error('Invalid backup section');
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
/** Return committed, unchanged, or divergent. Network failures never produce forks. */
export async function uploadBackup(profileId,appId,backup,cursor,{onProgress=()=>{}}={}){
 const data=await splitBackup(backup);const revisionId=cursor?.pendingRevisionId||crypto.randomUUID(),operationId=cursor?.pendingOperationId||crypto.randomUUID();
 const remote=await fetchRevision(profileId,appId);
 // On reconnect, verify the last known parent; if it changed, let caller fork.
 const expected=cursor?.head??null;
 if((remote.head?.id??null)!==expected){
  if(remote.head?.operationId===operationId)return {status:'committed',head:remote.head,stale:JSON.stringify(remote.head.sections)!==JSON.stringify(data.sections)};
  return {status:'divergent',head:remote.head,expected};
 }
 if(remote.head&&JSON.stringify(remote.head.sections)===JSON.stringify(data.sections))return {status:'unchanged',head:remote.head};
 const known=new Set(Object.values(remote.head?.sections||{}));
 const pending=Object.entries(data.payloads).filter(([hash])=>!known.has(hash));
 const batches=[];let batch=[],bytes=0;
 for(const [hash,content] of pending){
  const size=new TextEncoder().encode(content).length;
  if(size>16*1024*1024)throw Error('Backup section exceeds 16 MiB');
  if(batch.length&&(batch.length>=12||bytes+size>512*1024)){batches.push(batch);batch=[];bytes=0;}
  batch.push({hash,content});bytes+=size;
 }
 if(batch.length)batches.push(batch);
 let completed=0;
 onProgress({completed,total:pending.length,stage:'uploading'});
 // Worker validates all hashes and stores each batch before acknowledging it.
 for(const group of batches){
  await api('/objects/batch',{method:'POST',body:JSON.stringify({objects:group})});
  completed+=group.length;onProgress({completed,total:pending.length,stage:'uploading'});
 }
 onProgress({completed,total:pending.length,stage:'committing'});
 const revision={format:1,id:revisionId,operationId,parent:expected,sections:data.sections,meta:data.meta,at:new Date().toISOString()};
 try{const done=await api(`/profiles/${profileId}/apps/${appId}/commit`,{method:'POST',body:JSON.stringify({expected,revision})});return {status:'committed',head:done.head};}
 catch(error){if(error.status===409)return {status:'divergent',head:error.details.head,expected};throw error;}
}
/** Debounced sync, visible progress and a truthful manual completion result. */
export function createSyncScheduler({profileId,appId,readBackup,onStatus,onDivergence}){
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
    // The previous attempt may have staged a different snapshot. Never reuse
    // its immutable revision name for a newly edited local snapshot.
    cursor.pendingOperationId=crypto.randomUUID();cursor.pendingRevisionId=crypto.randomUUID();
   }
   cursor.pendingLocalRevision=input.revision;persist();
   const result=await uploadBackup(profileId,appId,input.backup,{...cursor},{onProgress:progress=>publish('syncing',progress)});
   if(result.status==='divergent'){
    publish('conflict');await onDivergence?.(result,input,cursor);
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
  publish('pending');
 }
 async function now({force=false}={}){
  if(stopped)throw Error('Synchronization is stopped');
  if(running){await running;}
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
