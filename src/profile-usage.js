// Local-first, profile-scoped cumulative observations. A writer is unique per
// page instance: concurrent tabs never overwrite each other's counters.
const PREFIX='pwa.profile.usage.v1:',KEY='pwa.profiles.v1';
const ID=/^[A-Za-z0-9_-]{1,80}$/;
export const usageFields=['translateRequests','translateCharacters','speechRequests','speechCharacters','speechCacheHits','driveCalls'];
let writer,scopePromise,scopeAt=0,timer,syncing=null,retryDelay=5000,dirtyDuringSync=false;
const today=()=>new Date().toISOString().slice(0,10);
function profile(){try{const r=JSON.parse(localStorage.getItem(KEY));return ID.test(r?.active||'')&&r.profiles.some(p=>p.id===r.active)?r.active:null;}catch{return null;}}
async function getScope(){try{const r=await fetch('/_profiles/v1/usage/profile-scope',{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(10000)});if(r.ok){const d=await r.json();if(ID.test(d.scope||''))return d.scope;}}catch{}return null;}
export function captureUsage(profileId=profile(),{deferScope=false}={}){
 try{if(!ID.test(profileId||'')||!globalThis.localStorage||!globalThis.crypto?.randomUUID)return null;
 writer??=crypto.randomUUID();if(!deferScope&&(!scopePromise||Date.now()-scopeAt>60000)){scopeAt=Date.now();scopePromise=getScope();}return {profile:profileId,writer,day:today(),scope:deferScope?null:scopePromise};}catch{return null;}
}
export async function recordProfileUsage(context,delta){if(!context)return;try{
 const scope=await context.scope||'local-only';if(scope==='local-only')scopePromise=null;
 const {profile,day}=context;const write=()=>{let id=context.writer;if(globalThis.navigator?.locks){const k='pwa.profile.usage.writer.v1';id=localStorage.getItem(k)||id;localStorage.setItem(k,id);}const key=PREFIX+[scope,profile,day,id].join(':');
 const row=JSON.parse(localStorage.getItem(key)||'null')||{scope,profile,writer:id,day,counts:{}};
 for(const field of usageFields)if(Number.isSafeInteger(delta[field])&&delta[field]>0)row.counts[field]=Math.min(1e9,(row.counts[field]||0)+delta[field]);
 delete row.acked;localStorage.setItem(key,JSON.stringify(row));};if(globalThis.navigator?.locks)await navigator.locks.request('pwa-profile-usage-write',write);else write();if(syncing)dirtyDuringSync=true;schedule();
 }catch{} }
function schedule(delay=2000){if(timer||!globalThis.setTimeout)return;timer=setTimeout(()=>{timer=null;void syncProfileUsage();},delay);timer?.unref?.();}
// Return a sanitized result to the UI. Concurrent callers await the same flush.
export function syncProfileUsage(){if(syncing)return syncing;dirtyDuringSync=false;syncing=flushProfileUsage().finally(()=>{syncing=null;if(dirtyDuringSync)schedule();});return syncing;}
async function flushProfileUsage(){let pending=0,uploaded=0,state='unavailable';try{
 if(!globalThis.localStorage)return {state:'unavailable',pending,uploaded};
 const min=new Date(Date.now()-31*86400000).toISOString().slice(0,10),candidates=[];
 for(let i=localStorage.length-1;i>=0;i--){const key=localStorage.key(i);if(!key?.startsWith(PREFIX))continue;try{const r=JSON.parse(localStorage.getItem(key));if(r.day<min){localStorage.removeItem(key);continue;}if(r.scope!=='local-only'&&!r.acked)candidates.push({key,row:r});}catch{}}
 if(!candidates.length){retryDelay=5000;return {state:'up-to-date',pending,uploaded};}
 const scope=await getScope();if(!scope){pending=candidates.length;state='connection-unavailable';return {state,pending,uploaded};}scopePromise=Promise.resolve(scope);scopeAt=Date.now();const rows=candidates.filter(x=>x.row.scope===scope);pending=rows.length;
 for(let i=0;i<rows.length&&i<128;i+=16){const batch=rows.slice(i,i+16);const r=await fetch('/_profiles/v1/usage/profiles',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-PWA-CSRF':'1'},body:JSON.stringify({scope,rows:batch.map(x=>x.row)}),keepalive:true,signal:AbortSignal.timeout(10000)});if(!r.ok||!(await r.json().catch(()=>null))?.accepted){state=r.status===401||r.status===409?'connection-unavailable':'upload-failed';return {state,pending,uploaded};}for(const {key,row} of batch){const ack=()=>{const current=JSON.parse(localStorage.getItem(key)||'null');if(current&&JSON.stringify(current.counts)===JSON.stringify(row.counts)){current.acked=true;localStorage.setItem(key,JSON.stringify(current));pending--;}};if(globalThis.navigator?.locks)await navigator.locks.request('pwa-profile-usage-write',ack);else ack();uploaded++;}}
 state=pending?'pending':'up-to-date';retryDelay=5000;return {state,pending,uploaded};
 }catch{return {state:'upload-failed',pending,uploaded};}finally{if(pending&&globalThis.document?.visibilityState!=='hidden'){schedule(retryDelay);retryDelay=Math.min(60000,retryDelay*2);}}}
// Only a known provider response counts; gateway failures before reservation do not.
export function profileTranslationFetch(context,fetcher=globalThis.fetch){return async (url,opts)=>{const response=await fetcher(url,opts);try{const d=await response.clone().json();if(d?.provider==='google'||String(d?.code||'').startsWith('GOOGLE_')){const body=JSON.parse(opts.body);if(typeof body.text==='string')void recordProfileUsage(context,{translateRequests:1,translateCharacters:[...body.text].length});}}catch{}return response;};}
if(typeof window!=='undefined'&&typeof window.addEventListener==='function'&&window.document){window.addEventListener('online',()=>void syncProfileUsage());window.addEventListener('pageshow',()=>{scopePromise=null;schedule();});window.document.addEventListener('visibilitychange',()=>{scopePromise=null;if(window.document.visibilityState==='visible')schedule();else void syncProfileUsage();});}
