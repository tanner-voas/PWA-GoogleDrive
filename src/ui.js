import {readRegistry,currentProfile,getProfiles,upsertProfile,renameProfile,selectProfile,forkProfile,createRemoteProfile,renameRemoteProfile,remoteProfiles,status,connect,disconnect,displayStatus} from './profiles.js';
import {cloneCiyanData} from './local-data.js';
/** Shared, vanilla-DOM account UI. Hosts supply only their app-specific hooks. */
const ico='<svg viewBox="0 0 24 24" width="23" height="23" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4.5 21c0-5 3.2-8 7.5-8s7.5 3 7.5 8"/></svg>';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const profileButton=`<button type="button" class="pwa-profile-button" data-pwa-profile-button aria-label="Manage profile" title="Manage profile">${ico}</button>`;
export const profileStyles=`
.pwa-profile-button{display:flex;align-items:center;justify-content:center;flex:none;background:inherit;color:inherit;border:1px solid currentColor;border-radius:14px;width:46px;height:46px;opacity:.9;cursor:pointer}
.pwa-profile-button svg{width:22px;height:22px}.pwa-profile-button:focus-visible{outline:2px solid #83bbac;outline-offset:2px}
.pwa-overlay{position:fixed;inset:0;z-index:99999;background:#0009;display:flex;align-items:flex-start;justify-content:center;padding:calc(env(safe-area-inset-top) + 90px) 14px 20px;overflow:auto;box-sizing:border-box}
.pwa-profile-panel{background:var(--surface,#f9faf7);color:var(--ink,#173a30);border-radius:22px;padding:22px;box-shadow:0 15px 60px #0005;width:min(420px,100%);font:inherit;max-height:calc(100dvh - env(safe-area-inset-top) - 125px);overflow:auto;box-sizing:border-box}
.pwa-profile-panel h2{font-size:21px;margin:0 0 6px}.pwa-profile-panel p{font-size:13px;opacity:.75;line-height:1.5;margin:0 0 14px}.pwa-profile-panel button{font:inherit;cursor:pointer;touch-action:manipulation}
.pwa-profile-row{border:1px solid #97a59c65;border-radius:12px;background:transparent;color:inherit;display:block;width:100%;text-align:left;padding:13px;margin:8px 0}
.pwa-profile-row:disabled{opacity:.55}.pwa-profile-muted{font-size:12px;opacity:.65}.pwa-profile-bar{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:12px}.pwa-profile-x{border:1px solid #97a59c65;border-radius:12px;background:transparent;padding:7px 12px;color:inherit}
.pwa-profile-error{background:#fff0e8;color:#7d2920;padding:10px 12px;border-radius:10px;white-space:pre-wrap}
.pwa-profile-panel input{font:inherit;min-width:0;width:100%;box-sizing:border-box;border:1px solid #97a59c;border-radius:9px;padding:10px;background:transparent;color:inherit}
.pwa-profile-panel .pwa-profile-actions{display:flex;gap:8px;margin:10px 0}.pwa-profile-actions button{flex:1;border-radius:9px;padding:10px;background:transparent;border:1px solid #97a59c;color:inherit}
@media(max-width:380px){.pwa-profile-button{width:40px;height:40px;border-radius:12px}.pwa-profile-panel{padding:16px}}
`;
const NAME_MAX=64;
export function installProfileUI({adapter={}}={}){
 if(!document.getElementById('pwa-profile-style')){const style=document.createElement('style');style.id='pwa-profile-style';style.textContent=profileStyles;document.head.append(style);}
 let overlay=null,busy=false,remote=[],connected=false,account='',phase='ready',error='',screen='main';
 async function refreshCloud(){try{const s=await status();connected=s.connected;account=s.email||'';remote=connected?(await remoteProfiles()).profiles:[];}catch(e){connected=false;remote=[];if(e.status!==401)error=displayStatus(e);}}
 const close=()=>{overlay?.remove();overlay=null;document.body.style.removeProperty('overflow');};
 const caption=(profile)=>{const cloud=remote.some(p=>p.id===profile.id);return cloud?'Google Drive':'Local only';};
 function draw(){if(!overlay)return;const current=currentProfile(),local=getProfiles();const body=overlay.querySelector('.pwa-profile-panel');
  const title=screen==='switch'?'Switch profile':screen==='history'?'Cloud history':'Profile';
  body.innerHTML=`<div class="pwa-profile-bar"><h2>${title}</h2><button class="pwa-profile-x" data-pwa="close" aria-label="Close profile menu">×</button></div>
   ${error?`<p class="pwa-profile-error" role="alert">${esc(error)}</p>`:''}
   ${screen==='switch'?`<p>Local profiles and profiles found in your Google Drive.</p>${[...new Map([...local,...remote].map(p=>[p.id,p])).values()].map(p=>`<button class="pwa-profile-row" data-pwa="switch" data-id="${esc(p.id)}" ${busy?'disabled':''}><strong>${esc(p.name)}</strong>${p.id===current.id?' · Current':''}<div class="pwa-profile-muted">${caption(p)}</div></button>`).join('')}<button class="pwa-profile-row" data-pwa="back">Back</button>`:
    screen==='history'?`<p>Ciyan cloud snapshots. Choose a verified revision to download and restore.</p><div id="pwa-history-list">Loading…</div><button class="pwa-profile-row" data-pwa="back">Back</button>`:
    `<p><strong>${esc(current.name)}</strong> · ${connected?`Connected as ${esc(account)}`:'Local mode'}${adapter.statusText?` · ${esc(adapter.statusText())}`:''}</p>
    <button class="pwa-profile-row" data-pwa="switch">Switch profile</button>
    <button class="pwa-profile-row" data-pwa="rename">Rename profile</button>
    <button class="pwa-profile-row" data-pwa="fork">Fork profile</button>
    <button class="pwa-profile-row" data-pwa="new">Create blank profile</button>
    ${connected?`<button class="pwa-profile-row" data-pwa="upload-profile">${remote.some(p=>p.id===current.id)?'Sync this profile now':'Add current profile to Google Drive'}</button>
      ${adapter.history?'<button class="pwa-profile-row" data-pwa="history">Browse cloud history</button>':''}
      <button class="pwa-profile-row" data-pwa="disconnect">Disconnect Google Drive</button>`:
     '<button class="pwa-profile-row" data-pwa="connect">Connect Google Drive</button>'}
    <div class="pwa-profile-muted">Offline progress is always saved locally. Cloud history is created only for connected profiles.</div>`}`;
  if(screen==='history'&&adapter.history)Promise.resolve(adapter.history(body.querySelector('#pwa-history-list'))).catch(e=>{error=displayStatus(e);draw();});
 }
 async function open(firstScreen='main'){if(overlay){close();return;}overlay=document.createElement('div');overlay.className='pwa-overlay';overlay.innerHTML='<section class="pwa-profile-panel" role="dialog" aria-modal="true" aria-label="Profile manager"></section>';overlay.addEventListener('click',e=>{if(e.target===overlay)close();});document.body.append(overlay);document.body.style.overflow='hidden';error='';screen=firstScreen;draw();await refreshCloud();draw();}
 async function safe(fn){if(busy)return;busy=true;error='';try{await fn();}catch(e){error=displayStatus(e);}finally{busy=false;draw();}}
 async function perform(action,id){if(action==='close')return close();if(action==='back'){screen='main';return draw();}if(action==='connect'){sessionStorage.setItem('pwa:connect-pending','1');return connect(location.pathname+location.search);}
  if(action==='switch'&&!id){screen='switch';return draw();}
  if(action==='history'){screen='history';return draw();}
  if(action==='disconnect')return safe(async()=>{await adapter.beforeDisconnect?.();await disconnect();connected=false;remote=[];await adapter.onDisconnected?.();});
  if(action==='rename')return safe(async()=>{const p=currentProfile(),name=prompt('Rename profile',p.name)?.trim().slice(0,NAME_MAX);if(!name||name===p.name)return;if(remote.some(r=>r.id===p.id))await renameRemoteProfile(p.id,name);renameProfile(p.id,name);await adapter.onRenamed?.(name);});
  if(action==='new')return safe(async()=>{
   const name=prompt('New blank profile name','New profile')?.trim().slice(0,NAME_MAX);if(!name)return;
   await adapter.beforeSwitch?.();const id=crypto.randomUUID();upsertProfile({id,name,remote:false});selectProfile(id);close();location.reload();
  });
  if(action==='fork')return safe(async()=>{
   const source=currentProfile(),name=prompt('Name for fork',`${source.name} (copy)`)?.trim().slice(0,NAME_MAX);if(!name)return;
   await adapter.beforeSwitch?.();const id=forkProfile(source.id,name);
   try{await cloneCiyanData(source.id,id);}catch(e){throw Error('Profile was created but copying Ciyan data failed: '+e.message);}
   selectProfile(id);close();location.reload();
  });
  if(action==='upload-profile')return safe(async()=>{const p=currentProfile();await createRemoteProfile(p.id,p.name);upsertProfile({id:p.id,name:p.name,remote:true});remote=(await remoteProfiles()).profiles;await adapter.onCloudProfile?.();});
  if(action==='switch'&&id)return safe(async()=>{
   if(id===currentProfile().id){screen='main';return;}
   await adapter.beforeSwitch?.();const existing=remote.find(p=>p.id===id)||getProfiles().find(p=>p.id===id);if(!existing)throw Error('Profile no longer exists');
   upsertProfile({id,name:existing.name,remote:remote.some(p=>p.id===id)});selectProfile(id);close();location.reload();
  });
 }
 document.addEventListener('click',e=>{const button=e.target.closest?.('[data-pwa-profile-button]');if(button){e.preventDefault();void open();return;}
  const action=e.target.closest?.('[data-pwa]');if(action&&overlay?.contains(action)){e.preventDefault();void perform(action.dataset.pwa,action.dataset.id);}
 });
 document.addEventListener('keydown',e=>{if(e.key==='Escape')close();});
 // OAuth return happens as a page reload; open the chooser so a cloud profile
 // is never implicitly selected from a matching display name.
 if(sessionStorage.getItem('pwa:connect-pending')){sessionStorage.removeItem('pwa:connect-pending');setTimeout(()=>void open('switch'),100);}
 return {open,refreshCloud,close};
}
