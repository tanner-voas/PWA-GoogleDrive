// Local-first cumulative snapshots. Scope is captured at operation start, not
// inferred from the account which happens to be logged in when a retry runs.
const PREFIX='pwa.profile.usage.v1:',KEY='pwa.profiles.v1';
const ID=/^[A-Za-z0-9_-]{1,80}$/;
export const usageFields=['translateRequests','translateCharacters','speechRequests','speechCharacters','speechCacheHits','driveCalls'];
let writer,timer,syncing=null,retryDelay=5000,dirtyDuringSync=false;
const today=()=>new Date().toISOString().slice(0,10);
function profile(){try{const r=JSON.parse(localStorage.getItem(KEY));return ID.test(r?.active||'')&&r.profiles.some(p=>p.id===r.active)?r.active:null;}catch{return null;}}
async function getScope(){try{const r=await fetch('/_profiles/v1/usage/profile-scope',{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(10000)});if(r.ok){const d=await r.json();if(ID.test(d.scope||''))return d.scope;}}catch{}return null;}
export function captureUsage(profileId=profile(),{deferScope=false}={}){
 try{if(!ID.test(profileId||'')||!globalThis.localStorage||!globalThis.crypto?.randomUUID)return null;
 // Never reuse a resolved scope across operations: another tab can sign out or
 // change accounts without notifying this page. Drive carries a response scope.
 writer??=crypto.randomUUID();return {profile:profileId,writer,day:today(),scope:deferScope?null:getScope()};}catch{return null;}
}
const withLock=fn=>globalThis.navigator?.locks?navigator.locks.request('pwa-profile-usage-write',fn):fn();
export async function recordProfileUsage(context,delta){if(!context)return {state:'no-profile'};try{
 const resolved=await context.scope,scope=ID.test(resolved||'')?resolved:'local-only';
 const {profile,day}=context;if(!ID.test(profile||'')||!ID.test(context.writer||'')||!/^\d{4}-\d{2}-\d{2}$/.test(day))return {state:'invalid-context'};
 const additions=Object.fromEntries(usageFields.filter(f=>Number.isSafeInteger(delta?.[f])&&delta[f]>0).map(f=>[f,delta[f]]));if(!Object.keys(additions).length)return {state:'no-usage'};
 await withLock(()=>{let id=context.writer;if(globalThis.navigator?.locks){const k='pwa.profile.usage.writer.v1';id=localStorage.getItem(k)||id;localStorage.setItem(k,id);}const key=PREFIX+[scope,profile,day,id].join(':');
 const row=JSON.parse(localStorage.getItem(key)||'null')||{scope,profile,writer:id,day,counts:{}};
 for(const [field,value] of Object.entries(additions))row.counts[field]=Math.min(1e9,(row.counts[field]||0)+value);
 delete row.acked;localStorage.setItem(key,JSON.stringify(row));});if(syncing)dirtyDuringSync=true;if(scope!=='local-only')schedule();return {state:scope==='local-only'?'unlinked':'recorded'};
 }catch{return {state:'storage-failed'};} }
function schedule(delay=2000){if(timer||!globalThis.setTimeout)return;timer=setTimeout(()=>{timer=null;void syncProfileUsage();},delay);timer?.unref?.();}
// Manual reconciliation replays acknowledged rows too, safely by cumulative max.
// Routine flushes only send dirty rows. All results exclude account identifiers.
export function syncProfileUsage({reconcile=false}={}){if(syncing)return syncing;dirtyDuringSync=false;syncing=flushProfileUsage(reconcile).finally(()=>{syncing=null;if(dirtyDuringSync)schedule();});return syncing;}
async function flushProfileUsage(reconcile){let pending=0,uploaded=0,unlinked=0,local=0,acknowledged=0,invalid=0,state='unavailable',retry=false;const result=()=>({state,pending,uploaded,unlinked,local,acknowledged,invalid});try{
 if(!globalThis.localStorage)return result();
 const min=new Date(Date.now()-31*86400000).toISOString().slice(0,10),candidates=[];
 // Read/expire under the same lock as writes and acknowledgements.
 await withLock(()=>{for(let i=localStorage.length-1;i>=0;i--){const key=localStorage.key(i);if(!key?.startsWith(PREFIX))continue;try{const r=JSON.parse(localStorage.getItem(key));if(!r||!ID.test(r.profile||'')||!ID.test(r.writer||'')||!ID.test(r.scope||'')||!/^\d{4}-\d{2}-\d{2}$/.test(r.day)||!r.counts){invalid++;continue;}if(r.day<min){localStorage.removeItem(key);continue;}if(r.scope==='local-only'){unlinked++;continue;}candidates.push({key,row:r});}catch{invalid++;}}});
 if(!candidates.length){retryDelay=5000;state=unlinked?'unlinked-only':'no-local-snapshots';return result();}
 if(!reconcile&&candidates.every(x=>x.row.acked)){state='up-to-date';return result();}
 const scope=await getScope();if(!scope){state='connection-unavailable';retry=candidates.some(x=>!x.row.acked);return result();}
 const matching=candidates.filter(x=>x.row.scope===scope);local=matching.length;acknowledged=matching.filter(x=>x.row.acked).length;let remote=null;if(reconcile)try{const r=await fetch('/_profiles/v1/usage/profiles',{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(10000)});const d=r.ok?await r.json():null;if(d?.scope===scope&&Array.isArray(d.rows))remote=new Map(d.rows.map(x=>[[x.profile,x.day,x.writer].join(':'),x.counts]));}catch{}const rows=matching.filter(x=>!x.row.acked||(remote&&usageFields.some(f=>(x.row.counts[f]||0)>(remote.get([x.row.profile,x.row.day,x.row.writer].join(':'))?.[f]||0))));pending=rows.length;
 if(!matching.length){state=unlinked?'unlinked-only':'no-local-snapshots';return result();}
 for(let i=0;i<rows.length&&i<128;i+=16){const batch=rows.slice(i,i+16);const r=await fetch('/_profiles/v1/usage/profiles',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-PWA-CSRF':'1'},body:JSON.stringify({scope,rows:batch.map(x=>x.row)}),keepalive:true,signal:AbortSignal.timeout(10000)});if(!r.ok||!(await r.json().catch(()=>null))?.accepted){state=r.status===401||r.status===409?'connection-unavailable':r.status===400?'snapshot-rejected':'upload-failed';retry=state!=='snapshot-rejected';return result();}for(const {key,row} of batch){await withLock(()=>{const current=JSON.parse(localStorage.getItem(key)||'null');if(current&&JSON.stringify(current.counts)===JSON.stringify(row.counts)){if(!current.acked)acknowledged++;current.acked=true;localStorage.setItem(key,JSON.stringify(current));pending--;}});uploaded++;}}
 state=pending?'pending':'up-to-date';retry=!!pending;retryDelay=5000;return result();
 }catch{state='upload-failed';retry=!!pending;return result();}finally{if(retry&&globalThis.document?.visibilityState!=='hidden'){schedule(retryDelay);retryDelay=Math.min(60000,retryDelay*2);}}}
// Only a known provider response counts; gateway failures before reservation do not.
export function profileTranslationFetch(context,fetcher=globalThis.fetch){return async (url,opts)=>{const response=await fetcher(url,opts);try{const d=await response.clone().json();if(d?.provider==='google'||String(d?.code||'').startsWith('GOOGLE_')){const body=JSON.parse(opts.body);if(typeof body.text==='string')void recordProfileUsage(context,{translateRequests:1,translateCharacters:[...body.text].length});}}catch{}return response;};}
if(typeof window!=='undefined'&&typeof window.addEventListener==='function'&&window.document){window.addEventListener('online',()=>void syncProfileUsage());window.addEventListener('pageshow',()=>schedule());window.addEventListener('pwa-profile-changed',()=>schedule());window.document.addEventListener('visibilitychange',()=>{if(window.document.visibilityState==='visible')schedule();else void syncProfileUsage();});}
