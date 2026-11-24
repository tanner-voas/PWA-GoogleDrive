import {retainedIds,checkRevision} from '../src/retention.js';
const PREFIX='/_profiles/v1',ROOT='AppLauncher Profiles',DRIVE='https://www.googleapis.com/drive/v3/files',UPLOAD='https://www.googleapis.com/upload/drive/v3/files';
const ID=/^[A-Za-z0-9_-]{1,80}$/,SHA=/^[a-f0-9]{64}$/,FOLDER='application/vnd.google-apps.folder';
const enc=new TextEncoder(),dec=new TextDecoder();
const json=(object,status=200,extra={})=>new Response(JSON.stringify(object),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',...extra}});
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
async function googleToken(env,body){const res=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(body)});if(!res.ok)throw Error('Google OAuth token exchange failed');return res.json();}
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
  if(!session||!/^\d+$/.test(String(session.sub))||!ID.test(session.sid||''))return path==='/status'?json({connected:false}):error(401,'Connect Google Drive to continue');
  if(request.method!=='GET'){
   const origin=request.headers.get('Origin'),site=request.headers.get('Sec-Fetch-Site');
   if(request.headers.get('X-PWA-CSRF')!=='1'||(origin&&origin!==url.origin)||site==='cross-site')return error(403,'Invalid request origin or CSRF guard');
  }
  const stub=env.ACCOUNTS.get(env.ACCOUNTS.idFromName(session.sub));
  const response=await internal(stub,'/api',{sid:session.sid,method:request.method,path,body:request.method==='GET'?null:await request.text()});
  if((path==='/logout'||path==='/revoke')&&response.ok){const headers=new Headers(response.headers);headers.append('Set-Cookie',cookie(SESSION,'',0));return new Response(response.body,{status:response.status,headers});}
  return response;
 }catch(e){return error(502,e.message==='Google OAuth token exchange failed'?e.message:'Cloud synchronization request failed');}
}};

export class AccountCoordinator {
 constructor(ctx,env){this.ctx=ctx;this.env=env;this.access=null;this.queue=Promise.resolve();this.lastPrune=0;}
 async fetch(request){const url=new URL(request.url);let input;try{input=await request.json();}catch{return error(400,'Invalid request');}
  if(url.pathname==='/login'){
   const run=async()=>{
    if(input.refresh){await this.ctx.storage.put('refresh',input.refresh);this.access=null;}
    if(!(await this.ctx.storage.get('refresh')))return error(401,'Google did not issue offline authorization. Reconnect and consent again.');
    const epoch=await this.ctx.storage.get('authorizationEpoch')??null;
    await this.ctx.storage.put(`session:${input.sid}`,{exp:input.exp,email:input.email,epoch});
    try{await this.cleanSessions(epoch);}catch{} // best-effort cleanup; never block a valid login
    return json({ok:true});
   };
   return this.serial(run);
  }
  if(url.pathname!=='/api')return error(404,'Unknown account operation');
  const run=async()=>{try{
   const session=await this.ctx.storage.get(`session:${input.sid}`),epoch=await this.ctx.storage.get('authorizationEpoch')??null;
   if(!session||session.exp<=Date.now()||(session.epoch??null)!==epoch){if(session)await this.ctx.storage.delete(`session:${input.sid}`);return input.path==='/status'?json({connected:false}):error(401,'Session expired or revoked; reconnect Google Drive');}
   if(input.path==='/logout'&&input.method==='POST'){await this.ctx.storage.delete(`session:${input.sid}`);return json({disconnected:true});}
   if(input.path==='/revoke'&&input.method==='POST')return await this.revokeAuthorization(input);
   if(input.path==='/status'&&input.method==='GET')return json({connected:true,email:session.email});
   return await this.route(input);
  }catch(e){const msg=String(e.message||e);if(msg.startsWith('Google authorization expired'))return error(401,msg);if(msg.startsWith('Conflict:'))return error(409,msg.slice(9));const code=/Drive API (403|404|429|5\d\d)/.exec(msg)?.[1];return error(502,code?`Google Drive returned HTTP ${code}; local data is safe. Retry or check Cloudflare logs.`:'Google Drive operation failed. Local data is safe; retry later.',{stage:input.path});}};
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
  const epoch=rand();this.access=null;
  await this.ctx.storage.transaction(async tx=>{await tx.put('authorizationEpoch',epoch);await tx.delete('refresh');});
  try{await this.cleanSessions(epoch);}catch{} // old sessions are already invalidated
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
  let result;try{result=await googleToken(this.env,{client_id:this.env.GOOGLE_CLIENT_ID,client_secret:this.env.GOOGLE_CLIENT_SECRET,refresh_token:refresh,grant_type:'refresh_token'});}catch{throw Error('Google authorization expired: reconnect Google Drive');}
  this.access={value:result.access_token,exp:Date.now()+Math.min(Number(result.expires_in)||3600,3600)*1000};return this.access.value;
 }
 async drive(url,options={}){const token=await this.token();const res=await fetch(url,{...options,headers:{Authorization:`Bearer ${token}`,...options.headers}});
  if(!res.ok){if(res.status===401){this.access=null;throw Error('Google authorization expired: reconnect Google Drive');}throw Error(`Drive API ${res.status}`);}return res;
 }
 async list(parent,name=null){const result=[];let page=null;
  do{const params=new URLSearchParams({q:`'${parent.replace(/'/g,"\\'")}' in parents and trashed = false${name?` and name = '${name.replace(/'/g,"\\'")}'`:''}`,fields:'nextPageToken,files(id,name,mimeType,createdTime,modifiedTime)',pageSize:'1000'});if(page)params.set('pageToken',page);
   const json=await (await this.drive(`${DRIVE}?${params}`)).json();result.push(...(json.files||[]));page=json.nextPageToken||null;
  }while(page);return result;
 }
 async folder(parent,name,create=false){const existing=(await this.list(parent,name)).find(f=>f.mimeType===FOLDER);if(existing)return existing.id;
  return create?(await this.createMetadata({name,mimeType:FOLDER,parents:[parent]})).id:null;
 }
 async createMetadata(body){return (await this.drive(DRIVE,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).json();}
 async content(id){const r=await this.drive(`${DRIVE}/${encodeURIComponent(id)}?alt=media`);return r.text();}
 async createJSON(parent,name,text){const boundary=`pwa_${rand().replace(/-/g,'')}`;
  const body=`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({name,mimeType:'application/json',parents:[parent]})}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${text}\r\n--${boundary}--`;
  return (await this.drive(`${UPLOAD}?uploadType=multipart`,{method:'POST',headers:{'Content-Type':`multipart/related; boundary=${boundary}`},body})).json();
 }
 async replaceJSON(id,text){await this.drive(`${UPLOAD}/${encodeURIComponent(id)}?uploadType=media`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:text});}
 async remove(id){await this.drive(`${DRIVE}/${encodeURIComponent(id)}`,{method:'DELETE'});}
 async root(create=false){return this.folder('root',ROOT,create);}
 async folders(create=false){const root=await this.root(create);if(!root)return null;return {root,profiles:await this.folder(root,'profiles',create),objects:await this.folder(root,'objects',create)};}
 async profile(id,create=false){const folders=await this.folders(create);if(!folders?.profiles)return null;return this.folder(folders.profiles,id,create);}
 async meta(parent){const file=(await this.list(parent,'meta.json'))[0];return file?JSON.parse(await this.content(file.id)):null;}
 async appFolder(profileId,appId,create=false){const profile=await this.profile(profileId,create);return profile?this.folder(profile,appId,create):null;}
 async head(profileId,appId){const folder=await this.appFolder(profileId,appId,false);if(!folder)return {folder:null,file:null,head:null};const file=(await this.list(folder,'head.json'))[0]||null;
  return {folder,file,head:file?JSON.parse(await this.content(file.id)):null};}
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
     const revision=checkRevision(payload.revision),folder=await this.appFolder(id,appId,true);const h=await this.head(id,appId);const current=h.head;
     if(current?.operationId===revision.operationId)return json({head:current,idempotent:true});
     if((current?.id||null)!==(payload.expected??null))return error(409,'Confirmed revision divergence',{head:current});
     if(revision.parent!==(payload.expected??null))return error(400,'Revision parent mismatch');
     const objects=(await this.folders(true)).objects;
     const present=new Set((await this.list(objects)).map(f=>f.name));
     for(const hash of new Set(Object.values(revision.sections))){if(!present.has(`${hash}.json`))return error(400,'Revision references an unuploaded section');}
     // Revision creation and head update are separate Drive requests. If the
     // first succeeded and the second failed, retry the SAME revision ID.
     const revisionName=`r_${revision.id}.json`;
     const existingRevision=(await this.list(folder,revisionName))[0];
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
     if(h.file)await this.replaceJSON(h.file.id,JSON.stringify(committedRevision));
     else await this.createJSON(folder,'head.json',JSON.stringify(committedRevision));
     // Successful cloud commit must not wait for pruning or mark/sweep.
     // Durable Object storage persists maintenance checkpoints across restarts.
     this.ctx.waitUntil(this.serial(async()=>{
       try{
         const lastPrune=await this.ctx.storage.get('last-prune')||0;
         if(Date.now()-lastPrune>24*3600000){
           await this.prune(folder,revision.id);
           await this.ctx.storage.put('last-prune',Date.now());
         }
         const last=await this.ctx.storage.get('last-gc')||0;
         if(Date.now()-last>7*86400000){
           await this.collectGarbage();
           await this.ctx.storage.put('last-gc',Date.now());
         }
       }catch{} // Maintenance must never turn a successful backup into a failure.
     }));
     return json({head:committedRevision});
    }
   }
  }
  if(method==='POST'&&path==='/objects/read-batch'){
   const hashes=payload.hashes;
   if(!Array.isArray(hashes)||!hashes.length||hashes.length>8||hashes.some(hash=>!SHA.test(hash)))return error(400,'Invalid download batch');
   const objects=(await this.folders(false))?.objects;
   if(!objects)return error(404,'Backup objects do not exist');
   const listing=new Map((await this.list(objects)).map(f=>[f.name,f.id]));
   const result={};
   for(let i=0;i<hashes.length;i+=3){
    await Promise.all(hashes.slice(i,i+3).map(async hash=>{
     const id=listing.get(`${hash}.json`);if(!id)throw Error('Missing backup section');
     const content=await this.content(id);
     if(hex(await crypto.subtle.digest('SHA-256',enc.encode(content)))!==hash)throw Error('Stored backup section failed integrity check');
     result[hash]=JSON.parse(content);
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
   const known=new Set((await this.list(objects)).map(f=>f.name));
   const missing=[...new Map(verified.filter(item=>!known.has(`${item.hash}.json`)).map(item=>[item.hash,item])).values()];
   // Bounded concurrency prevents both excessive Drive calls and slow initial saves.
   for(let i=0;i<missing.length;i+=3){
    await Promise.all(missing.slice(i,i+3).map(item=>this.createJSON(objects,`${item.hash}.json`,item.content)));
   }
   return json({stored:verified.length,created:missing.length});
  }
  if(segments[0]==='objects'&&SHA.test(segments[1]||'')){
   const hash=segments[1];
   if(method==='PUT'){
    const text=body||'',bytes=enc.encode(text);if(bytes.length>16*1024*1024)return error(413,'Section is too large for a single upload');
    if(hex(await crypto.subtle.digest('SHA-256',bytes))!==hash)return error(400,'Section hash mismatch');
    const objects=(await this.folders(true)).objects;
    if(!(await this.list(objects,`${hash}.json`)).length)await this.createJSON(objects,`${hash}.json`,text);
    return json({stored:true});
   }
   if(method==='GET'){
    const folders=await this.folders(false);if(!folders)return error(404,'Unknown section');const file=(await this.list(folders.objects,`${hash}.json`))[0];if(!file)return error(404,'Missing section');
    const text=await this.content(file.id);if(hex(await crypto.subtle.digest('SHA-256',enc.encode(text)))!==hash)return error(502,'Stored section failed integrity check');return json({value:JSON.parse(text)});
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
    for(const file of revisions.filter(f=>f.name==='head.json'||/^r_[\w-]+\.json$/.test(f.name))){
     // An incomplete/malformed historical record must STOP garbage collection.
     const record=JSON.parse(await this.content(file.id));checkRevision(record);
     for(const hash of Object.values(record.sections))referenced.add(hash);
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
   await this.remove(file.id);
  }
 }
 async prune(folder,headId){
  const files=(await this.list(folder)).filter(f=>/^r_[\w-]+\.json$/.test(f.name)),items=[];
  for(const file of files){const item=checkRevision(JSON.parse(await this.content(file.id)));items.push({id:item.id,at:item.at,file});}
  const keep=retainedIds(items);keep.add(headId);
  for(const item of items)if(!keep.has(item.id))await this.remove(item.file.id);
  // Content objects remain safe for forks and in-flight uploads. A dedicated,
  // verified mark-and-sweep maintenance operation can reclaim orphans later.
 }
}
