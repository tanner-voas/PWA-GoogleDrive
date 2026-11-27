import {mergeProfileRows} from './profile-usage.js';
import {normalizeTelemetryQuery,queryTelemetry} from './telemetry-query.js';
import {providerSample,addProviderTotals} from './provider-usage.js';
import {WorkspaceTelemetry} from './workspace-telemetry.js';
import pkg from '../package.json' with {type:'json'};
import {adaptDriveSample,createEvent} from '../src/workspace-telemetry-schema.js';
import {NetworkTelemetry,classifyRequest,requestSample,readClientSamples} from './network-telemetry.js';
import {retainedIds,checkRevision} from '../src/retention.js';
const PREFIX='/_profiles/v1',ROOT='AppLauncher Profiles',DRIVE='https://www.googleapis.com/drive/v3/files',UPLOAD='https://www.googleapis.com/upload/drive/v3/files';
const ID=/^[A-Za-z0-9_-]{1,80}$/,SHA=/^[a-f0-9]{64}$/,FOLDER='application/vnd.google-apps.folder';
const enc=new TextEncoder(),dec=new TextDecoder();
const INDEX_TTL=60*60*1000, FOLDER_TTL=60*1000;
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const indexKey=(folder,hash)=>`object-index:v1:${folder}:${hash}`;
const freshMetrics=()=>({driveCalls:0,driveRetries:0,indexHits:0,indexMisses:0,objectScans:0,driveHeaderMs:0,driveHeaderMaxMs:0,drive4xx:0,drive5xx:0,drive429:0,driveNetworkErrors:0});
const groups=(items,size)=>Array.from({length:Math.ceil(items.length/size)},(_,i)=>items.slice(i*size,(i+1)*size));
// Never release the account queue while sibling Drive writes are still running.
async function settleBatch(promises){const results=await Promise.allSettled(promises);const failure=results.find(r=>r.status==='rejected');if(failure)throw failure.reason;return results.map(r=>r.value);}
const responseLengths=new WeakMap();
const json=(object,status=200,extra={})=>{const text=JSON.stringify(object),response=new Response(text,{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',...extra}});responseLengths.set(response,text.length);return response;};
const error=(status,message,extra={})=>json({error:message,...extra},status);
const rand=()=>crypto.randomUUID();
const b64=bytes=>btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const rawb64=str=>Uint8Array.from(atob(str.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-str.length%4)%4)),c=>c.charCodeAt(0));
const hex=buf=>Array.from(new Uint8Array(buf),b=>b.toString(16).padStart(2,'0')).join('');
async function hmac(payload,secret){const key=await crypto.subtle.importKey('raw',enc.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);return b64(await crypto.subtle.sign('HMAC',key,enc.encode(payload)));}
async function sign(data,env){const body=b64(enc.encode(JSON.stringify(data)));return `${body}.${await hmac(body,env.SESSION_SIGNING_KEY)}`;}
async function unsign(cookie,env){
 try{
  if(typeof cookie!=='string'||cookie.length>4096)return null;
  const parts=cookie.split('.');if(parts.length!==2||parts.some(p=>!p||!/^[A-Za-z0-9_-]+$/.test(p)))return null;
  const [payload,signature]=parts,key=await crypto.subtle.importKey('raw',enc.encode(env.SESSION_SIGNING_KEY),{name:'HMAC',hash:'SHA-256'},false,['verify']);
  if(!await crypto.subtle.verify('HMAC',key,rawb64(signature),enc.encode(payload)))return null;
  const data=JSON.parse(dec.decode(rawb64(payload)));return Number.isFinite(data.exp)&&data.exp>Date.now()?data:null;
 }catch{return null;}
}
const cookies=request=>Object.fromEntries((request.headers.get('Cookie')||'').split(';').map(s=>s.trim().split(/=(.*)/s).slice(0,2)).filter(x=>x[0]));
const cookie=(name,value,age)=>`${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${age}`;
const SESSION='__Host-pwa_profile_session',OAUTH='__Host-pwa_oauth_state';
const originAllowed=(url,env)=>String(env.ALLOWED_ORIGINS||'').split(',').map(s=>s.trim()).includes(url.origin);
async function encrypt(text,env){const key=await crypto.subtle.importKey('raw',rawb64(env.VAULT_KEY),{name:'AES-GCM'},false,['encrypt']);const iv=crypto.getRandomValues(new Uint8Array(12));return `${b64(iv)}.${b64(await crypto.subtle.encrypt({name:'AES-GCM',iv},key,enc.encode(text)))}`;}
async function decrypt(blob,env){const [iv,bytes]=blob.split('.');const key=await crypto.subtle.importKey('raw',rawb64(env.VAULT_KEY),{name:'AES-GCM'},false,['decrypt']);return dec.decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:rawb64(iv)},key,rawb64(bytes)));}
async function googleToken(env,body){const res=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(body)});if(!res.ok){const e=Error('Google OAuth token exchange failed');e.status=res.status;throw e;}return res.json();}
const internal=(stub,path,body)=>stub.fetch(new Request(`https://internal${path}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}));
async function oauthStart(request,env,url){
 const desired=url.searchParams.get('return')||'/';const returnTo=desired.startsWith('/')&&!desired.startsWith('//')&&!desired.includes('\\')?desired:'/';
 const state=rand(),verifier=b64(crypto.getRandomValues(new Uint8Array(32))),expires=Date.now()+600000,redirect=`${url.origin}${PREFIX}/auth/callback`;
 const value=await sign({state,verifier,returnTo,exp:expires},env);
 const auth=new URL('https://accounts.google.com/o/oauth2/v2/auth');auth.searchParams.set('client_id',env.GOOGLE_CLIENT_ID);auth.searchParams.set('redirect_uri',redirect);auth.searchParams.set('response_type','code');auth.searchParams.set('scope','openid email https://www.googleapis.com/auth/drive.file');auth.searchParams.set('access_type','offline');auth.searchParams.set('prompt','consent');auth.searchParams.set('state',state);auth.searchParams.set('code_challenge',b64(await crypto.subtle.digest('SHA-256',enc.encode(verifier))));auth.searchParams.set('code_challenge_method','S256');
 return new Response(null,{status:302,headers:{Location:auth.toString(),'Set-Cookie':cookie(OAUTH,value,600),'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
}
async function oauthCallback(request,env,url){
 const state=await unsign(cookies(request)[OAUTH],env),queryState=url.searchParams.get('state');
 if(!state||typeof state.verifier!=='string'||!queryState||queryState!==state.state)return error(400,'Invalid or expired Google sign-in state. Start again.');
 if(url.searchParams.has('error'))return error(400,'Google sign-in was cancelled or denied.');
 const code=url.searchParams.get('code');if(!code)return error(400,'Missing authorization code');
 const tokens=await googleToken(env,{client_id:env.GOOGLE_CLIENT_ID,client_secret:env.GOOGLE_CLIENT_SECRET,code,code_verifier:state.verifier,grant_type:'authorization_code',redirect_uri:`${url.origin}${PREFIX}/auth/callback`});
 const userRes=await fetch('https://openidconnect.googleapis.com/v1/userinfo',{headers:{Authorization:`Bearer ${tokens.access_token}`}});
 if(!userRes.ok)throw Error('Cannot verify Google account');const user=await userRes.json();if(!/^\d+$/.test(String(user.sub)))throw Error('Invalid Google account identifier');
 const sid=rand(),exp=Date.now()+14*86400000,stub=env.ACCOUNTS.get(env.ACCOUNTS.idFromName(String(user.sub)));
 const init=await internal(stub,'/login',{sid,exp,email:user.email||'',refresh:tokens.refresh_token?await encrypt(tokens.refresh_token,env):null});
 if(!init.ok){const result=await init.json();throw Error(result.error||'Google account could not be connected');}
 const session=await sign({sub:String(user.sub),sid,exp},env);
 const headers=new Headers({Location:`${url.origin}${state.returnTo}`,'Cache-Control':'no-store','Referrer-Policy':'no-referrer'});headers.append('Set-Cookie',cookie(SESSION,session,14*86400));headers.append('Set-Cookie',cookie(OAUTH,'',0));return new Response(null,{status:302,headers});
}
export default {async fetch(request,env){
 try{
  const url=new URL(request.url);if(!url.pathname.startsWith(PREFIX+'/'))return error(404,'Unknown route');
  if(!originAllowed(url,env))return error(403,'Origin is not configured for this service');
  const path=url.pathname.slice(PREFIX.length);
  if(path==='/auth/start'&&request.method==='GET')return oauthStart(request,env,url);
  if(path==='/auth/callback'&&request.method==='GET')return oauthCallback(request,env,url);
  const session=await unsign(cookies(request)[SESSION],env);
  if(!session||session.type||!/^\d+$/.test(String(session.sub))||!ID.test(session.sid||''))return path==='/status'?json({connected:false}):error(401,'Connect Google Drive to continue');
  if(request.method!=='GET'){
   const origin=request.headers.get('Origin'),site=request.headers.get('Sec-Fetch-Site');
   if(request.headers.get('X-PWA-CSRF')!=='1'||(origin&&origin!==url.origin)||site==='cross-site')return error(403,'Invalid request origin or CSRF guard');
  }
  const stub=env.ACCOUNTS.get(env.ACCOUNTS.idFromName(session.sub));
  const response=await internal(stub,'/api',{sid:session.sid,method:request.method,path,body:request.method==='GET'?null:await request.text(),telemetryApp:request.headers.get('X-PWA-Telemetry-App'),telemetry:request.headers.get('X-PWA-Telemetry')?.slice(0,4097)});
  if((path==='/logout'||path==='/revoke')&&response.ok){const headers=new Headers(response.headers);headers.append('Set-Cookie',cookie(SESSION,'',0));return new Response(response.body,{status:response.status,headers});}
  return response;
 }catch(e){return error(502,e.message==='Google OAuth token exchange failed'?e.message:'Cloud synchronization request failed');}
}};

/** RPC only. Public fetch has no route to these functions. The calling Worker
 * must check its own administrator authorization before enrollment. */
export async function telemetrySession(env,origin,cookieHeader,action,query=null){
 try{if(!['status','enable','managed-enable','disable','flush','drain','query','checkpoint-owner','storage-quota','storage-quota-cached','storage-quota-refresh'].includes(action)||!originAllowed(new URL(origin),env)||typeof cookieHeader!=='string'||cookieHeader.length>8192)return {error:'Invalid telemetry request'};
 const request=new Request(origin,{headers:{Cookie:cookieHeader}}),session=await unsign(cookies(request)[SESSION],env);
 if(!session||session.type||!/^\d+$/.test(String(session.sub))||!ID.test(session.sid||''))return {error:'Connect Google Drive'};
 const stub=env.ACCOUNTS.get(env.ACCOUNTS.idFromName(session.sub));const r=await internal(stub,'/workspace-telemetry/session',{sid:session.sid,action,query});const data=await r.json();if(!r.ok)return {error:'Telemetry authorization unavailable'};
 if(action==='checkpoint-owner')return {ownerHash:hex(await crypto.subtle.digest('SHA-256',enc.encode(JSON.stringify([String(session.sub),data.epoch??null]))))};
 if(data.generation){const generation=data.generation,epoch=data.epoch;delete data.generation;delete data.epoch;data.capability=await sign({epoch,type:'workspace-telemetry',sub:session.sub,generation,exp:Date.now()+365*86400000},env);if(action==='managed-enable')data.controlCapability=await sign({epoch,type:'workspace-telemetry-control',sub:session.sub,generation,exp:Date.now()+365*86400000},env);}
 return data;
 }catch{return {error:'Telemetry service unavailable'};}
}
// Trusted Core Worker RPC for Google Translate; browser clients cannot submit
// Google usage. Both paths verify the active account and epoch at ingestion.
export async function translationUsage(env,origin,cookieHeader,sample){
 try{if(!originAllowed(new URL(origin),env)||typeof cookieHeader!=='string'||cookieHeader.length>8192)return {error:'Invalid usage request'};
 const session=await unsign(cookies(new Request(origin,{headers:{Cookie:cookieHeader}}))[SESSION],env);if(!session||session.type||!/^\d+$/.test(String(session.sub))||!ID.test(session.sid||''))return {error:'Connect Google Drive'};
 const event=providerSample('google-translate',sample);if(!event)return {error:'Invalid usage sample'};
 const r=await internal(env.ACCOUNTS.get(env.ACCOUNTS.idFromName(session.sub)),'/provider-usage',{sid:session.sid,sample});return r.json();
 }catch{return {error:'Usage unavailable'};}
}
export async function telemetryAppend(env,capability,events){
 try{if(!Array.isArray(events)||events.length>64||new TextEncoder().encode(JSON.stringify(events)).length>262144)return {error:'Invalid telemetry batch'};
 const token=await unsign(capability,env);if(token?.type!=='workspace-telemetry'||!/^\d+$/.test(String(token.sub))||!ID.test(token.generation||''))return {error:'Telemetry capability expired or invalid'};
 const r=await internal(env.ACCOUNTS.get(env.ACCOUNTS.idFromName(token.sub)),'/workspace-telemetry/append',{generation:token.generation,epoch:token.epoch??null,events});return await r.json();
 }catch{return {error:'Telemetry service unavailable'};}
}
// Private RPC: a valid, current archive capability permits draining its own
// generation without a browser session. It cannot enable a new generation.
export async function telemetryControl(env,capability,action){
 try{if(!['status','drain','disable'].includes(action))return {error:'Invalid telemetry action'};
 const token=await unsign(capability,env);if(token?.type!=='workspace-telemetry-control'||!/^\d+$/.test(String(token.sub))||!ID.test(token.generation||''))return {error:'Telemetry capability expired or invalid'};
 const r=await internal(env.ACCOUNTS.get(env.ACCOUNTS.idFromName(token.sub)),'/workspace-telemetry/control',{generation:token.generation,epoch:token.epoch??null,action});return await r.json();
 }catch{return {error:'Telemetry service unavailable'};}
}
export class AccountCoordinator {
 constructor(ctx,env){this.ctx=ctx;this.env=env;this.access=null;this.queue=Promise.resolve();this.folderCache=new Map();this.metrics=null;this.telemetry=new NetworkTelemetry(ctx.storage);this.workspaceTelemetry=new WorkspaceTelemetry(ctx.storage);}
 async alarm(){return this.serial(async()=>{if(this.env.NETWORK_TELEMETRY==='off'){try{await this.telemetry.clear();}catch{}}else try{await this.telemetry.flush(this);}catch{console.warn('legacy-telemetry','flush-failed');}
  try{await this.flushWorkspace();}finally{try{await this.flushRegularUsage();}catch{}finally{const due=await this.ctx.storage.get('workspace-regular-due');if(due)await this.armRegularUsage(due);}} });}
 async flushWorkspace(){ // called within the account's serialized queue
  this.metrics=freshMetrics();try{const m=await this.workspaceTelemetry.meta();if(m.enabled&&m.epoch!==(await this.ctx.storage.get('authorizationEpoch')??null))await this.workspaceTelemetry.disable();else await this.workspaceTelemetry.tick(this);}finally{const metrics=this.metrics;this.metrics=null;if(metrics.driveCalls)try{await this.workspaceTelemetry.addArchiveMetrics(metrics);}catch{} }
  // Legacy and v2 share one account alarm; re-arm after either writer changes it.
  await this.workspaceTelemetry.arm();}
 async appendTelemetry(records){const m=await this.workspaceTelemetry.meta(),active=m.enabled&&m.epoch===(await this.ctx.storage.get('authorizationEpoch')??null);if(!active)return this.recordRegularUsage(records);try{await this.recordRegularUsage(records);}catch{}
  const mapped=records.map(r=>adaptDriveSample(r,crypto.randomUUID())).filter(Boolean);if(!mapped.length)return false;
  const result=await this.workspaceTelemetry.append(mapped);return result.accepted+result.duplicates===mapped.length;
 }
 async recordRegularUsage(records){
  // Account-wide request totals; profile backup data and app-local counters are
  // unchanged. No individual request events are written in Regular mode.
  const day=new Date().toISOString().slice(0,10),key='workspace-regular-usage',days=(await this.ctx.storage.get(key))||{};
  const row={requests:0,driveCalls:0,driveRetries:0,requestChars:0,responseChars:0,backupCount:0,...days[day]};
  for(const r of records){if(r.kind==='backup'){row.backupCount++;continue;}row.requests++;for(const k of ['driveCalls','driveRetries','requestChars','responseChars'])if(Number.isFinite(r[k])&&r[k]>=0)row[k]+=r[k];}
  days[day]=row;await this.ctx.storage.put(key,Object.fromEntries(Object.entries(days).sort().slice(-31)));const due=await this.ctx.storage.get('workspace-regular-due')||Math.max(Date.now()+3600000,(await this.ctx.storage.get('workspace-regular-last-backup')||0)+86400000);await this.ctx.storage.put('workspace-regular-due',due);await this.armRegularUsage(due);return true;
 }
 async recordProviderUsage(source,sample){
  const now=Date.now(),event=providerSample(source,sample,now);if(!event)return error(400,'Invalid usage sample');
  const s=this.ctx.storage,key='workspace-regular-usage',idsKey='workspace-provider-recent',day=new Date(now).toISOString().slice(0,10);
  const accepted=await s.transaction(async tx=>{const recent=(await tx.get(idsKey))||[];if(recent.includes(event.eventId))return false;const days=(await tx.get(key))||{};days[day]=addProviderTotals(days[day]||{},event);await tx.put(key,Object.fromEntries(Object.entries(days).sort().slice(-31)));await tx.put(idsKey,[...recent,event.eventId].slice(-512));return true;});
  const due=await s.get('workspace-regular-due')||Math.max(now+3600000,(await s.get('workspace-regular-last-backup')||0)+86400000);await s.put('workspace-regular-due',due);await this.armRegularUsage(due);
  if(accepted){const m=await this.workspaceTelemetry.meta();if(m.enabled&&m.epoch===(await s.get('authorizationEpoch')??null))try{await this.workspaceTelemetry.append([event],now,m.generation);}catch{}}
  return json({accepted,duplicate:!accepted});
 }
 async armRegularUsage(due){if(!this.ctx.storage.setAlarm)return;const old=await this.ctx.storage.getAlarm();if(old==null||old>due)await this.ctx.storage.setAlarm(Math.max(Date.now()+1000,due));}
 async flushRegularUsage(){const s=this.ctx.storage,due=await s.get('workspace-regular-due');if(!due)return;if(!await s.get('refresh')){await s.delete('workspace-regular-due');return;}if(Date.now()<due){await this.armRegularUsage(due);return;}
  try{const days=await s.get('workspace-regular-usage')||{},profileRows=mergeProfileRows(await s.get('profile-usage-rows')||[],[],await s.get('profile-usage-scope')),text=JSON.stringify({schema:1,kind:'workspace-regular-usage',days,...(profileRows.length?{profileRows}:{})});const folder=await this.folder(await this.root(true),'telemetry',true);const files=(await this.list(folder,'regular-usage-v1.json',true)).filter(f=>f.appProperties?.pwaTelemetry==='regular-v1');if(files.length>1)throw Error('Ambiguous usage backup');let file=files[0];if(file){if(await this.content(file.id)!==text)await this.replaceJSON(file.id,text);}else file=await this.createJSON(folder,'regular-usage-v1.json',text,{appProperties:{pwaTelemetry:'regular-v1'}});if(!file?.id||await this.content(file.id)!==text)throw Error('Usage backup verification failed');await s.delete('workspace-regular-due');await s.put('workspace-regular-last-backup',Date.now());await s.delete('workspace-regular-backup-error');}
  catch{const retry=Date.now()+3600000;await s.put('workspace-regular-backup-error','verification-unavailable');await s.put('workspace-regular-due',retry);await this.armRegularUsage(retry);}
 }
 async fetch(request){const url=new URL(request.url);let input;try{input=await request.json();}catch{return error(400,'Invalid request');}
  if(url.pathname==='/login'){
   const run=async()=>{
    if(input.refresh){await this.ctx.storage.put('refresh',input.refresh);this.access=null;this.folderCache.clear();}
    if(!(await this.ctx.storage.get('refresh')))return error(401,'Google did not issue offline authorization. Reconnect and consent again.');
    const epoch=await this.ctx.storage.get('authorizationEpoch')??null;
    await this.ctx.storage.put(`session:${input.sid}`,{exp:input.exp,email:input.email,epoch});
    try{await this.cleanSessions(epoch);}catch{} // best-effort cleanup; never block a valid login
    return json({ok:true});
   };
   return this.serial(run);
  }
  if(url.pathname==='/provider-usage')return this.serial(async()=>{const session=await this.ctx.storage.get(`session:${input.sid}`),epoch=await this.ctx.storage.get('authorizationEpoch')??null;if(!session||session.exp<=Date.now()||(session.epoch??null)!==epoch||!await this.ctx.storage.get('refresh'))return error(401,'Usage authorization expired');return this.recordProviderUsage('google-translate',input.sample);});
  if(url.pathname==='/workspace-telemetry/session')return this.serial(async()=>{
   const session=await this.ctx.storage.get(`session:${input.sid}`),epoch=await this.ctx.storage.get('authorizationEpoch')??null;
   if(!session||session.exp<=Date.now()||(session.epoch??null)!==epoch||!await this.ctx.storage.get('refresh'))return error(401,'Telemetry authorization expired');
   if(input.action==='checkpoint-owner')return json({epoch});
   if(['storage-quota','storage-quota-cached','storage-quota-refresh'].includes(input.action)){
    const key='workspace-storage-quota-v1',now=Date.now(),old=await this.ctx.storage.get(key);
    if(old?.epoch===epoch&&(input.action==='storage-quota-cached'||now>=old.at&&now-old.at<(input.action==='storage-quota-refresh'?60000:15*60000)))return json(old.result);
    if(input.action==='storage-quota-cached')return json({state:'no-data'});
    let result;try{const quota=await this.telemetryStorageQuota();result={state:Object.keys(quota).length?'available':'no-data',at:now,quota};}catch{result={state:'unavailable',at:now};}
    await this.ctx.storage.put(key,{epoch,at:now,result});return json(result);
   }
   if(input.action==='query'){const q=normalizeTelemetryQuery(input.query);if(!q)return error(400,'Invalid archive query');return json(await queryTelemetry(this,q));}
   if(['enable','managed-enable'].includes(input.action)){const generation=await this.workspaceTelemetry.enable(Date.now(),epoch);return json({...await this.workspaceTelemetry.status(),generation,epoch});}
   if(input.action==='disable'||input.action==='drain'){
    const m=await this.workspaceTelemetry.meta();
    if(m.enabled&&m.epoch!==epoch)return error(401,'Telemetry authorization expired');
    if(m.enabled){this.metrics=freshMetrics();let drained;try{drained=await this.workspaceTelemetry.drainPending(this);}finally{const metrics=this.metrics;this.metrics=null;if(metrics.driveCalls)await this.workspaceTelemetry.addArchiveMetrics(metrics);}
     if(!drained)return json({...await this.workspaceTelemetry.status(),drainBlocked:true});
     if(input.action==='disable')await this.workspaceTelemetry.disable();
    }
   }else if(input.action==='status'||input.action==='flush'){const m=await this.workspaceTelemetry.meta();if(m.enabled&&m.epoch!==epoch)return error(409,'Archive authorization changed');if(input.action==='flush'){if(!m.enabled)return error(409,'Archive disabled');if(await this.workspaceTelemetry.requestFlush())await this.flushWorkspace();await this.workspaceTelemetry.arm();}}else return error(400,'Invalid telemetry action');
   return json({...await this.workspaceTelemetry.status(),regularUsage:(await this.ctx.storage.get('workspace-regular-usage'))||{},regularUsageLastBackup:await this.ctx.storage.get('workspace-regular-last-backup')||null,regularUsageNextBackup:await this.ctx.storage.get('workspace-regular-due')||null,regularUsageBackupError:await this.ctx.storage.get('workspace-regular-backup-error')||null});
  });
  if(url.pathname==='/workspace-telemetry/control')return this.serial(async()=>{
   const m=await this.workspaceTelemetry.meta(),epoch=await this.ctx.storage.get('authorizationEpoch')??null;
   if(!m.enabled||m.generation!==input.generation||m.epoch!==input.epoch||input.epoch!==epoch||!await this.ctx.storage.get('refresh'))return error(403,'Telemetry capability revoked');
   if(!['status','drain','disable'].includes(input.action))return error(400,'Invalid telemetry action');
   if(input.action!=='status'){
    this.metrics=freshMetrics();let drained;try{drained=await this.workspaceTelemetry.drainPending(this);}finally{this.metrics=null;}
    if(!drained)return json({...await this.workspaceTelemetry.status(),drainBlocked:true});
    if(input.action==='disable')await this.workspaceTelemetry.disable();
   }
   return json(await this.workspaceTelemetry.status());
  });
  if(url.pathname==='/workspace-telemetry/append')return this.serial(async()=>{
   const m=await this.workspaceTelemetry.meta();if(!m.enabled||m.generation!==input.generation||m.epoch!==input.epoch||input.epoch!==(await this.ctx.storage.get('authorizationEpoch')??null)||!await this.ctx.storage.get('refresh'))return error(403,'Telemetry capability revoked');
   return json(await this.workspaceTelemetry.append(input.events,Date.now(),input.generation));
  });
  if(url.pathname!=='/api')return error(404,'Unknown account operation');
  const queuedAt=Date.now();
  const run=async()=>{const started=Date.now();let scope=null,samples=null,label=null,response,measurementEpoch,measure=false;
   try{
    const session=await this.ctx.storage.get(`session:${input.sid}`),epoch=await this.ctx.storage.get('authorizationEpoch')??null;
    if(!session||session.exp<=Date.now()||(session.epoch??null)!==epoch){if(session)await this.ctx.storage.delete(`session:${input.sid}`);return input.path==='/status'?json({connected:false}):error(401,'Session expired or revoked; reconnect Google Drive');}
    measure=(input.method==='POST'&&(input.path==='/profiles'||/^\/profiles\/[A-Za-z0-9_-]{1,80}\/apps\/[a-z][a-z0-9-]{0,31}\/commit$/.test(input.path)))||(input.method==='PATCH'&&/^\/profiles\/[A-Za-z0-9_-]{1,80}$/.test(input.path));measurementEpoch=epoch;
    if(input.path==='/logout'&&input.method==='POST'){await this.ctx.storage.delete(`session:${input.sid}`);return json({disconnected:true});}
    if(input.path==='/revoke'&&input.method==='POST')return await this.revokeAuthorization(input);
    // A session-specific digest is used only for piggyback routing, not auth,
    // and is never stored in the telemetry journal or Drive files.
    if(this.env.NETWORK_TELEMETRY!=='off'&&await this.telemetry.enabled()){
     try{scope=hex(await crypto.subtle.digest('SHA-256',enc.encode('pwa-telemetry-v1:'+input.sid)));samples=readClientSamples(input.telemetry,scope);label=classifyRequest(input.method,input.path,input.telemetryApp);}catch{}
    }
    if((input.path==='/usage/profiles'&&['GET','POST'].includes(input.method))||(input.path==='/usage/profile-scope'&&input.method==='GET')){
     const s=this.ctx.storage;let scope=await s.get('profile-usage-scope');if(!scope){scope=rand();await s.put('profile-usage-scope',scope);}if(input.path==='/usage/profile-scope')return json({scope});const old=await s.get('profile-usage-rows')||[];
     if(input.method==='GET')return json({scope,rows:mergeProfileRows(old,[],scope)});
     if(typeof input.body!=='string'||input.body.length>24000)return error(400,'Invalid usage snapshots');try{const data=JSON.parse(input.body);if(data.scope!==scope)return error(409,'Usage account changed');const rows=mergeProfileRows(old,data.rows,scope);await s.put('profile-usage-rows',rows);const due=await s.get('workspace-regular-due')||Math.max(Date.now()+3600000,(await s.get('workspace-regular-last-backup')||0)+86400000);await s.put('workspace-regular-due',due);await this.armRegularUsage(due);return json({accepted:true});}catch{return error(400,'Invalid or excessive usage snapshots');}
    }
    if(input.path==='/usage/azure-speech'&&input.method==='POST'){if(!await this.ctx.storage.get('refresh'))return error(401,'Usage authorization expired');if(typeof input.body!=='string'||input.body.length>2048)return error(400,'Invalid usage sample');let sample;try{sample=JSON.parse(input.body);}catch{return error(400,'Invalid usage sample');}return await this.recordProviderUsage('azure-speech',sample);}
    if(input.path==='/status'&&input.method==='GET')response=json({connected:true,email:session.email});
    else{this.metrics=freshMetrics();response=await this.route(input);}
   }catch(e){const msg=String(e.message||e);const code=/Drive API (403|404|429|5\d\d)/.exec(msg)?.[1];response=msg.startsWith('Google authorization expired')?error(401,msg):msg.startsWith('Conflict:')?error(409,msg.slice(9)):error(502,code?`Google Drive returned HTTP ${code}; local data is safe. Retry or check Cloudflare logs.`:'Google Drive operation failed. Local data is safe; retry later.',{stage:input.path});}
   finally{if(!response)this.metrics=null;}
   const metrics=this.metrics;this.metrics=null;
   const headers=new Headers(response.headers);
   if(metrics)for(const [key,value] of Object.entries(metrics))headers.set(`X-PWA-${key}`,String(value));
   if(metrics?.driveCalls>0&&/^\/profiles\/[A-Za-z0-9_-]{1,80}(?:\/|$)/.test(input.path))try{const s=this.ctx.storage;let usageScope=await s.get('profile-usage-scope');if(!usageScope){usageScope=rand();await s.put('profile-usage-scope',usageScope);}headers.set('X-PWA-Profile-Usage-Scope',usageScope);}catch{}
   if(scope){
    headers.set('X-PWA-Telemetry-Scope',scope);
    try{const records=samples?[...samples]:[];
     if(label)records.push(requestSample({label,status:response.status,queueMs:started-queuedAt,serviceMs:Date.now()-started,requestChars:typeof input.body==='string'?input.body.length:0,responseChars:responseLengths.get(response),metrics}));
     if(records.length&&await this.appendTelemetry(records)&&samples)headers.set('X-PWA-Telemetry-Ack','1');
    }catch{} // Telemetry can never change the response or sync outcome.
   }
   // Selected profile mutations only; account-coordinator service time, not edge CPU/billing.
   if(measure)try{const m=await this.workspaceTelemetry.meta();if(m.enabled&&m.epoch===measurementEpoch){const event=createEvent('cloudflare-worker','request',{app:'pwa-google-drive',appVersion:pkg.version,coverage:'partial',status:response.status,outcome:response.status>=400?'error':'success',severity:response.status>=500?'error':response.status>=400?'warning':'info',metrics:{requests:1,durationMs:Date.now()-started,queueMs:started-queuedAt}});if(event)await this.workspaceTelemetry.append([event]);}}catch{}
   return new Response(response.body,{status:response.status,headers});
  };
  return this.serial(run);
 }
 // No Drive files are removed. The account epoch makes every prior session unusable,
 // even if deleting an individual expired session fails. Serialize with other account work.
 async revokeAuthorization(input){
  let body;try{body=JSON.parse(input.body||'{}');}catch{return error(400,'Invalid revocation confirmation');}
  if(body.confirm!=='REVOKE')return error(400,'Explicit account revocation confirmation required');
  const encrypted=await this.ctx.storage.get('refresh');
  if(!encrypted)return error(409,'Stored authorization is missing; remove access in Google Account settings and reconnect if needed.');
  const token=await decrypt(encrypted,this.env);
  let response;
  try{response=await fetch('https://oauth2.googleapis.com/revoke',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token})});}
  catch{return error(502,'Google revocation could not be confirmed. No local authorization was removed; retry.');}
  const googleRevocationConfirmed=response.ok;
  if(!googleRevocationConfirmed){
   const detail=await response.json().catch(()=>({}));
   // A rejected token is not proof the whole Google grant has been revoked.
   // Remove the unusable local authority, but report the distinction explicitly.
   if(response.status!==400||detail.error!=='invalid_token')return error(502,'Google revocation could not be confirmed. Retry or remove access in Google Account settings.');
  }
  const epoch=rand();this.access=null;this.folderCache.clear();
  await this.ctx.storage.transaction(async tx=>{await tx.put('authorizationEpoch',epoch);await tx.delete('refresh');});
  try{await this.cleanSessions(epoch);}catch{} // old sessions are already invalidated
  try{await this.workspaceTelemetry.disable();}catch{}
  try{await this.telemetry.clear();}catch{} // exported telemetry remains in Drive
  return json({revoked:googleRevocationConfirmed,disconnected:true,storedAuthorizationRemoved:true});
 }
 async cleanSessions(epoch){
  let startAfter;
  do{
   const entries=await this.ctx.storage.list({prefix:'session:',limit:128,...(startAfter?{startAfter}:{})});
   const expired=[];for(const [key,session] of entries){startAfter=key;if(session.exp<=Date.now()||(session.epoch??null)!==epoch)expired.push(key);}
   if(expired.length)await this.ctx.storage.delete(expired);
   if(entries.size<128)break;
  }while(startAfter);
 }
 serial(fn){const next=this.queue.then(fn,fn);this.queue=next.then(()=>{},()=>{});return next;}
 async token(){if(this.access?.exp>Date.now()+60000)return this.access.value;
  const encrypted=await this.ctx.storage.get('refresh');if(!encrypted)throw Error('Google authorization expired: reconnect Google Drive');
  const refresh=await decrypt(encrypted,this.env);
  let result;try{result=await googleToken(this.env,{client_id:this.env.GOOGLE_CLIENT_ID,client_secret:this.env.GOOGLE_CLIENT_SECRET,refresh_token:refresh,grant_type:'refresh_token'});}catch(e){if(e.status===400||e.status===401||e.status===403)throw Error('Google authorization expired: reconnect Google Drive');throw Error('Temporary Google token service failure');}
  this.access={value:result.access_token,exp:Date.now()+Math.min(Number(result.expires_in)||3600,3600)*1000};return this.access.value;
 }
 bump(key,n=1){if(this.metrics)this.metrics[key]=(this.metrics[key]||0)+n;}
 async timed(key,fn){const start=Date.now();try{return await fn();}finally{this.bump(key,Date.now()-start);}}
 async maintenance(operation,app,fn){
  const start=Date.now(),previous=this.metrics;this.metrics=freshMetrics();let status=200;
  try{return await fn();}catch(e){status=502;throw e;}finally{
   const metrics=this.metrics;this.metrics=previous;
   if(this.env.NETWORK_TELEMETRY!=='off')try{await this.appendTelemetry([requestSample({label:{kind:'maintenance',operation,app},status,queueMs:0,serviceMs:Date.now()-start,requestChars:0,responseChars:0,metrics})]);}catch{}
  }
 }
 async drive(url,options={}){
  // Only retry safe reads automatically. Ambiguous create/commit writes must
  // resume through the immutable revision/object reconciliation protocol.
  const safe=(options.method||'GET')==='GET';let refreshed=false;
  for(let attempt=0;;attempt++){
   const token=await this.token();let res;
   this.bump('driveCalls');const started=Date.now();
   const timing=()=>{const elapsed=Date.now()-started;if(this.metrics){this.bump('driveHeaderMs',elapsed);this.metrics.driveHeaderMaxMs=Math.max(this.metrics.driveHeaderMaxMs||0,elapsed);}};
   try{res=await fetch(url,{...options,headers:{Authorization:`Bearer ${token}`,...options.headers}});timing();}
   catch(e){timing();this.bump('driveNetworkErrors');if(!safe||attempt>=2)throw Error('Drive network request failed');this.bump('driveRetries');await wait(250*2**attempt+Math.random()*150);continue;}
   if(res.ok)return res;
   if(res.status>=500)this.bump('drive5xx');else if(res.status>=400)this.bump('drive4xx');if(res.status===429)this.bump('drive429');
   if(res.status===404)this.folderCache.clear();
   if(res.status===401){this.access=null;if(safe&&!refreshed&&attempt<2){refreshed=true;this.bump('driveRetries');continue;}throw Error('Google authorization expired: reconnect Google Drive');}
   let rateLimited=res.status===429||res.status>=500;
   if(res.status===403){const detail=await res.clone().json().catch(()=>null);rateLimited=!!detail?.error?.errors?.some(e=>['rateLimitExceeded','userRateLimitExceeded'].includes(e.reason));}
   if(!safe||!rateLimited||attempt>=2)throw Error(`Drive API ${res.status}`);
   this.bump('driveRetries');const retry=res.headers.get('Retry-After');
   const delay=retry?(Number.isFinite(Number(retry))?Number(retry)*1000:Date.parse(retry)-Date.now()):0;
   // A long server-requested delay is left to the client scheduler instead of
   // blocking every other account operation in the serialized queue.
   if(delay>5000)throw Error(`Drive API ${res.status}`);
   await wait(Math.max(250*2**attempt+Math.random()*150,delay||0));
  }
 }
 async list(parent,name=null,telemetryMetadata=false){const result=[];let page=null;
  const quote=v=>`'${v.replace(/\\/g,'\\\\').replace(/'/g,"\\'")}'`;
  const names=Array.isArray(name)?name:name?[name]:[];
  const filter=names.length?` and (${names.map(n=>`name = ${quote(n)}`).join(' or ')})`:'';
  do{const params=new URLSearchParams({q:`${quote(parent)} in parents and trashed = false${filter}`,fields:telemetryMetadata?'nextPageToken,files(id,name,mimeType,createdTime,modifiedTime,size,appProperties)':'nextPageToken,files(id,name,mimeType,createdTime,modifiedTime)',pageSize:'1000'});if(page)params.set('pageToken',page);
   const json=await (await this.drive(`${DRIVE}?${params}`)).json();result.push(...(json.files||[]));page=json.nextPageToken||null;
  }while(page);return result;
 }
 async telemetryStorageQuota(){const r=await this.drive('https://www.googleapis.com/drive/v3/about?fields=storageQuota');const data=(await r.json()).storageQuota||{};const out={};for(const k of ['limit','usage','usageInDrive','usageInDriveTrash'])if(typeof data[k]==='string'&&/^\d+$/.test(data[k])&&Number.isSafeInteger(Number(data[k])))out[k]=Number(data[k]);return out;}
 async listTelemetry(parent){const files=[];let page=null;for(let i=0;i<4;i++){
  const params=new URLSearchParams({q:`'${parent.replace(/'/g,"\\'")}' in parents and trashed = false and appProperties has { key='pwaTelemetry' and value='v2' }`,fields:'nextPageToken,files(id,name,size,appProperties)',pageSize:'1000',orderBy:'name'});if(page)params.set('pageToken',page);
  const data=await (await this.drive(`${DRIVE}?${params}`)).json();files.push(...(data.files||[]));page=data.nextPageToken||null;if(!page)return {files,complete:true};
 }return {files,complete:false};}
 async folder(parent,name,create=false){
  const key=JSON.stringify([parent,name]),cached=this.folderCache.get(key);
  if(cached?.expires>Date.now())return cached.id;
  const existing=(await this.list(parent,name)).find(f=>f.mimeType===FOLDER);
  const id=existing?.id||(create?(await this.createMetadata({name,mimeType:FOLDER,parents:[parent]})).id:null);
  if(id){if(this.folderCache.size>=128)this.folderCache.clear();this.folderCache.set(key,{id,expires:Date.now()+FOLDER_TTL});}return id;
 }
 /** A positive, expiring account-local index. No negative entries are trusted.
  * Cold large snapshots scan once; small misses query only the requested names.
  * Storage failures fail closed rather than trusting unrecorded existence. */
 async resolveObjects(folder,hashes,{force=false}={}){
  const unique=[...new Set(hashes)],found=new Map(),missing=[],now=Date.now();
  for(const group of groups(unique,128)){
   const entries=force?new Map():await this.ctx.storage.get(group.map(h=>indexKey(folder,h)));
   for(const hash of group){const record=entries.get(indexKey(folder,hash));
    if(record?.id&&record.checkedAt>now-INDEX_TTL){found.set(hash,record.id);this.bump('indexHits');}
    else{missing.push(hash);this.bump('indexMisses');}
   }
  }
  if(!missing.length)return found;
  let files=[];
  if(missing.length>32){this.bump('objectScans');files=await this.list(folder);}
  else for(const group of groups(missing,16))files.push(...await this.list(folder,group.map(h=>`${h}.json`)));
  const wanted=new Set(missing),records=new Map();
  for(const file of files){const match=/^([a-f0-9]{64})\.json$/.exec(file.name);if(!match||!wanted.has(match[1])||!file.id||file.mimeType===FOLDER||records.has(match[1]))continue;records.set(match[1],file.id);}
  for(const group of groups(missing,128)){
   const updates={},absent=[];
   for(const hash of group){const id=records.get(hash),key=indexKey(folder,hash);if(id){updates[key]={id,checkedAt:now};found.set(hash,id);}else absent.push(key);}
   if(Object.keys(updates).length)await this.ctx.storage.put(updates);
   if(absent.length)await this.ctx.storage.delete(absent);
  }
  return found;
 }
 async rememberObject(folder,hash,id){if(!id)throw Error('Drive did not return a backup object ID');await this.ctx.storage.put(indexKey(folder,hash),{id,checkedAt:Date.now()});}
 async readObject(folder,hash,id){
  // Verify bytes even on index hits. Repair a stale ID once, never return
  // unverified content (including a manually edited or replaced Drive file).
  for(let attempt=0;attempt<2;attempt++){
   if(!id)throw Error('Missing backup section');
   try{const text=await this.content(id);if(hex(await crypto.subtle.digest('SHA-256',enc.encode(text)))===hash)return JSON.parse(text);}
   catch(e){if(!String(e.message).includes('Drive API 404'))throw e;}
   await this.ctx.storage.delete(indexKey(folder,hash));
   if(attempt===0)id=(await this.resolveObjects(folder,[hash],{force:true})).get(hash);
  }
  throw Error('Stored backup section failed integrity check');
 }
 async createMetadata(body){return (await this.drive(DRIVE,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).json();}
 async content(id){const r=await this.drive(`${DRIVE}/${encodeURIComponent(id)}?alt=media`);return r.text();}
 async createJSON(parent,name,text,metadata={}){const boundary=`pwa_${rand().replace(/-/g,'')}`;
  const body=`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({name,mimeType:'application/json',parents:[parent],...metadata})}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${text}\r\n--${boundary}--`;
  return (await this.drive(`${UPLOAD}?uploadType=multipart`,{method:'POST',headers:{'Content-Type':`multipart/related; boundary=${boundary}`},body})).json();
 }
 async replaceJSON(id,text){await this.drive(`${UPLOAD}/${encodeURIComponent(id)}?uploadType=media`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:text});}
 async remove(id){await this.drive(`${DRIVE}/${encodeURIComponent(id)}`,{method:'DELETE'});}
 async root(create=false){return this.folder('root',ROOT,create);}
 async folders(create=false){const root=await this.root(create);if(!root)return null;return {root,profiles:await this.folder(root,'profiles',create),objects:await this.folder(root,'objects',create)};}
 async profile(id,create=false){const folders=await this.folders(create);if(!folders?.profiles)return null;return this.folder(folders.profiles,id,create);}
 async meta(parent){const file=(await this.list(parent,'meta.json'))[0];return file?JSON.parse(await this.content(file.id)):null;}
 async appFolder(profileId,appId,create=false){const profile=await this.profile(profileId,create);return profile?this.folder(profile,appId,create):null;}
 async head(profileId,appId,revisionName=null){const folder=await this.appFolder(profileId,appId,false);if(!folder)return {folder:null,file:null,head:null};
   // One Drive metadata request can locate both the live head and the retry's
   // immutable revision. Still read the real head; never trust a cached CAS.
   const files=await this.list(folder,revisionName?['head.json',revisionName]:'head.json');
   const file=files.find(f=>f.name==='head.json')||null;
   return {folder,file,head:file?JSON.parse(await this.content(file.id)):null,
    ...(revisionName?{stagedFile:files.find(f=>f.name===revisionName)||null}:{})};}
 async route(input){const {method,path,body}=input;const segments=path.split('/').filter(Boolean),payload=body?JSON.parse(body):{};
  if(method==='GET'&&path==='/profiles'){
   const folders=await this.folders(false);if(!folders?.profiles)return json({profiles:[]});const listing=await this.list(folders.profiles);const result=[];
   for(const folder of listing.filter(f=>f.mimeType===FOLDER)){const meta=await this.meta(folder.id);if(meta?.id===folder.name)result.push(meta);}
   return json({profiles:result});
  }
  if(method==='POST'&&path==='/profiles'){
   const id=payload.id,name=String(payload.name||'').trim().slice(0,64);if(!ID.test(id)||!name)return error(400,'Invalid profile');
   const parent=await this.profile(id,true);const old=await this.meta(parent);if(old)return json({profile:old});
   const meta={id,name,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};await this.createJSON(parent,'meta.json',JSON.stringify(meta));return json({profile:meta},201);
  }
  if(segments[0]==='profiles'&&ID.test(segments[1]||'')){
   const id=segments[1];
   if(segments.length===2&&method==='PATCH'){
    const folder=await this.profile(id);if(!folder)return error(404,'Profile not found');const old=await this.meta(folder);if(!old)return error(404,'Profile metadata unavailable');const name=String(payload.name||'').trim().slice(0,64);if(!name)return error(400,'Profile name is required');old.name=name;old.updatedAt=new Date().toISOString();const file=(await this.list(folder,'meta.json'))[0];await this.replaceJSON(file.id,JSON.stringify(old));return json({profile:old});
   }
   if(segments[2]==='apps'&&/^[a-z][a-z0-9-]{0,31}$/.test(segments[3]||'')){
    const appId=segments[3];
    if(segments[4]==='head'&&method==='GET'){const h=await this.head(id,appId);return json({head:h.head});}
    if(segments[4]==='history'&&method==='GET'){
     const folder=await this.appFolder(id,appId);if(!folder)return json({history:[]});const files=(await this.list(folder)).filter(f=>/^r_[\w-]+\.json$/.test(f.name));const history=[];
     for(const f of files){try{const item=JSON.parse(await this.content(f.id));history.push({id:item.id,at:item.at,parent:item.parent});}catch{}}
     return json({history:history.sort((a,b)=>b.at.localeCompare(a.at))});
    }
    if(segments[4]==='revisions'&&ID.test(segments[5]||'')&&method==='GET'){
     const folder=await this.appFolder(id,appId);if(!folder)return error(404,'Unknown app');const file=(await this.list(folder,`r_${segments[5]}.json`))[0];if(!file)return error(404,'Revision not found');return json({revision:JSON.parse(await this.content(file.id))});
    }
    if(segments[4]==='commit'&&method==='POST'){
     const revision=checkRevision(payload.revision),revisionName=`r_${revision.id}.json`,h=await this.timed('commitHeadMs',()=>this.head(id,appId,revisionName));const current=h.head,folder=h.folder||await this.appFolder(id,appId,true);
     if(current?.operationId===revision.operationId)return json({head:current,idempotent:true});
     if((current?.id||null)!==(payload.expected??null))return error(409,'Confirmed revision divergence',{head:current});
     if(revision.parent!==(payload.expected??null))return error(400,'Revision parent mismatch');
     const objects=(await this.folders(true)).objects;
     const hashes=[...new Set(Object.values(revision.sections))],present=await this.timed('commitObjectsMs',()=>this.resolveObjects(objects,hashes));
     const missingHashes=hashes.filter(hash=>!present.has(hash));
     if(missingHashes.length)return error(422,'Revision references missing backup sections',{missingHashes});
     // Revision creation and head update are separate Drive requests. If the
     // first succeeded and the second failed, retry the SAME revision ID.
     const revisionStarted=Date.now();
     const existingRevision=h.stagedFile!==undefined?h.stagedFile:(await this.list(folder,revisionName))[0];
     let committedRevision=revision;
     if(existingRevision){
       const staged=checkRevision(JSON.parse(await this.content(existingRevision.id)));
       // The timestamp naturally changes between attempts; immutable identity
       // and actual snapshot content must match, not the retry wall clock.
       if(staged.operationId!==revision.operationId||staged.parent!==revision.parent||
          JSON.stringify(staged.sections)!==JSON.stringify(revision.sections)||
          JSON.stringify(staged.meta)!==JSON.stringify(revision.meta))
         return error(409,'Revision ID already belongs to different content');
       committedRevision=staged;
     }else await this.createJSON(folder,revisionName,JSON.stringify(revision));
     this.bump('commitRevisionMs',Date.now()-revisionStarted);
     await this.timed('commitPublishMs',async()=>{if(h.file)await this.replaceJSON(h.file.id,JSON.stringify(committedRevision));else await this.createJSON(folder,'head.json',JSON.stringify(committedRevision));});
     // Successful cloud commit must not wait for pruning or mark/sweep.
     // Durable Object storage persists maintenance checkpoints across restarts.
     this.ctx.waitUntil(this.serial(async()=>{
       try{
         const pruneKey=`last-prune:${folder}`;
         const lastPrune=await this.ctx.storage.get(pruneKey)||0;
         if(Date.now()-lastPrune>24*3600000){
           await this.maintenance('retention_prune',classifyRequest('POST',path)?.app||'other',()=>this.prune(folder,revision.id));
           await this.ctx.storage.put(pruneKey,Date.now());
         }
         const last=await this.ctx.storage.get('last-gc')||0;
         if(Date.now()-last>7*86400000){
           await this.maintenance('object_gc','other',()=>this.collectGarbage());
           await this.ctx.storage.put('last-gc',Date.now());
         }
       }catch{} // Maintenance must never turn a successful backup into a failure.
     }));
     return json({head:committedRevision});
    }
   }
  }
  if(method==='POST'&&path==='/objects/missing'){
   const hashes=payload.hashes;
   if(!Array.isArray(hashes)||!hashes.length||hashes.length>128||hashes.some(hash=>typeof hash!=='string'||!SHA.test(hash)))return error(400,'Invalid object availability batch');
   const objects=(await this.folders(false))?.objects;
   if(!objects)return json({missing:[...new Set(hashes)]});
   const known=await this.resolveObjects(objects,hashes);
   return json({missing:[...new Set(hashes)].filter(hash=>!known.has(hash))});
  }
  if(method==='POST'&&path==='/objects/read-batch'){
   const hashes=payload.hashes;
   if(!Array.isArray(hashes)||!hashes.length||hashes.length>8||hashes.some(hash=>!SHA.test(hash)))return error(400,'Invalid download batch');
   const objects=(await this.folders(false))?.objects;
   if(!objects)return error(404,'Backup objects do not exist');
   const listing=await this.resolveObjects(objects,hashes);
   const result={};
   for(let i=0;i<hashes.length;i+=3){
    await settleBatch(hashes.slice(i,i+3).map(async hash=>{
     result[hash]=await this.readObject(objects,hash,listing.get(hash));
    }));
   }
   return json({objects:result});
  }
  if(method==='POST'&&path==='/objects/batch'){
   const batch=payload.objects;
   if(!Array.isArray(batch)||!batch.length||batch.length>12)return error(400,'Invalid section batch');
   const verified=[];
   let total=0;
   for(const item of batch){
    if(!item||!SHA.test(item.hash)||typeof item.content!=='string')return error(400,'Invalid section');
    const bytes=enc.encode(item.content);total+=bytes.length;
    if(bytes.length>16*1024*1024||total>1024*1024)return error(413,'Section batch too large');
    if(hex(await crypto.subtle.digest('SHA-256',bytes))!==item.hash)return error(400,'Section hash mismatch');
    verified.push(item);
   }
   const objects=(await this.folders(true)).objects;
   const known=await this.resolveObjects(objects,verified.map(item=>item.hash));
   const missing=[...new Map(verified.filter(item=>!known.has(item.hash)).map(item=>[item.hash,item])).values()];
   // Bounded concurrency prevents both excessive Drive calls and slow initial saves.
   for(let i=0;i<missing.length;i+=3){
    await settleBatch(missing.slice(i,i+3).map(async item=>{const created=await this.createJSON(objects,`${item.hash}.json`,item.content);await this.rememberObject(objects,item.hash,created.id);}));
   }
   return json({stored:verified.length,created:missing.length});
  }
  if(segments[0]==='objects'&&SHA.test(segments[1]||'')){
   const hash=segments[1];
   if(method==='PUT'){
    const text=body||'',bytes=enc.encode(text);if(bytes.length>16*1024*1024)return error(413,'Section is too large for a single upload');
    if(hex(await crypto.subtle.digest('SHA-256',bytes))!==hash)return error(400,'Section hash mismatch');
    const objects=(await this.folders(true)).objects;
    const known=await this.resolveObjects(objects,[hash]);
    if(!known.has(hash)){const created=await this.createJSON(objects,`${hash}.json`,text);await this.rememberObject(objects,hash,created.id);}
    return json({stored:true,created:known.has(hash)?0:1});
   }
   if(method==='GET'){
    const folders=await this.folders(false);if(!folders?.objects)return error(404,'Unknown section');const id=(await this.resolveObjects(folders.objects,[hash])).get(hash);if(!id)return error(404,'Missing section');
    return json({value:await this.readObject(folders.objects,hash,id)});
   }
  }
  return error(404,'Unknown profile operation');
 }
 async collectGarbage(){
  const folders=await this.folders(false);if(!folders?.profiles||!folders?.objects)return;
  const referenced=new Set();const profiles=await this.list(folders.profiles);
  for(const p of profiles.filter(f=>f.mimeType===FOLDER)){
   const apps=await this.list(p.id);
   for(const app of apps.filter(f=>f.mimeType===FOLDER)){
    const revisions=await this.list(app.id);
    for(const group of groups(revisions.filter(f=>f.name==='head.json'||/^r_[\w-]+\.json$/.test(f.name)),3)){
     // Wait for all reads and validate every manifest before ANY deletion.
     const records=await settleBatch(group.map(async file=>checkRevision(JSON.parse(await this.content(file.id)))));
     for(const record of records)for(const hash of Object.values(record.sections))referenced.add(hash);
    }
   }
  }
  const objects=await this.list(folders.objects);
  for(const file of objects){
   const match=/^([a-f0-9]{64})\.json$/.exec(file.name);
   if(!match||referenced.has(match[1]))continue;
   const at=Date.parse(file.createdTime);
   // Keep newly staged uploads, unknown timestamps, and a full seven-day
   // rollback window. Failed uploads are resumable after content GC.
   if(!Number.isFinite(at)||Date.now()-at<7*86400000)continue;
   // Invalidate before deletion so a failed/ambiguous DELETE cannot leave
   // a positive cache entry for a removed object.
   await this.ctx.storage.delete(indexKey(folders.objects,match[1]));
   await this.remove(file.id);
  }
 }
 async prune(folder,headId){
  const files=(await this.list(folder)).filter(f=>/^r_[\w-]+\.json$/.test(f.name)),items=[];
  for(const group of groups(files,3))items.push(...await settleBatch(group.map(async file=>{const item=checkRevision(JSON.parse(await this.content(file.id)));return {id:item.id,at:item.at,file};})));
  const keep=retainedIds(items);keep.add(headId);
  for(const item of items)if(!keep.has(item.id))await this.remove(item.file.id);
  // Content objects remain safe for forks and in-flight uploads. A dedicated,
  // verified mark-and-sweep maintenance operation can reclaim orphans later.
 }
}
