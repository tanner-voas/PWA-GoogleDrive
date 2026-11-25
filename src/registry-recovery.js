/** Fail-closed recovery for profile identity metadata. Never erase IndexedDB.
 * This module is deliberately independent of Google Drive connectivity. */
import {recoverRegistry,candidateRegistry,readRegistry} from './profiles.js';
import {shareText} from './share-files.js';

const el=(tag,text='',attrs={})=>{const node=document.createElement(tag);node.textContent=text;for(const [key,value] of Object.entries(attrs))node.setAttribute(key,value);return node;};
const shareRaw=raw=>shareText(raw,'pwa-profiles-damaged-registry.json');
/** Display an actionable recovery screen without trusting any stored labels as HTML. */
export async function showRegistryRecovery(host,error,{storage=localStorage,onRecovered=()=>location.reload()}={}){
 if(!error||error.code!=='PROFILE_REGISTRY_CORRUPT')return false;
 host.replaceChildren();
 const frame=el('section');frame.style.cssText='max-width:560px;margin:36px auto;padding:24px;background:var(--surface,#fff);color:var(--ink,#172c26);border-radius:18px;line-height:1.6';
 frame.append(el('h2','Profile registry needs recovery'),el('p','Your profile index is damaged. No profiles, study records, or Google Drive backups have been reset. Export its raw contents before trying recovery.'));
 const exportButton=el('button','Share damaged registry');exportButton.type='button';exportButton.onclick=async()=>{try{await shareRaw(error.raw);}catch(e){if(e.name!=='AbortError')alert(e.message);}};
 frame.append(exportButton);
 const available=typeof globalThis.indexedDB?.databases==='function'?await globalThis.indexedDB.databases().catch(()=>[]):[];
 const databases=available.map(d=>d.name).filter(Boolean);
 let proposal;
 try{proposal=candidateRegistry(error.raw,databases);}catch(e){frame.append(el('p',`Recovery discovery failed: ${e.message}`));}
 if(proposal){
  const info=el('p',`${proposal.profiles.length} candidate profile(s) found. Only recognized local Ciyan databases and valid stored profile IDs are included. Google Drive profiles can be rediscovered after reconnecting.`);frame.append(info);
  const list=el('ul');for(const profile of proposal.profiles)list.append(el('li',`${profile.name} (${profile.id})`));frame.append(list);
  const confirm=el('label','Type RECOVER to accept the proposed profile index: '),input=el('input');input.autocomplete='off';confirm.append(input);frame.append(confirm);
  const recover=el('button','Recover listed profiles');recover.type='button';recover.onclick=()=>{
   if(input.value!=='RECOVER')return alert('Type RECOVER exactly.');
   try{recoverRegistry(proposal,storage);readRegistry(storage);onRecovered();}catch(e){alert(`Recovery was not completed: ${e.message}`);}
  };frame.append(recover);
 }
 const resetLabel=el('label','If no existing profiles can be recovered, type RESET PROFILES to create an empty profile index: '),resetInput=el('input');resetInput.autocomplete='off';resetLabel.append(resetInput);frame.append(resetLabel);
 const resetButton=el('button','Start with a new profile index');resetButton.type='button';resetButton.onclick=()=>{
  if(resetInput.value!=='RESET PROFILES')return alert('Type RESET PROFILES exactly.');
  const id=crypto.randomUUID(),fresh={version:1,active:id,legacyId:id,profiles:[{id,name:'Default',remote:false,createdAt:new Date().toISOString()}]};
  try{recoverRegistry(fresh,storage);onRecovered();}catch(e){alert(`Could not create profile index: ${e.message}`);}
 };frame.append(resetButton);
 frame.append(el('p','If your browser cannot enumerate saved databases, use the shared registry for manual recovery. Nothing will be replaced automatically.'));
 host.append(frame);return true;
}
