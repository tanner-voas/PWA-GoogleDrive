/** One profile identity across apps on the SAME origin; never stores Google secrets. */
const KEY='pwa.profiles.v1';
const safeName=s=>String(s??'').trim().slice(0,64);
export const PROFILE_EVENT='pwa-profile-changed';
export const cloudEndpoint='/_profiles/v1';
export function readRegistry(storage=globalThis.localStorage){
 let data;try{data=JSON.parse(storage.getItem(KEY)||'null');}catch{}
 if(data?.version===1&&Array.isArray(data.profiles)&&data.profiles.length&&data.profiles.some(p=>p.id===data.active))return data;
 const id=globalThis.crypto.randomUUID();
 data={version:1,active:id,legacyId:id,profiles:[{id,name:'Default',remote:false,createdAt:new Date().toISOString()}]};
 storage.setItem(KEY,JSON.stringify(data));return data;
}
export function currentProfile(storage=globalThis.localStorage){const registry=readRegistry(storage);return registry.profiles.find(p=>p.id===registry.active);}
export function getProfiles(storage=globalThis.localStorage){return structuredClone(readRegistry(storage).profiles);}
function edit(modify,storage=globalThis.localStorage){const current=readRegistry(storage);const next=structuredClone(current);modify(next);storage.setItem(KEY,JSON.stringify(next));globalThis.dispatchEvent?.(new CustomEvent(PROFILE_EVENT,{detail:{active:next.active}}));return next;}
export function selectProfile(id,storage){return edit(data=>{if(!data.profiles.some(p=>p.id===id))throw Error('Unknown profile');data.active=id;},storage);}
export function renameProfile(id,name,storage){name=safeName(name);if(!name)throw Error('Profile name cannot be empty');return edit(data=>{const found=data.profiles.find(p=>p.id===id);if(!found)throw Error('Unknown profile');found.name=name;},storage);}
export function setProfileRemote(id,remote,storage){return edit(data=>{const found=data.profiles.find(p=>p.id===id);if(!found)throw Error('Unknown profile');found.remote=!!remote;},storage);}
export function upsertProfile({id,name,remote=false},storage){if(!/^[a-zA-Z0-9_-]{1,80}$/.test(id))throw Error('Invalid profile ID');name=safeName(name);if(!name)throw Error('Profile name required');return edit(data=>{const found=data.profiles.find(p=>p.id===id);if(found){found.name=name;found.remote=found.remote||remote;}else data.profiles.push({id,name,remote,createdAt:new Date().toISOString()});},storage);}
export function forkProfile(sourceId,name,storage){const id=globalThis.crypto.randomUUID();upsertProfile({id,name,remote:false},storage);return id;}
export async function api(path='',opts={}){
 const response=await fetch(`${cloudEndpoint}${path}`,{credentials:'same-origin',...opts,headers:{...(opts.body?{'Content-Type':'application/json','X-PWA-CSRF':'1'}:{}),...opts.headers}});
 const json=await response.json().catch(()=>({error:`HTTP ${response.status}`}));
 if(!response.ok){const e=new Error(json.error||`HTTP ${response.status}`);e.status=response.status;e.details=json;throw e;}
 return json;
}
export const status=()=>api('/status');
export const remoteProfiles=()=>api('/profiles');
export function connect(returnTo=globalThis.location?.pathname||'/'){
 const url=new URL(`${cloudEndpoint}/auth/start`,globalThis.location.href);url.searchParams.set('return',returnTo.startsWith('/')&&!returnTo.startsWith('//')?returnTo:'/');globalThis.location.assign(url.href);
}
export const disconnect=()=>api('/logout',{method:'POST',body:'{}'});
export const createRemoteProfile=(id,name)=>api('/profiles',{method:'POST',body:JSON.stringify({id,name})});
export const renameRemoteProfile=(id,name)=>api(`/profiles/${encodeURIComponent(id)}`,{method:'PATCH',body:JSON.stringify({name})});
export function displayStatus(e){if(e?.status===401)return 'Google connection expired. Reconnect to resume syncing.';if(e?.status===409)return 'A different cloud revision was found.';return e?.message||'Synchronization error';}
