import {sanitizeEvent,createEvent,DAY} from '../src/workspace-telemetry-schema.js';
const P='workspace-telemetry:v2:', META=P+'meta', row=id=>P+'event:'+id;
export const LIMIT=256,BATCH=64,FLUSH=15*60000,RETAIN=30*DAY,CAP=250*1024*1024,MAX_PENDING_AGE=2*DAY,FIRST_FLUSH=60000;
const errorCode=e=>{const msg=String(e?.message||'');return /authorization expired|token exchange/i.test(msg)?'auth':/Drive API (?:429|403)/.test(msg)?'provider-denied-or-quota':/Drive API 5\d\d/.test(msg)?'provider-unavailable':/network/i.test(msg)?'network':/identity collision|verification/i.test(msg)?'integrity':/spool row|frozen telemetry/.test(msg)?'spool-integrity':'unknown';};
const defaults=()=>({enabled:false,generation:null,epoch:null,queue:[],seen:[],batch:null,dropped:0,droppedTotal:0,lastFlush:0,nextFlush:0,nextPrune:0,failures:0,archiveBytes:null,oldest:null,storageQuota:null,storageQuotaAt:null,archiveCalls:0,archiveRetries:0,archive429:0,pruned:0,lastAttempt:0,lastError:null,lastStage:null,lastReceipt:null,lastManual:0,maintenanceError:null,maintenanceFailures:0});
const priority=e=>e.severity==='error'||e.operation==='finish'||e.operation==='archive_enable';
const matchName=/^chunk-v2-(\d{4}-\d{2}-\d{2})-(\d{13})-(\d{13})-([a-f0-9-]{36})\.json$/;
const sha=async text=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),x=>x.toString(16).padStart(2,'0')).join('');
/** Shared account serialization is supplied by AccountCoordinator. All queue
 * state + records are durable; the bounded frozen selection is never changed
 * during an ambiguous Drive write. No Drive calls on append. */
export class WorkspaceTelemetry{
 constructor(storage){this.s=storage;}
 async meta(){return {...defaults(),...await this.s.get(META)};}
 async status(){const m=await this.meta();return {schema:2,enabled:m.enabled,pending:m.queue.length,droppedEvents:m.droppedTotal,lastFlush:m.lastFlush||null,nextFlush:m.nextFlush||null,failures:m.failures,archiveBytes:m.archiveBytes,oldest:m.oldest,storageQuota:m.storageQuota,storageQuotaAt:m.storageQuotaAt,archiveCalls:m.archiveCalls,archiveRetries:m.archiveRetries,archive429:m.archive429,pruned:m.pruned,lastAttempt:m.lastAttempt||null,lastError:m.lastError,lastStage:m.lastStage,lastReceipt:m.lastReceipt,maintenanceError:m.maintenanceError,nextManual:m.lastManual?m.lastManual+FIRST_FLUSH:null,alarmAt:await this.s.getAlarm?.()??null};}
 async arm(m=undefined,now=Date.now()){m??=await this.meta();if(!m.enabled||!this.s.setAlarm)return;const due=[m.nextFlush,m.nextPrune].filter(n=>n>0);if(!due.length)return;const target=Math.max(now+1000,Math.min(...due)),old=await this.s.getAlarm();if(old===null||old>target)await this.s.setAlarm(target);}
 async enable(now=Date.now(),epoch=null){
  let m=await this.meta();if(m.enabled&&m.epoch!==epoch){await this.disable();m=await this.meta();}if(!m.enabled){m={...m,enabled:true,epoch,generation:crypto.randomUUID(),nextPrune:now+DAY};await this.s.put(META,m);await this.append([createEvent('google-drive','archive_enable',{app:'pwa-google-drive',outcome:'success'},now)],now);m=await this.meta();m.nextFlush=Math.min(m.nextFlush||now+FIRST_FLUSH,now+FIRST_FLUSH);await this.s.put(META,m);}
  await this.arm(undefined,now);return (await this.meta()).generation;
 }
 async requestFlush(now=Date.now()){const m=await this.meta();if(!m.enabled||!m.queue.length)return false;if(m.lastManual&&now-m.lastManual<FIRST_FLUSH)return false;m.lastManual=now;m.nextFlush=now;await this.s.put(META,m);await this.arm(m,now);return true;}
 async disable(){const m=await this.meta();const keys=m.queue.map(x=>row(x.id));await this.s.transaction(async tx=>{for(let i=0;i<keys.length;i+=64)await tx.delete(keys.slice(i,i+64));await tx.put(META,{...defaults(),droppedTotal:m.droppedTotal+m.queue.length,archiveBytes:m.archiveBytes,oldest:m.oldest,lastFlush:m.lastFlush,lastReceipt:m.lastReceipt,archiveCalls:m.archiveCalls,archiveRetries:m.archiveRetries,archive429:m.archive429,pruned:m.pruned});});}
 async append(values,now=Date.now(),generation=null){
  if(!Array.isArray(values)||!values.length||values.length>BATCH)return {accepted:0,duplicates:0,rejected:values?.length||0};
  const events=values.map(v=>sanitizeEvent(v,{now,maxAge:RETAIN}));if(events.some(v=>!v))return {accepted:0,duplicates:0,rejected:values.length};
  let result={accepted:0,duplicates:0,rejected:0};
  const next=await this.s.transaction(async tx=>{result={accepted:0,duplicates:0,rejected:0};const m={...defaults(),...await tx.get(META)};if(!m.enabled||generation&&generation!==m.generation){result.rejected=values.length;return m;}
   const protectedIds=new Set(m.batch?.ids||[]),seen=new Set([...m.seen,...m.queue.map(x=>x.id)]),puts={},deletes=[];
   // Expire only unfrozen records; a frozen batch must reconcile an ambiguous write first.
   m.queue=m.queue.filter(x=>{if(!protectedIds.has(x.id)&&x.received<now-MAX_PENDING_AGE){deletes.push(row(x.id));m.dropped++;m.droppedTotal++;return false;}return true;});
   for(const e of events){if(seen.has(e.eventId)){result.duplicates++;continue;}
    if(m.queue.length>=LIMIT){const victim=m.queue.findIndex(x=>!x.priority&&!protectedIds.has(x.id));if(victim<0||!priority(e)){m.dropped++;m.droppedTotal++;result.rejected++;continue;}
     const [old]=m.queue.splice(victim,1);deletes.push(row(old.id));delete puts[row(old.id)];m.dropped++;m.droppedTotal++;}
    seen.add(e.eventId);m.queue.push({id:e.eventId,received:now,priority:priority(e)});puts[row(e.eventId)]={...e,ingestedAt:new Date(now).toISOString()};result.accepted++;
   }
   if(m.queue.length&&!m.nextFlush)m.nextFlush=now+FLUSH;
   if(m.queue.length>=BATCH&&!m.failures&&!m.batch)m.nextFlush=Math.min(m.nextFlush,now+1000);
   for(let i=0;i<deletes.length;i+=64)await tx.delete(deletes.slice(i,i+64));await tx.put({...puts,[META]:m});return m;
  });await this.arm(next,now);return result;
 }
 async freeze(m,now){if(m.batch||!m.queue.length)return m;
  const chosen=m.queue.slice(0,BATCH),events=[];for(const item of chosen){const e=await this.s.get(row(item.id));if(!e)throw Error('Missing telemetry spool row');events.push(e);}
  const timestamps=events.map(e=>Date.parse(e.occurredAt));const min=Math.min(...timestamps),max=Math.max(...timestamps);
  m.batch={id:crypto.randomUUID(),createdAt:new Date(now).toISOString(),min,max,ids:chosen.map(x=>x.id),dropped:m.dropped};await this.s.put(META,m);return m;
 }
 async folder(drive){const root=await drive.root(true),telemetry=await drive.folder(root,'telemetry',true);return drive.folder(telemetry,'v2',true);}
 async prune(drive,folder,m,now){const {files,complete}=await drive.listTelemetry(folder);const managed=files.map(f=>({f,match:matchName.exec(f.name)})).filter(x=>x.match&&x.f.appProperties?.pwaTelemetry==='v2'&&Number.isSafeInteger(Number(x.f.size))&&Number(x.f.size)>=0).sort((a,b)=>Number(a.match[2])-Number(b.match[2]));
  let bytes=managed.reduce((sum,x)=>sum+Number(x.f.size),0),removed=0,remaining=[];
  for(const x of managed){if(removed<8&&(Number(x.match[2])<now-RETAIN||complete&&bytes>CAP)){await drive.remove(x.f.id);bytes-=Number(x.f.size);removed++;}else remaining.push(x);}
  m.archiveBytes=complete?bytes:null;m.oldest=complete&&remaining.length?new Date(Number(remaining[0].match[2])).toISOString():null;m.pruned+=removed;m.nextPrune=now+(removed===8?FLUSH:DAY);return m;
 }
 async tick(drive,now=Date.now()){
  let m=await this.meta();if(!m.enabled)return;
  if(!await this.s.get('refresh')){await this.disable();return;}
  if(!((m.nextFlush&&m.nextFlush<=now)||(m.nextPrune&&m.nextPrune<=now))){await this.arm(m,now);return;}
  let stage='spool';
  try{
   if(m.nextFlush&&m.nextFlush<=now){
    m.lastAttempt=now;m.lastStage=stage;await this.s.put(META,m);
    if(!m.batch){const expired=m.queue.filter(x=>x.received<now-MAX_PENDING_AGE);if(expired.length){m.queue=m.queue.filter(x=>x.received>=now-MAX_PENDING_AGE);m.dropped+=expired.length;m.droppedTotal+=expired.length;await this.s.transaction(async tx=>{for(let i=0;i<expired.length;i+=64)await tx.delete(expired.slice(i,i+64).map(x=>row(x.id)));await tx.put(META,m);});}}
    if(m.batch&&Date.parse(m.batch.createdAt)<now-MAX_PENDING_AGE){ // explicit loss of unverifiable pending batch; not a successful receipt
     const ids=new Set(m.batch.ids);m.queue=m.queue.filter(x=>!ids.has(x.id));m.dropped+=ids.size;m.droppedTotal+=ids.size;m.batch=null;await this.s.transaction(async tx=>{await tx.delete([...ids].map(row));await tx.put(META,m);});
    }
    m=await this.freeze(m,now);
    if(m.batch){const b=m.batch,events=[];for(const id of b.ids){const e=await this.s.get(row(id));if(!e)throw Error('Missing frozen telemetry row');events.push(e);}
     const name=`chunk-v2-${b.createdAt.slice(0,10)}-${b.min}-${b.max}-${b.id}.json`,content=JSON.stringify({schema:2,batchId:b.id,createdAt:b.createdAt,minOccurredAt:new Date(b.min).toISOString(),maxOccurredAt:new Date(b.max).toISOString(),count:events.length,droppedEvents:b.dropped,eventsSha256:await sha(JSON.stringify(events)),events});
     stage='folder';const folder=await this.folder(drive);stage='lookup';const existing=(await drive.list(folder,name,true)).filter(f=>f.appProperties?.pwaTelemetry==='v2');
     stage='write';const created=existing.length?existing[0]:await drive.createJSON(folder,name,content,{appProperties:{pwaTelemetry:'v2'}});
     stage='verify';const receipt=created?.id?created:(await drive.list(folder,name,true)).find(f=>f.appProperties?.pwaTelemetry==='v2');if(!receipt?.id||await drive.content(receipt.id)!==content)throw Error('Telemetry chunk verification failed');
     m.lastReceipt={name,count:events.length,bytes:new TextEncoder().encode(content).length,verifiedAt:new Date(now).toISOString()};m.lastError=null;m.lastStage='verified';m.failures=0;
     const ids=new Set(b.ids);m.queue=m.queue.filter(x=>!ids.has(x.id));m.seen=[...m.seen,...b.ids].slice(-1024);m.batch=null;m.dropped=Math.max(0,m.dropped-b.dropped);m.lastFlush=now;m.archiveBytes=m.archiveBytes===null?null:m.archiveBytes+(existing.length?0:new TextEncoder().encode(content).length);
     if(!m.oldest||Date.parse(m.oldest)>b.min)m.oldest=new Date(b.min).toISOString();
     m.nextFlush=m.queue.length?now+FLUSH:0;m.nextPrune=m.archiveBytes===null||m.archiveBytes>CAP?now:(m.nextPrune?Math.min(m.nextPrune,now+DAY):now+DAY);
     await this.s.transaction(async tx=>{await tx.put(META,m);await tx.delete(b.ids.map(row));});
    }else{m.nextFlush=0;await this.s.put(META,m);}
   }
   if(m.nextPrune&&m.nextPrune<=now){stage='maintenance';m=await this.prune(drive,await this.folder(drive),m,now);m.maintenanceError=null;m.maintenanceFailures=0;if(drive.telemetryStorageQuota&&(!m.storageQuotaAt||now-m.storageQuotaAt>=DAY)){try{m.storageQuota=await drive.telemetryStorageQuota();m.storageQuotaAt=now;}catch{m.storageQuota=null;m.storageQuotaAt=null;}}await this.s.put(META,m);}
   await this.s.put(META,m);
  }catch(e){m=await this.meta();const code=errorCode(e);if(stage==='maintenance'){m.maintenanceError=code;m.maintenanceFailures++;m.nextPrune=now+Math.min(6*60*60000,FLUSH*2**Math.min(5,m.maintenanceFailures-1));}else{m.failures++;m.lastError=code;m.lastStage=stage;const retry=now+Math.min(6*60*60000,FLUSH*2**Math.min(5,m.failures-1));if(m.nextFlush)m.nextFlush=retry;if(m.nextPrune&&m.nextPrune<=now)m.nextPrune=retry;}await this.s.put(META,m);console.warn('workspace-telemetry',stage,code);}
  await this.arm(m,now);
 }
 async addArchiveMetrics(metrics){const m=await this.meta();if(!m.enabled)return;for(const [target,key] of [['archiveCalls','driveCalls'],['archiveRetries','driveRetries'],['archive429','drive429']])m[target]+=(metrics?.[key]||0);await this.s.put(META,m);}
}
