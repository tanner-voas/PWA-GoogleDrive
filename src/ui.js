import {currentProfile,getProfiles,upsertProfile,renameProfile,selectProfile,forkProfile,renameRemoteProfile,remoteProfiles,status,connect,disconnect,revokeAuthorization,displayStatus} from './profiles.js';
/** Shared account identity UI; each host supplies app-specific data operations. */
const ico='<svg viewBox="0 0 24 24" width="23" height="23" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4.5 21c0-5 3.2-8 7.5-8s7.5 3 7.5 8"/></svg>';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const profileButton=`<button type="button" class="pwa-profile-button" data-pwa-profile-button aria-label="Manage profile" title="Manage profile">${ico}</button>`;
export const profileStyles=`
.pwa-profile-button{display:flex;align-items:center;justify-content:center;flex:none;background:inherit;color:inherit;border:1px solid currentColor;border-radius:14px;width:46px;height:46px;opacity:.9;cursor:pointer}
.pwa-profile-button svg{width:22px;height:22px}.pwa-profile-button:focus-visible{outline:2px solid #83bbac;outline-offset:2px}
.pwa-overlay{position:fixed;inset:0;z-index:99999;background:#0009;display:flex;align-items:flex-start;justify-content:center;padding:calc(env(safe-area-inset-top) + 90px) 14px 20px;overflow:auto;box-sizing:border-box}
.pwa-profile-panel{background:var(--surface,#f9faf7);color:var(--ink,#173a30);border-radius:22px;padding:22px;box-shadow:0 15px 60px #0005;width:min(420px,100%);font:inherit;max-height:calc(100dvh - env(safe-area-inset-top) - 125px);overflow:auto;box-sizing:border-box}
.pwa-profile-panel h2{font-size:21px;margin:0 0 8px}.pwa-profile-panel p{font-size:13px;line-height:1.5;margin:0 0 14px}.pwa-profile-panel button{font:inherit;cursor:pointer;touch-action:manipulation}
.pwa-profile-row{border:1px solid #97a59c65;border-radius:12px;background:transparent;color:inherit;display:block;width:100%;text-align:left;padding:13px;margin:8px 0}
.pwa-profile-row:disabled{opacity:.5;cursor:wait}.pwa-profile-muted{font-size:12px;opacity:.8}.pwa-profile-bar{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:12px}.pwa-profile-x{border:1px solid #97a59c65;border-radius:12px;background:transparent;padding:7px 12px;color:inherit}
.pwa-profile-error{background:#fff0e8;color:#7d2920;padding:10px 12px;border-radius:10px;white-space:pre-wrap}.pwa-profile-info{padding:10px 12px;background:#839a901b;border-radius:10px}
.pwa-profile-panel input{font:inherit;min-width:0;width:100%;box-sizing:border-box;border:1px solid #97a59c;border-radius:9px;padding:12px;background:transparent;color:inherit}.pwa-profile-panel label{display:block;font-size:13px;margin-bottom:5px}
.pwa-profile-panel .pwa-profile-actions{display:flex;gap:8px;margin:12px 0}.pwa-profile-actions button{flex:1;border-radius:9px;padding:11px;background:transparent;border:1px solid #97a59c;color:inherit}
.pwa-profile-spin{display:inline-block;width:14px;height:14px;vertical-align:-2px;margin-right:6px;border:2px solid currentColor;border-top-color:transparent;border-radius:50%;animation:pwa-spin .75s linear infinite}@keyframes pwa-spin{to{transform:rotate(360deg)}}
.pwa-profile-collision{color:#ac3029;font-weight:700;margin-right:6px}.pwa-profile-panel [aria-busy=true]{opacity:.72}
@media(max-width:380px){.pwa-profile-button{width:40px;height:40px;border-radius:12px}.pwa-profile-panel{padding:16px}}
`;
const NAME_MAX=64;
// Both AppLauncher and hosted apps import distinct URLs for this module. A
// document-level singleton prevents them from keeping competing click handlers.
const PROFILE_CONTROLLER=Symbol.for('pwa.profile.manager.controller');
export function installProfileUI({adapter={}}={}){
 document[PROFILE_CONTROLLER]?.destroy();
 const listeners=new AbortController();
 if(!document.getElementById('pwa-profile-style')){const style=document.createElement('style');style.id='pwa-profile-style';style.textContent=profileStyles;document.head.append(style);}
 let overlay=null,busy=false,remote=[],connection='checking',account='',error='',screen='main',operation='',destroyed=false;
 const connected=()=>connection==='connected';
 async function refreshCloud(){
  if(destroyed)return;
  connection='checking';draw();
  try{const s=await status();if(destroyed)return;connection=s.connected?'connected':'disconnected';account=s.email||'';remote=connected()?(await remoteProfiles()).profiles:[];}
  catch(e){if(destroyed)return;connection='failed';remote=[];error=`Cannot check Google Drive: ${displayStatus(e)}`;}
  if(!destroyed)draw();
 }
 function close(){overlay?.remove();overlay=null;document.body.style.removeProperty('overflow');}
 function destroy(){
  if(destroyed)return;destroyed=true;listeners.abort();close();
  if(document[PROFILE_CONTROLLER]===controller)delete document[PROFILE_CONTROLLER];
 }
 const row=(action,label,{disabled=busy,detail='',id=''}={})=>`<button type="button" class="pwa-profile-row" data-pwa="${action}" ${id?`data-id="${esc(id)}"`:''} ${disabled?'disabled':''}>${esc(label)}${detail?`<div class="pwa-profile-muted">${esc(detail)}</div>`:''}</button>`;
 function draw(){if(!overlay)return;const p=currentProfile(),local=getProfiles();const body=overlay.querySelector('.pwa-profile-panel');if(!body)return;
  const title=screen==='switch'?'Switch profile':screen==='rename'?'Rename profile':screen==='push'?'Overwrite cloud profile':'Profile';
  let inner='';
  if(screen==='switch'){
   inner=`<p>Select a local profile or a profile saved in Google Drive. Profiles with the same name have separate identities.</p>`;
   const candidates=[...local,...remote.filter(r=>!local.some(p=>p.id===r.id))];
   inner+=candidates.map(item=>{const cloud=remote.some(r=>r.id===item.id)||!!item.remote,collision=item.id!==p.id&&item.name===p.name&&cloud&&!p.remote;
    return `<button class="pwa-profile-row" data-pwa="switch" data-id="${esc(item.id)}" ${busy?'disabled':''}><strong>${collision?'<span class="pwa-profile-collision" aria-label="Duplicate name">✕</span>':''}${esc(item.name)}</strong>${item.id===p.id?' · Current':''}<div class="pwa-profile-muted">${cloud?'Google Drive':'Local'}${collision?' · Same name as current local profile':''}</div></button>`;
   }).join('');inner+=row('back','Back');
  }else if(screen==='rename'){
   inner=`<p>Renaming changes the profile label, not its stored learning records.</p><form id="pwa-profile-form"><label for="pwa-new-name">Profile name</label><input id="pwa-new-name" maxlength="64" value="${esc(p.name)}" required><div class="pwa-profile-actions"><button type="button" data-pwa="back">Cancel</button><button type="submit" ${busy?'disabled':''}>Save name</button></div></form>`;
  }else if(screen==='push'){
   const candidate=remote.find(r=>r.id!==p.id&&r.name===p.name);
   inner=`<p class="pwa-profile-error">A cloud profile named <strong>${esc(p.name)}</strong> already exists. This operation will create a new revision of that profile, preserving previous cloud history. Your local profile will not be deleted.</p><form id="pwa-profile-form"><label for="pwa-confirm">Type <strong>${esc('OVERWRITE '+p.name)}</strong> to continue</label><input id="pwa-confirm" autocomplete="off" required><div class="pwa-profile-actions"><button type="button" data-pwa="back">Cancel</button><button type="submit" data-target="${esc(candidate?.id||'')}" ${busy?'disabled':''}>Overwrite</button></div></form>`;
  }else{
   const state=connection==='checking'?'<span class="pwa-profile-spin"></span>Checking Google Drive connection…':connected()?`Connected as ${esc(account)}`:connection==='failed'?'Connection check failed':'Not connected to Google Drive';
   inner=`<p class="pwa-profile-info"><strong>${esc(p.name)}</strong> · ${p.remote?'Cloud profile':'Local profile'}<br>${state}${adapter.statusText?`<br>${esc(adapter.statusText())}`:''}${operation?`<br><span class="pwa-profile-spin"></span>${esc(operation)}`:''}</p>`;
   inner+=row('switch','Switch profile');inner+=row('rename','Rename profile');
   if(p.remote&&adapter.onFork)inner+=row('fork','Fork profile','');
   if(connected()){
    if(!p.remote&&adapter.onPush)inner+=row('push','Push profile',{detail:'Create and verify the complete Google Drive backup'});
    if(p.remote&&adapter.onSync)inner+=row('sync','Sync now',{detail:'Upload any pending Ciyan changes'});
    inner+=row('disconnect','Sign out on this device',{detail:'Keep Google authorization and all saved backups'});
    inner+=row('revoke','Revoke Google Drive access',{detail:'Disconnect all devices and remove stored authorization; keep backups'});
   }else if(connection!=='checking')inner+=row('connect','Connect Google Drive');
   if(connection==='failed')inner+=row('retry','Retry connection check');
   inner+='<p class="pwa-profile-muted">Changes are always saved locally first. Only a verified cloud revision is considered backed up.</p>';
  }
  body.innerHTML=`<div class="pwa-profile-bar"><h2>${title}</h2><button class="pwa-profile-x" data-pwa="close" aria-label="Close profile menu">×</button></div>${error?`<p class="pwa-profile-error" role="alert">${esc(error)}</p>`:''}${inner}`;
  body.setAttribute('aria-busy',busy?'true':'false');
 }
 async function safe(fn,label='Working…'){
  if(busy)return;busy=true;error='';operation=label;draw();
  try{await fn();}catch(e){error=displayStatus(e);}
  finally{busy=false;operation='';draw();}
 }
 async function open(initialAction=null){
  if(destroyed)return;
  if(overlay){if(initialAction==='push'){await perform('push');return;}close();return;}
  overlay=document.createElement('div');overlay.className='pwa-overlay';overlay.innerHTML='<section class="pwa-profile-panel" role="dialog" aria-modal="true" aria-label="Profile manager"></section>';
  overlay.addEventListener('click',e=>{if(e.target===overlay&&!busy)close();});
  document.body.append(overlay);document.body.style.overflow='hidden';error='';screen='main';draw();
  await refreshCloud();
  if(!destroyed&&initialAction==='push'&&connected())await perform('push');
 }
 async function push(targetId=null){return safe(async()=>{
  if(!adapter.onPush)throw Error('Open Ciyan to upload this profile');
  const p=currentProfile();const result=await adapter.onPush({targetId,name:p.name});
  // No profile is promoted locally until the app has independently verified
  // the initial cloud revision. The app may copy its database to targetId.
  if(!result?.id||!result.head)throw Error('Cloud backup has not been verified');
  upsertProfile({id:result.id,name:p.name,remote:true});
  if(result.id!==p.id){selectProfile(result.id);close();location.reload();return;}
  await refreshCloud();screen='main';
 },'Uploading and verifying complete backup…');}
 async function perform(action,id){
  if(action==='close')return close();if(busy)return;
  if(action==='back'){screen='main';return draw();}
  if(action==='connect'){sessionStorage.setItem('pwa:connect-pending','1');return connect(location.pathname+location.search);}
  if(action==='retry')return refreshCloud();
  if(action==='switch'&&!id){screen='switch';return draw();}
  if(action==='rename'){screen='rename';return draw();}
  if(action==='push'){
   const p=currentProfile(),collision=remote.find(r=>r.id!==p.id&&r.name===p.name);
   if(collision){screen='push';return draw();}return push();
  }
  if(action==='sync')return safe(async()=>{await adapter.onSync?.();},'Synchronizing and verifying…');
  if(action==='disconnect')return safe(async()=>{await adapter.beforeDisconnect?.();await disconnect();connection='disconnected';remote=[];account='';await adapter.onDisconnected?.();},'Signing out…');
  if(action==='revoke'){
   if(prompt('Revoke Google Drive access for this account on ALL devices? Local data and Drive backup files remain. Type REVOKE to confirm.')!=='REVOKE')return;
   return safe(async()=>{await adapter.beforeDisconnect?.();const result=await revokeAuthorization();if(!result?.disconnected||!result.storedAuthorizationRemoved)throw Error('Revocation was not confirmed');connection='disconnected';remote=[];account='';await adapter.onDisconnected?.();if(!result.revoked)error='Stored authorization was removed and all sessions disconnected, but Google did not confirm grant revocation. Check Google Account → Third-party connections.';},'Revoking account authorization…');
  }
  if(action==='fork')return safe(async()=>{
   const source=currentProfile(),name=prompt('Name for local copy',`${source.name} (copy)`)?.trim().slice(0,NAME_MAX);if(!name)return;
   await adapter.beforeSwitch?.();const id=forkProfile(source.id,name);
   try{await adapter.onFork?.({sourceId:source.id,id,name});}catch(e){throw Error('Cannot clone local profile: '+e.message);}
   selectProfile(id);close();location.reload();
  },'Copying complete profile…');
  if(action==='switch'&&id)return safe(async()=>{
   if(id===currentProfile().id){screen='main';return;}
   await adapter.beforeSwitch?.();const existing=remote.find(p=>p.id===id)||getProfiles().find(p=>p.id===id);
   if(!existing)throw Error('Profile no longer exists');
   upsertProfile({id,name:existing.name,remote:remote.some(p=>p.id===id)||!!existing.remote});
   selectProfile(id);close();location.reload();
  },'Saving and switching…');
 }
 async function submit(form){
  if(screen==='rename')return safe(async()=>{
   const p=currentProfile(),name=form.querySelector('#pwa-new-name').value.trim().slice(0,NAME_MAX);
   if(!name)throw Error('Profile name is required');
   if(remote.some(r=>r.id===p.id))await renameRemoteProfile(p.id,name);
   renameProfile(p.id,name);screen='main';await adapter.onRenamed?.(name);await refreshCloud();
  },'Renaming profile…');
  if(screen==='push'){
   const p=currentProfile();if(form.querySelector('#pwa-confirm').value!==`OVERWRITE ${p.name}`){error=`Type OVERWRITE ${p.name} exactly`;draw();return;}
   return push(remote.find(r=>r.id!==p.id&&r.name===p.name)?.id||null);
  }
 }
 document.addEventListener('click',e=>{const trigger=e.target.closest?.('[data-pwa-profile-button]');if(trigger){e.preventDefault();void open();return;}
  const action=e.target.closest?.('[data-pwa]');if(action&&overlay?.contains(action)){e.preventDefault();void perform(action.dataset.pwa,action.dataset.id);}
 },{signal:listeners.signal});
 document.addEventListener('submit',e=>{if(overlay?.contains(e.target)&&e.target.id==='pwa-profile-form'){e.preventDefault();void submit(e.target);}},{signal:listeners.signal});
 document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!busy)close();},{signal:listeners.signal});
 window.addEventListener('ciyan-cloud-status',()=>{if(overlay)draw();},{signal:listeners.signal});
 if(sessionStorage.getItem('pwa:connect-pending')){sessionStorage.removeItem('pwa:connect-pending');setTimeout(()=>{if(!destroyed)void open();},100);}
 const controller={open,refreshCloud,close,destroy};
 document[PROFILE_CONTROLLER]=controller;
 return controller;
}
