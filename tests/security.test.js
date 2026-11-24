import test from 'node:test';
import assert from 'node:assert/strict';
import worker,{AccountCoordinator} from '../worker/index.js';
const enc=new TextEncoder();
const env={SESSION_SIGNING_KEY:'test-signing-key',VAULT_KEY:Buffer.alloc(32,7).toString('base64url'),GOOGLE_CLIENT_ID:'test-client',GOOGLE_CLIENT_SECRET:'test-secret',ALLOWED_ORIGINS:'https://example.test'};
function storage(){
 const data=new Map();
 const store={data,get:async k=>data.get(k),put:async(k,v)=>{data.set(k,v);},delete:async k=>{for(const key of Array.isArray(k)?k:[k])data.delete(key);},list:async({prefix,limit,startAfter})=>new Map([...data.entries()].sort(([a],[b])=>a.localeCompare(b)).filter(([k])=>k.startsWith(prefix)&&(!startAfter||k>startAfter)).slice(0,limit)),transaction:async fn=>fn(store)};
 return store;
}
async function encryptedToken(token){const key=await crypto.subtle.importKey('raw',Buffer.from(env.VAULT_KEY,'base64url'),{name:'AES-GCM'},false,['encrypt']),iv=crypto.getRandomValues(new Uint8Array(12));return Buffer.from(iv).toString('base64url')+'.'+Buffer.from(await crypto.subtle.encrypt({name:'AES-GCM',iv},key,enc.encode(token))).toString('base64url');}
const request=(path,data)=>new Request('https://internal'+path,{method:'POST',body:JSON.stringify(data)});
async function fixture(){const store=storage(),coord=new AccountCoordinator({storage:store},env);const exp=Date.now()+60000;
 const token=await encryptedToken('fake-refresh');
 for(const sid of ['a','b','c'])assert.equal((await coord.fetch(request('/login',{sid,exp,email:'test@example.test',refresh:sid==='a'?token:null}))).status,200);
 const call=(sid,path,method='GET',body={})=>coord.fetch(request('/api',{sid,path,method,body:JSON.stringify(body)}));return{store,coord,call,token};}
test('device sign-out preserves other sessions and encrypted refresh; revoke invalidates all without Drive deletion',async()=>{
 const {store,coord,call,token}=await fixture();coord.access={value:'old-access',exp:Date.now()+600000};
 assert.equal((await call('a','/logout','POST')).status,200);assert.equal(await store.get('refresh'),token);assert.equal((await (await call('b','/status')).json()).connected,true);assert.equal((await (await call('a','/status')).json()).connected,false);
 const real=globalThis.fetch;let calls=0;globalThis.fetch=async(url,opts)=>{calls++;assert.equal(url,'https://oauth2.googleapis.com/revoke');assert.equal(opts.body.get('token'),'fake-refresh');return new Response(null,{status:200});};
 try{
  assert.equal((await call('b','/revoke','POST')).status,400);assert.equal(calls,0);
  const res=await call('b','/revoke','POST',{confirm:'REVOKE'});assert.equal(res.status,200);assert.equal((await res.json()).revoked,true);assert.equal(await store.get('refresh'),undefined);assert.equal(coord.access,null);assert.equal((await (await call('c','/status')).json()).connected,false);assert.equal((await call('c','/profiles')).status,401);assert.equal(calls,1);
  assert.equal((await coord.fetch(request('/login',{sid:'fresh',exp:Date.now()+60000,refresh:token}))).status,200);assert.equal((await (await call('fresh','/status')).json()).connected,true);assert.equal((await (await call('c','/status')).json()).connected,false);
 }finally{globalThis.fetch=real;}
});
test('failed revoke preserves credentials; invalid token removes local authority but does not claim Google grant revocation',async()=>{
 const {store,call,token}=await fixture();const real=globalThis.fetch;try{
  globalThis.fetch=async()=>new Response('{}',{status:503});assert.equal((await call('a','/revoke','POST',{confirm:'REVOKE'})).status,502);assert.equal(await store.get('refresh'),token);assert.equal((await (await call('b','/status')).json()).connected,true);
  globalThis.fetch=async()=>new Response(JSON.stringify({error:'invalid_token'}),{status:400});const res=await call('a','/revoke','POST',{confirm:'REVOKE'});assert.equal(res.status,200);assert.deepEqual(await res.json(),{revoked:false,disconnected:true,storedAuthorizationRemoved:true});assert.equal(await store.get('refresh'),undefined);
 }finally{globalThis.fetch=real;}
});
test('expired sessions are cleaned, and legacy sessions remain compatible until revoked',async()=>{
 const store=storage();await store.put('refresh','encrypted');await store.put('session:expired',{exp:Date.now()-1});await store.put('session:legacy',{exp:Date.now()+60000});const coord=new AccountCoordinator({storage:store},env);assert.equal((await coord.fetch(request('/login',{sid:'new',exp:Date.now()+60000}))).status,200);assert.equal(await store.get('session:expired'),undefined);const legacy=await coord.fetch(request('/api',{sid:'legacy',path:'/status',method:'GET'}));assert.equal((await legacy.json()).connected,true);
});
async function sign(payload){const body=Buffer.from(JSON.stringify(payload)).toString('base64url'),key=await crypto.subtle.importKey('raw',enc.encode(env.SESSION_SIGNING_KEY),{name:'HMAC',hash:'SHA-256'},false,['sign']);return body+'.'+Buffer.from(await crypto.subtle.sign('HMAC',key,enc.encode(body))).toString('base64url');}
test('signed OAuth state includes PKCE and rejects mismatched state before exchanging code',async()=>{
 const r=await worker.fetch(new Request('https://example.test/_profiles/v1/auth/start?return=%2F%3Fapp%3Dciyan'),env);assert.equal(r.status,302);const loc=new URL(r.headers.get('location'));assert.equal(loc.searchParams.get('code_challenge_method'),'S256');const cookie=r.headers.get('set-cookie').split(';')[0];const raw=cookie.split('=')[1].split('.')[0],state=JSON.parse(Buffer.from(raw,'base64url'));assert.equal(loc.searchParams.get('code_challenge'),Buffer.from(await crypto.subtle.digest('SHA-256',enc.encode(state.verifier))).toString('base64url'));assert.equal(state.returnTo,'/?app=ciyan');assert.equal(loc.searchParams.get('scope'),'openid email https://www.googleapis.com/auth/drive.file');
 const bad=await worker.fetch(new Request('https://example.test/_profiles/v1/auth/callback?state=wrong&code=code',{headers:{Cookie:cookie}}),env);assert.equal(bad.status,400);
 const old='__Host-pwa_oauth_state='+await sign({state:'old',exp:Date.now()+10000});assert.equal((await worker.fetch(new Request('https://example.test/_profiles/v1/auth/callback?state=old&code=code',{headers:{Cookie:old}}),env)).status,400);
 const store=storage(),coord=new AccountCoordinator({storage:store},env),real=globalThis.fetch;const calls=[];
 try{globalThis.fetch=async(url,opts)=>{calls.push(String(url));if(String(url).endsWith('/token')){assert.equal(opts.body.get('code_verifier'),state.verifier);return Response.json({access_token:'fake-access',refresh_token:'fake-refresh'});}assert.match(String(url),/userinfo/);return Response.json({sub:'12345',email:'test@example.test'});};const connected=await worker.fetch(new Request('https://example.test/_profiles/v1/auth/callback?state='+state.state+'&code=code',{headers:{Cookie:cookie}}),{...env,ACCOUNTS:{idFromName:x=>x,get:()=>coord}});assert.equal(connected.status,302);assert.equal(connected.headers.get('location'),'https://example.test/?app=ciyan');assert.match(connected.headers.get('set-cookie'),/Max-Age=0/);assert.equal(calls.length,2);assert.ok(await store.get('refresh'));}finally{globalThis.fetch=real;}
});
test('CSRF, cross-origin requests and tampered cookies are rejected before account routing',async()=>{
 const value=await sign({sub:'12345',sid:'a',exp:Date.now()+10000}),base='https://example.test/_profiles/v1/revoke',headers={Cookie:'__Host-pwa_profile_session='+value};
 for(const extra of [{},{'X-PWA-CSRF':'1',Origin:'https://evil.test'},{'X-PWA-CSRF':'1','Sec-Fetch-Site':'cross-site'}])assert.equal((await worker.fetch(new Request(base,{method:'POST',headers:{...headers,...extra},body:'{}'}),env)).status,403);
 const res=await worker.fetch(new Request(base,{method:'POST',headers:{Cookie:headers.Cookie+'x','X-PWA-CSRF':'1'},body:'{}'}),env);assert.equal(res.status,401);
});
