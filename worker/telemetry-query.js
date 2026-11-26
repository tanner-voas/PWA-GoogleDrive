import {sanitizeEvent,SOURCES,DAY} from '../src/workspace-telemetry-schema.js';
const NAME=/^chunk-v2-(\d{4}-\d{2}-\d{2})-(\d{13})-(\d{13})-([a-f0-9-]{36})\.json$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const PAGE_CHUNKS=8;
const hash=async text=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),x=>x.toString(16).padStart(2,'0')).join('');
const stamp=v=>typeof v==='string'&&v.length<=40&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
export function normalizeTelemetryQuery(v,now=Date.now()){
 if(!v||!stamp(v.start)||!stamp(v.end)||Date.parse(v.start)>=Date.parse(v.end)||Date.parse(v.end)>now+300000||Date.parse(v.end)-Date.parse(v.start)>31*DAY)return null;
 if(!Array.isArray(v.sources)||!v.sources.length||v.sources.some(s=>!SOURCES.includes(s))||v.sources.length>SOURCES.length)return null;
 if(v.jobId!=null&&(typeof v.jobId!=='string'||!UUID.test(v.jobId)))return null;
 if(v.after!=null&&(typeof v.after!=='string'||!NAME.test(v.after)))return null;
 return {start:v.start,end:v.end,sources:[...new Set(v.sources)],jobId:v.jobId||null,after:v.after||null};
}
// Read only the authorized account's managed archive. No file IDs from callers,
// no folder creation, no provider payloads returned, and bounded content reads.
export async function queryTelemetry(drive,q,now=Date.now()){
 const start=Date.parse(q.start),end=Date.parse(q.end),issues=[],events=[],chunks=[];
 const result={schema:1,events,chunks,issues,next:null,listedComplete:true,expiredRange:start<now-30*DAY};
 const root=await drive.root(false),telemetry=root&&await drive.folder(root,'telemetry',false),folder=telemetry&&await drive.folder(telemetry,'v2',false);
 if(!folder){issues.push('archive-not-found');return result;}
 const {files,complete}=await drive.listTelemetry(folder);result.listedComplete=complete;if(!complete)issues.push('archive-list-limit');
 // Chunk bounds are occurredAt min/max, not upload date. Late writes and
 // cross-midnight events must be selected by those bounds.
 const grouped=new Map();for(const f of files){const m=NAME.exec(f.name||'');if(!m||f.appProperties?.pwaTelemetry!=='v2')continue;if(Number(m[2])>=end||Number(m[3])<start||q.after&&f.name<=q.after)continue;const group=grouped.get(f.name)||[];group.push(f);grouped.set(f.name,group);}
 const names=[...grouped.keys()].sort(),page=names.slice(0,PAGE_CHUNKS);if(names.length>page.length)result.next=page.at(-1);
 for(const name of page){const group=grouped.get(name),f=group[0],m=NAME.exec(name);if(group.length!==1){issues.push('duplicate-chunk-name');continue;}
  try{if(!Number.isSafeInteger(Number(f.size))||Number(f.size)<=0||Number(f.size)>512*1024)throw Error('size');const text=await drive.content(f.id);if(new TextEncoder().encode(text).length>512*1024)throw Error('size');const c=JSON.parse(text);
   if(c.schema!==2||c.batchId!==m[4]||!stamp(c.createdAt)||c.createdAt.slice(0,10)!==m[1]||!Array.isArray(c.events)||c.events.length<1||c.events.length>64||c.count!==c.events.length||!Number.isSafeInteger(c.droppedEvents)||c.droppedEvents<0||await hash(JSON.stringify(c.events))!==c.eventsSha256)throw Error('integrity');
   const times=c.events.map(e=>Date.parse(e.occurredAt));if(Math.min(...times)!==Number(m[2])||Math.max(...times)!==Number(m[3])||Date.parse(c.minOccurredAt)!==Number(m[2])||Date.parse(c.maxOccurredAt)!==Number(m[3]))throw Error('bounds');
   const safe=c.events.map(e=>{const clean=sanitizeEvent(e,{now,maxAge:60*DAY});if(!clean)throw Error('schema');if(stamp(e.ingestedAt))clean.ingestedAt=e.ingestedAt;return clean;});
   chunks.push({name,count:c.count,eventsSha256:c.eventsSha256,droppedEvents:c.droppedEvents,createdAt:c.createdAt});
   for(const e of safe){const at=Date.parse(e.occurredAt);if(at>=start&&at<end&&q.sources.includes(e.source)&&(!q.jobId||e.correlation?.jobId===q.jobId))events.push(e);}
  }catch(e){issues.push('chunk-unavailable-or-invalid:'+name);if(/Drive API (401|403|429|5\d\d)/.test(String(e?.message||''))){issues.push('provider-read-interrupted');result.next=null;break;}}
 }
 return result;
}
