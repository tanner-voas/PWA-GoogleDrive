/** Profile-independent, content-free performance summaries. No network call is
 * made by this module; completed samples ride on later authenticated requests. */
export const TELEMETRY_SCHEMA=1;
const APPS=new Set(['ciyan','worldgen','ascendant','chronicle','applauncher']);
export const telemetryApp=value=>APPS.has(value)?value:'other';
const NUMBERS=['durationMs','prepareMs','headMs','preflightMs','uploadMs','commitMs','sections','changed','reused','payloadBytes','objectsSent','objectsCreated','requests','driveCalls','driveRetries','indexHits','indexMisses','objectScans','hashed','hashesReused','serialized','identityReused','preflightReused','httpStatus'];
const STATUS=new Set(['committed','unchanged','divergent','error']);
export function sanitizeBackupSample(value){
 if(!value||!STATUS.has(value.status)||typeof value.eventId!=='string'||!/^[a-f0-9-]{36}$/.test(value.eventId))return null;
 const at=Date.parse(value.at);if(!Number.isFinite(at)||at<0||Math.abs(at-Date.now())>7*86400000)return null;
 const out={kind:'backup',eventId:value.eventId,app:telemetryApp(value.app),at:new Date(at).toISOString(),status:value.status};
 if(typeof value.appVersion==='string'&&/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(value.appVersion))out.appVersion=value.appVersion;
 for(const key of NUMBERS){const n=value[key];if(typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=Number.MAX_SAFE_INTEGER)out[key]=Math.round(n);}
 return out;
}
let scope=null,pending=[],inFlight=false;
const STORAGE_KEY='pwa.network-telemetry.v1';
function savePending(){try{if(!scope||!pending.length)globalThis.sessionStorage?.removeItem(STORAGE_KEY);else globalThis.sessionStorage?.setItem(STORAGE_KEY,JSON.stringify({scope,samples:pending}));}catch{}}
function restorePending(next){try{const value=JSON.parse(globalThis.sessionStorage?.getItem(STORAGE_KEY)||'null');if(value?.scope===next&&Array.isArray(value.samples))return value.samples.slice(-16).map(sanitizeBackupSample).filter(Boolean);}catch{}return [];}

export const telemetryScope=()=>scope;
export function queueBackupTelemetry(app,metrics,expectedScope=scope){
 try{if(!scope||scope!==expectedScope)return;const sample=sanitizeBackupSample({...metrics,app,eventId:crypto.randomUUID()});if(sample){pending.push(sample);if(pending.length>16)pending.shift();savePending();}}catch{}
}
/** Scope is an opaque, non-authorizing session digest. Never send a previous
 * account's samples into a new account; old workers do not advertise a scope. */
export function beginTelemetry(app){
 const headers={};if(app)headers['X-PWA-Telemetry-App']=telemetryApp(app);
 const sent=scope&&!inFlight?pending.slice(0,3):[];
 if(sent.length){headers['X-PWA-Telemetry']=JSON.stringify({scope,samples:sent});inFlight=true;}
 const originalScope=scope;
 return {headers,finish(response){
  if(sent.length)inFlight=false;
  if(!response)return;
  try{
   const next=response.headers.get('X-PWA-Telemetry-Scope');
   if(next!==scope){scope=next;pending=next?restorePending(next):[];savePending();return;}
   if(next&&originalScope===next&&response.headers.get('X-PWA-Telemetry-Ack')==='1'){
    const ids=new Set(sent.map(s=>s.eventId));pending=pending.filter(s=>!ids.has(s.eventId));savePending();
   }
  }catch{}
 }};
}
