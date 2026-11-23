/** One profile identity across apps on the SAME origin; never stores Google secrets. */
const KEY='pwa.profiles.v1';
const safeName=s=>String(s??'').trim().slice(0,64);
export const PROFILE_EVENT='pwa-profile-changed';
export const cloudEndpoint='/_profiles/v1';
export const REGISTRY_KEY=KEY;
const ID=/^[A-Za-z0-9_-]{1,80}$/;
export function validateRegistry(data){
 if(!data||typeof data!=='object'||data.version!==1||!Array.isArray(data.profiles)||!data.profiles.length||data.profiles.length>1000)throw Error('Unsupported profile registry');
 const seen=new Set();
 for(const profile of data.profiles){
  if(!profile||!ID.test(profile.id||'')||typeof profile.name!=='string'||!profile.name.trim()||profile.name.length>64||seen.has(profile.id))throw Error('Invalid or duplicate profile identity');
  seen.add(profile.id);
 }
 if(!seen.has(data.active)||!seen.has(data.legacyId))throw Error('Active or original profile identity is missing');
 return data;
}
export class ProfileRegistryCorruptError extends Error{
 constructor(raw,detail){super('Saved profile metadata is damaged. Recovery is required.');this.name='ProfileRegistryCorruptError';this.code='PROFILE_REGISTRY_CORRUPT';this.raw=raw;this.detail=detail;}
}
export function readRegistry(storage=globalThis.localStorage){
 const raw=storage.getItem(KEY);
 if(raw!==null){
  try{return validateRegistry(JSON.parse(raw));}
  catch(e){throw new ProfileRegistryCorruptError(raw,e.message);}
 }
 const id=globalThis.crypto.randomUUID();
 const data={version:1,active:id,legacyId:id,profiles:[{id,name:'Default',remote:false,createdAt:new Date().toISOString()}]};
 storage.setItem(KEY,JSON.stringify(data));return data;
}
/** Rebuild a candidate index from valid identity fragments and known IndexedDB names.
 * This only proposes recovery; no persistent data changes until explicit consent. */
export function candidateRegistry(raw,databaseNames=[]){
 let parsed={};try{parsed=JSON.parse(raw)||{};}catch{}
 const profiles=new Map();
 for(const p of Array.isArray(parsed.profiles)?parsed.profiles:[]){
  if(p&&ID.test(p.id||'')&&typeof p.name==='string'&&p.name.trim()&&p.name.length<=64&&!profiles.has(p.id))profiles.set(p.id,{id:p.id,name:p.name,remote:!!p.remote,createdAt:p.createdAt||new Date().toISOString()});
 }
 for(const name of databaseNames){const match=/^ciyan-mandarin-profile-([A-Za-z0-9_-]{1,80})$/.exec(name);
  if(match&&!profiles.has(match[1]))profiles.set(match[1],{id:match[1],name:`Recovered ${match[1].slice(0,8)}`,remote:false,createdAt:new Date().toISOString()});
 }
 const legacyPresent=databaseNames.includes('ciyan-mandarin');
 let legacyId=ID.test(parsed.legacyId||'')?parsed.legacyId:null;
 if(legacyPresent){if(!legacyId)legacyId=crypto.randomUUID();if(!profiles.has(legacyId))profiles.set(legacyId,{id:legacyId,name:'Recovered original',remote:false,createdAt:new Date().toISOString()});}
 if(!profiles.size)throw Error('No identifiable profiles found; raw registry is unchanged');
 // A recovered profile without a known legacy DB must still have a valid
 // legacyId, but no legacy DB is ever overwritten or renamed here.
 legacyId??=[...profiles.keys()][0];
 if(!profiles.has(legacyId))profiles.set(legacyId,{id:legacyId,name:'Recovered original',remote:false,createdAt:new Date().toISOString()});
 const active=profiles.has(parsed.active)?parsed.active:(legacyPresent?legacyId:[...profiles.keys()][0]);
 return validateRegistry({version:1,active,legacyId,profiles:[...profiles.values()]});
}
export function recoverRegistry(candidate,storage=globalThis.localStorage){
 validateRegistry(candidate);
 // Keep original value in place if the browser cannot write the replacement.
 const prior=storage.getItem(KEY);
 if(prior!==null){try{storage.setItem(`${KEY}.recovery-source`,prior);}catch{throw Error('Cannot preserve the previous registry; export it before recovery');}}
 storage.setItem(KEY,JSON.stringify(candidate));
 return candidate;
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
