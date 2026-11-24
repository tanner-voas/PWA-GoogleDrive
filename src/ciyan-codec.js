import {checksum} from './backup-hash.js';

/** Ciyan's existing wire layout, including all historical reader partitions. */
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

export const ciyanCodec=Object.freeze({appId:'ciyan',splitBackup,reconstructBackup});
