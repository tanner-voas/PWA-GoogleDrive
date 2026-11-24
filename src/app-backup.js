import {checksum} from './backup-hash.js';
import {checkRevision} from './retention.js';
import {api} from './profiles.js';
import {createSyncScheduler,downloadBackup,fetchRevision,sameMap} from './sync.js';

const APP=/^[a-z][a-z0-9-]{0,31}$/;
const ID=/^[A-Za-z0-9_-]{1,80}$/;
const MAX_BYTES=16*1024*1024;
const CACHE_CHARS=8*1024*1024;
const reserved=new Set(['__proto__','prototype','constructor']);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const safeId=(value,label)=>{if(typeof value!=='string'||!ID.test(value)||reserved.has(value))throw Error(`Invalid ${label}`);return value;};
const revisionNumber=value=>{if(!Number.isSafeInteger(value)||value<0)throw Error('Invalid local revision');return value;};

// JSON-only contract: fail rather than silently drop unsupported values or turn
// NaN/Infinity into null. App adapters must convert binary/checkpoint data first.
function jsonText(value){
 const active=new Set();
 function inspect(item){
  if(item===null||typeof item==='string'||typeof item==='boolean'||typeof item==='number'&&Number.isFinite(item))return;
  if(!Array.isArray(item)&&!object(item))throw Error('Backup values must be plain JSON');
  if(active.has(item))throw Error('Circular backup data');
  active.add(item);
  if(Array.isArray(item)){
   if(Object.keys(item).length!==item.length)throw Error('Sparse or extended backup array');
   for(let i=0;i<item.length;i++){if(!Object.hasOwn(item,i))throw Error('Sparse backup array');inspect(item[i]);}
  }else{
   for(const key of Object.keys(item)){if(reserved.has(key))throw Error('Unsafe backup key');inspect(item[key]);}
  }
  if(Reflect.ownKeys(item).some(key=>typeof key==='symbol'||key!=='length'&&(!Object.getOwnPropertyDescriptor(item,key).enumerable||!Object.hasOwn(Object.getOwnPropertyDescriptor(item,key),'value'))))throw Error('Backup values must be plain JSON');
  active.delete(item);
 }
 inspect(value);return JSON.stringify(value);
}
const copyJSON=value=>JSON.parse(jsonText(value));

/** Explicit application-owned snapshot contract. Constructing an adapter has
 * no side effects. It does not create/enable profiles, select a database, or
 * schedule uploads until the application explicitly calls startSync. */
export function createAppBackupAdapter({appId,format,version,partition,assemble,validate,readSnapshot,restore}={}){
 if(typeof appId!=='string'||!APP.test(appId)||appId==='ciyan')throw Error('Invalid or reserved app identity');
 if(typeof format!=='string'||!format||format.length>80||!Number.isSafeInteger(version)||version<1)throw Error('Invalid backup schema');
 for(const [name,fn] of Object.entries({partition,assemble,validate,readSnapshot,restore}))if(typeof fn!=='function')throw Error(`Missing backup adapter callback: ${name}`);
 async function validateBackup(backup){
  if(!object(backup)||backup.format!==format||backup.version!==version||typeof backup.appVersion!=='string'||!backup.appVersion||backup.appVersion.length>80||!Object.hasOwn(backup,'state'))throw Error('Backup schema does not match this app');
  if(Object.keys(backup).some(key=>!['format','version','appVersion','state'].includes(key)))throw Error('Unexpected backup envelope field');
  if(await validate(backup.state)===false)throw Error('Application rejected backup state');
 }
 function validateRevision(revision){
  checkRevision(revision);
  const meta=revision.meta;
  if(!object(meta)||meta.format!==format||meta.version!==version||typeof meta.appVersion!=='string'||!meta.appVersion||meta.appVersion.length>80||meta.adapter?.appId!==appId||meta.adapter?.schema!==1||!Object.hasOwn(meta,'layout'))throw Error('Cloud backup schema does not match this app');
  const keys=Object.keys(revision.sections);
  if(!keys.length||keys.some(key=>reserved.has(key)))throw Error('Invalid cloud backup sections');
  jsonText(meta.layout);
 }
 async function splitBackup(backup,{cache}={}){
  // Detach before awaiting app validation/partition: later local edits must
  // never alter the revision being hashed and sent.
  const snapshot=copyJSON(backup);await validateBackup(snapshot);
  const plan=await partition(snapshot.state);
  if(!object(plan)||!object(plan.sections)||!Object.hasOwn(plan,'layout'))throw Error('Invalid partition plan');
  const layout=copyJSON(plan.layout),keys=Object.keys(plan.sections).sort();
  if(!keys.length)throw Error('Empty backup partition plan');
  const prepared=keys.map(key=>{
   safeId(key,'backup section');const content=jsonText(plan.sections[key]);
   if(new TextEncoder().encode(content).length>MAX_BYTES)throw Error('Backup section exceeds 16 MiB; partition it in the app adapter');
   return [key,content];
  });
  const sections={},payloads={},next=new Map();let cached=0;
  const stats={serialized:prepared.length,hashed:0,reusedHashes:0,identityReused:0};
  for(const [key,content] of prepared){
   const old=cache?.sections.get(key);let entry;
   if(old?.content===content){entry=old;stats.reusedHashes++;}else{entry={content,hash:await checksum(content)};stats.hashed++;}
   sections[key]=entry.hash;payloads[entry.hash]=content;
   if(cache&&cached+content.length<=CACHE_CHARS){next.set(key,entry);cached+=content.length;}
  }
  if(cache){cache.sections=next;cache.fields=new Map();}
  return {sections,payloads,stats,meta:{format,version,appVersion:snapshot.appVersion,layout,adapter:{appId,schema:1}}};
 }
 async function reconstructBackup(revision,entries){
  validateRevision(revision);
  const keys=Object.keys(revision.sections);
  if(!object(entries)||Object.keys(entries).length!==keys.length||keys.some(key=>!Object.hasOwn(entries,key)))throw Error('Incomplete backup sections');
  const state=await assemble(copyJSON(entries),copyJSON(revision.meta.layout));
  const backup=copyJSON({format,version,appVersion:revision.meta.appVersion,state});
  // An app decoder must not silently discard a required section. Repartition
  // the restored state before it can reach a local restore transaction.
  const rebuilt=await splitBackup(backup);
  if(!sameMap(rebuilt.sections,revision.sections)||JSON.stringify(rebuilt.meta)!==JSON.stringify(revision.meta))throw Error('Backup failed partition round-trip verification');
  return backup;
 }
 const codec=Object.freeze({appId,splitBackup,reconstructBackup,validateRevision});
 function startSync({profileId,onStatus,onDivergence}={}){
  safeId(profileId,'profile ID');
  return createSyncScheduler({profileId,appId,codec,onStatus,onDivergence,readBackup:async()=>{
   const input=await readSnapshot({profileId});revisionNumber(input?.revision);
   return {revision:input.revision,backup:input.backup};
  }});
 }
 async function downloadRevision({profileId,revisionId,onProgress}={}){
  safeId(profileId,'profile ID');
  let revision;
  if(revisionId===undefined){({head:revision}=await fetchRevision(profileId,appId));}
  else{safeId(revisionId,'revision ID');({revision}=await api(`/profiles/${profileId}/apps/${appId}/revisions/${revisionId}`,{telemetryApp:appId}));if(revision?.id!==revisionId)throw Error('Cloud returned a different revision');}
  if(!revision)throw Error('No cloud backup exists for this app');
  const backup=await downloadBackup(profileId,appId,revision,onProgress,{codec});
  return {revision,backup};
 }
 async function restoreRevision({profileId,revisionId,expectedRevision,onProgress}={}){
  // Explicit history selection and compare-and-swap token are mandatory. The
  // app must implement atomic restore in its own storage, not in this library.
  safeId(revisionId,'revision ID');revisionNumber(expectedRevision);
  const {backup,revision}=await downloadRevision({profileId,revisionId,onProgress});
  if(await restore({profileId,backup,expectedRevision,revisionId:revision.id})===false)throw Error('Application rejected local restore');
  // Restoring history is not a new cloud commit or a verified sync cursor.
  return {revision,backup};
 }
 return Object.freeze({appId,codec,startSync,downloadRevision,restoreRevision});
}
