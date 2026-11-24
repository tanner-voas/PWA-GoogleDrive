import {sanitizeBackupSample,telemetryApp,TELEMETRY_SCHEMA} from '../src/network-telemetry.js';
const PREFIX='network-telemetry:v1:',META=PREFIX+'meta',PENDING=PREFIX+'pending:',STAGED=PREFIX+'staged:';
export const TELEMETRY_LIMIT=1024, FIRST_DELAY=10*60*1000, FLUSH_INTERVAL=60*60*1000, RETENTION_MS=30*86400000;
const MAX_HEADER=4096, CHUNK=48;
const NUMBERS=['driveCalls','driveRetries','indexHits','indexMisses','objectScans','driveHeaderMs','driveHeaderMaxMs','drive4xx','drive5xx','drive429','driveNetworkErrors','commitHeadMs','commitObjectsMs','commitRevisionMs','commitPublishMs'];
const ops=new Map([['GET /profiles','profiles_list'],['POST /profiles','profile_create'],['POST /objects/missing','objects_missing'],['POST /objects/read-batch','objects_read_batch'],['POST /objects/batch','objects_write_batch']]);
export function classifyRequest(method,path,app){
 const exact=ops.get(`${method} ${path}`);if(exact)return {operation:exact,app:telemetryApp(app)};
 const match=/^\/profiles\/[A-Za-z0-9_-]{1,80}\/apps\/([a-z][a-z0-9-]{0,31})\/(head|commit|history|revisions\/[A-Za-z0-9_-]{1,80})$/.exec(path);
 if(match){const operation=match[2].split('/')[0];if((operation==='commit'&&method==='POST')||(operation!=='commit'&&method==='GET'))return {operation,app:telemetryApp(match[1])};}
 if(method==='PATCH'&&/^\/profiles\/[A-Za-z0-9_-]{1,80}$/.test(path))return {operation:'profile_rename',app:telemetryApp(app)};
 if(/^\/objects\/[a-f0-9]{64}$/.test(path)&&['GET','PUT'].includes(method))return {operation:method==='PUT'?'object_write':'object_read',app:telemetryApp(app)};
 return null;
}
export function requestSample({label,status,queueMs,serviceMs,requestChars,responseChars,metrics}){
 const out={kind:'request',...label,at:new Date().toISOString(),status,queueMs:Math.max(0,queueMs),serviceMs:Math.max(0,serviceMs),requestChars:Math.max(0,requestChars),responseChars:responseChars??null};
 for(const key of NUMBERS)if(Number.isFinite(metrics?.[key]))out[key]=Math.max(0,Math.round(metrics[key]));
 return out;
}
export function readClientSamples(raw,scope){
 if(typeof raw!=='string'||raw.length>MAX_HEADER||!scope)return null;
 try{const value=JSON.parse(raw);if(value.scope!==scope||!Array.isArray(value.samples)||value.samples.length>3||!value.samples.length)return null;const samples=value.samples.map(sanitizeBackupSample);return samples.every(Boolean)?samples:null;}catch{return null;}
}
const fresh=()=>({next:0,frozen:0,lastFlush:0,lastPrune:0,lastAttempt:0,failures:0,staged:null});
const slot=seq=>PENDING+String(seq%TELEMETRY_LIMIT).padStart(4,'0');
/** A bounded durable ring and a frozen retry batch. No Drive access on the
 * request path. All calls are serialized by the account coordinator. */
export class NetworkTelemetry{
 constructor(storage){this.storage=storage;this.armed=false;}
 async enabled(){return typeof this.storage.setAlarm==='function';}
 async meta(){return (await this.storage.get(META))||fresh();}
 async arm(meta,now=Date.now(),delay=null){
  if(this.armed)return;
  if(await this.storage.getAlarm()!==null){this.armed=true;return;}
  await this.storage.setAlarm(delay===null?Math.max(now+FIRST_DELAY,meta.lastFlush+FLUSH_INTERVAL,(meta.lastAttempt||0)+FLUSH_INTERVAL):now+delay);this.armed=true;
 }
 async append(samples,now=Date.now()){
  if(!samples.length||!await this.enabled())return false;
  const meta=await this.meta(),updates={};
  for(const sample of samples){const seq=++meta.next;updates[slot(seq)]={seq,sample};}
  updates[META]=meta;await this.storage.put(updates);await this.arm(meta,now);return true;
 }
 async freeze(meta,now){
  const rows=[...(await this.storage.list({prefix:PENDING})).values()].filter(r=>r.seq>meta.frozen).sort((a,b)=>a.seq-b.seq);
  if(!rows.length)return meta;
  const batch={id:crypto.randomUUID(),at:new Date(now).toISOString(),dropped:Math.max(0,meta.next-meta.frozen-rows.length),parts:Math.ceil(rows.length/CHUNK),count:rows.length};
  const updates={};for(let i=0;i<batch.parts;i++)updates[STAGED+i]=rows.slice(i*CHUNK,(i+1)*CHUNK).map(r=>r.sample);
  const next={...meta,frozen:meta.next,staged:batch};updates[META]=next;await this.storage.put(updates);return next;
 }
 async flush(drive,now=Date.now()){
  this.armed=false;
  let meta=await this.meta();
  if(!meta.staged&&meta.next===meta.frozen)return;
  try{
   if(!await this.storage.get('refresh')){await this.clear();return;}
   if(!meta.staged)meta=await this.freeze(meta,now);
   if(!meta.staged)return;
   const batch=meta.staged,events=[];
   for(let i=0;i<batch.parts;i++){const rows=await this.storage.get(STAGED+i);if(!Array.isArray(rows))throw Error('Missing frozen telemetry segment');events.push(...rows);}
   if(events.length!==batch.count)throw Error('Incomplete frozen telemetry batch');
   const root=await drive.root(true),folder=await drive.folder(root,'telemetry',true);
   const name=`network-v1-${batch.at.slice(0,10)}-${batch.id}.json`;
   const content=JSON.stringify({schema:TELEMETRY_SCHEMA,createdAt:batch.at,droppedEvents:batch.dropped,events});
   const existing=(await drive.list(folder,name))[0];
   if(existing){if(await drive.content(existing.id)!==content)throw Error('Telemetry batch identity collision');}
   else await drive.createJSON(folder,name,content);
   // Commit receipt before deleting staged segments; a crash cannot cause a
   // different payload to be retried under the same name.
   meta={...meta,staged:null,lastFlush:now,lastAttempt:now,failures:0};await this.storage.put(META,meta);
   await this.storage.delete(Array.from({length:batch.parts},(_,i)=>STAGED+i));
   if(now-meta.lastPrune>=86400000){
    try{const files=await drive.list(folder);let removed=0;for(const file of files){const date=/^network-v1-(\d{4}-\d{2}-\d{2})-[a-f0-9-]{36}\.json$/.exec(file.name);if(date&&Date.parse(date[1])+86400000<now-RETENTION_MS&&removed<4){await drive.remove(file.id);removed++;}}if(removed<4){meta.lastPrune=now;await this.storage.put(META,meta);}}catch{}
   }
   if(meta.next>meta.frozen)await this.arm(meta,now);
  }catch{
   // Stop idle accounts from waking forever when Google authorization or
   // quota is unavailable. New authenticated traffic can re-arm the journal.
   meta=await this.meta();meta={...meta,lastAttempt:now,failures:(meta.failures||0)+1};await this.storage.put(META,meta);
   if(meta.failures<3)await this.arm(meta,now,FLUSH_INTERVAL);
  }
 }
 async clear(){const rows=await this.storage.list({prefix:PREFIX});const keys=[...rows.keys()].filter(key=>key!==META);keys.push(META);for(let i=0;i<keys.length;i+=128)await this.storage.delete(keys.slice(i,i+128));await this.storage.deleteAlarm?.();this.armed=false;}
}
