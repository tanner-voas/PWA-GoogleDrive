import {readRegistry} from './profiles.js';
/** The initial Ciyan profile deliberately keeps its original IndexedDB name. */
export function ciyanDatabaseName(profileId,registry=readRegistry()){
 if(profileId===registry.legacyId)return 'ciyan-mandarin';
 if(!/^[a-zA-Z0-9_-]{1,80}$/.test(profileId))throw Error('Invalid profile ID');
 return `ciyan-mandarin-profile-${profileId}`;
}
function open(name){return new Promise((resolve,reject)=>{const req=indexedDB.open(name,1);req.onupgradeneeded=()=>{if(!req.result.objectStoreNames.contains('state'))req.result.createObjectStore('state');};req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);req.onblocked=()=>reject(Error('Other tab is using this profile'));});}
/** Complete logical clone of the entire existing Ciyan database, including split content. */
export async function cloneCiyanData(fromId,toId){
 if(fromId===toId)throw Error('Source and destination must differ');
 const registry=readRegistry(),source=await open(ciyanDatabaseName(fromId,registry)),destination=await open(ciyanDatabaseName(toId,registry));
 try{
  const values=await new Promise((resolve,reject)=>{const req=source.transaction('state','readonly').objectStore('state').getAllKeys();req.onsuccess=()=>{
   const keys=req.result;const tx=source.transaction('state','readonly'),store=tx.objectStore('state'),out=[];let n=keys.length;
   if(!n)return resolve([]);for(const k of keys){const r=store.get(k);r.onsuccess=()=>{out.push([k,r.result]);if(--n===0)resolve(out);};r.onerror=()=>reject(r.error);}
  };req.onerror=()=>reject(req.error);});
  await new Promise((resolve,reject)=>{const tx=destination.transaction('state','readwrite');const store=tx.objectStore('state');store.clear();for(const [key,value] of values)store.put(value,key);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});
 }finally{source.close();destination.close();}
}
export async function ciyanHasData(id){const db=await open(ciyanDatabaseName(id));try{return await new Promise((resolve,reject)=>{const req=db.transaction('state','readonly').objectStore('state').get('main');req.onsuccess=()=>resolve(!!req.result);req.onerror=()=>reject(req.error);});}finally{db.close();}}
