/** Portable, content-free schema 2. Keep the vendored sink copy byte-identical.
 * No free text, paths, URLs, arbitrary labels or raw provider objects. */
export const SCHEMA=2, DAY=86400000, MAX_EVENT_BYTES=4096;
const sources={
 'google-drive':['profiles_list','profile_create','profile_rename','objects_missing','objects_read_batch','objects_write_batch','object_write','object_read','head','commit','history','revisions','retention_prune','object_gc','backup','archive_enable','archive_flush','archive_prune','storage_quota'],
 'git-manager':['create','approve','dispatch','claim','prepare','validate','publish','settle','retry','cancel','finish','lock','release','export'],
 'git-runner':['claim','prepare','validate','publish','settle','retry','finish','export','dependency_fetch'],
 'github-actions':['workflow','job','step','artifact','usage'], 'repository':['snapshot','pin','tag','production'],
 'cloudflare-worker':['request','alarm','deployment','usage'], 'r2':['read','write','delete','list','usage'],
 'google-translate':['request','cache_hit','budget','quota'], 'azure-speech':['synthesis','prefetch','cache_hit','quota'],
};
export const SOURCES=Object.freeze(Object.keys(sources));
const apps=new Set(['ciyan','worldgen','ascendant','chronicle','applauncher','gitmanager','gitrunner','pwa-core','pwa-google-drive','other']);
const repos=new Set(['AppLauncher','Ciyan','WorldGen','Ascendant','Chronicle','PWA-Core','PWA-GoogleDrive','PWA-GitManager','PWA-GitRunner','iSH-Scripts']);
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i, sha=/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const enums=(v,values)=>values.includes(v)?v:undefined;
const stamp=v=>typeof v==='string'&&v.length<=40&&Number.isFinite(Date.parse(v))?new Date(v).toISOString():undefined;
const version=v=>typeof v==='string'&&/^\d{1,4}\.\d{1,4}\.\d{1,4}(?:\.r\d{1,6})?$/.test(v)?v:undefined;
const numeric=['durationMs','queueMs','serviceMs','requestChars','responseChars','driveCalls','driveRetries','indexHits','indexMisses','objectScans','driveHeaderMs','driveHeaderMaxMs','drive4xx','drive5xx','drive429','driveNetworkErrors','commitHeadMs','commitObjectsMs','commitRevisionMs','commitPublishMs','prepareMs','headMs','preflightMs','uploadMs','commitMs','sections','changed','reused','payloadBytes','objectsSent','objectsCreated','requests','hashed','hashesReused','serialized','identityReused','preflightReused','httpStatus','characters','reservedCharacters','bytes','count','cpuMs','runnerMs','storageBytes','limit','used','droppedEvents','cacheHits','cacheMisses'];
export function sanitizeEvent(v,{now=Date.now(),maxAge=30*DAY}={}){
 if(!v||v.schema!==SCHEMA||typeof v.eventId!=='string'||!uuid.test(v.eventId)||!Object.hasOwn(sources,v.source)||!sources[v.source].includes(v.operation))return null;
 const occurredAt=stamp(v.occurredAt);if(!occurredAt||Date.parse(occurredAt)<now-maxAge||Date.parse(occurredAt)>now+5*60000)return null;
 const kind=enums(v.kind,['event','interval','snapshot','delta']),severity=enums(v.severity,['debug','info','warning','error']),provenance=enums(v.provenance,['instrumented','provider','import']),confidence=enums(v.confidence,['observed','estimated','sampled','unknown']);
 if(!kind||!severity||!provenance||!confidence)return null;
 const out={schema:SCHEMA,eventId:v.eventId.toLowerCase(),source:v.source,operation:v.operation,kind,severity,occurredAt,provenance,confidence};
 const observedAt=stamp(v.observedAt);if(observedAt)out.observedAt=observedAt;
 if(apps.has(v.app))out.app=v.app;if(version(v.appVersion))out.appVersion=v.appVersion;
 const outcome=enums(v.outcome,['success','error','pending','cancelled','skipped','committed','unchanged','divergent','failed','paused','published','completed','denied','cache_hit','unknown']);if(outcome)out.outcome=outcome;
 if(Number.isInteger(v.status)&&v.status>=100&&v.status<=599)out.status=v.status;
 const code=enums(v.errorCode,['network','quota','auth','timeout','conflict','validation','provider','unknown']);if(code)out.errorCode=code;
 const coverage=enums(v.coverage,['complete','partial','stale','unavailable','truncated','estimated']);if(coverage)out.coverage=coverage;
 const metrics={};for(const k of numeric){const n=v.metrics?.[k];if(typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=Number.MAX_SAFE_INTEGER)metrics[k]=n;}
 if(Object.keys(metrics).length)out.metrics=metrics;
 const c=v.correlation||{},correlation={};for(const k of ['jobId','attemptId','deploymentId'])if(typeof c[k]==='string'&&uuid.test(c[k]))correlation[k]=c[k].toLowerCase();
 for(const k of ['workflowRunId','runAttempt'])if(typeof c[k]==='string'&&/^\d{1,20}$/.test(c[k]))correlation[k]=c[k];
 if(repos.has(c.repo))correlation.repo=c.repo;if(typeof c.commit==='string'&&sha.test(c.commit))correlation.commit=c.commit;
 if(typeof c.requestId==='string'&&/^[a-f0-9]{16,64}$/.test(c.requestId))correlation.requestId=c.requestId;
 if(Object.keys(correlation).length)out.correlation=correlation;
 return new TextEncoder().encode(JSON.stringify(out)).length<=MAX_EVENT_BYTES?out:null;
}
export function createEvent(source,operation,fields={},now=Date.now()){
 return sanitizeEvent({...fields,schema:SCHEMA,eventId:fields.eventId||crypto.randomUUID(),source,operation,kind:fields.kind||'event',severity:fields.severity||'info',occurredAt:fields.occurredAt||new Date(now).toISOString(),provenance:fields.provenance||'instrumented',confidence:fields.confidence||'observed'},{now});
}
/** Map legacy network-v1 samples without inventing bytes or adding duplicate events.
 * For stored legacy batches pass a stable UUID derived from batch ID + row index. */
export function adaptDriveSample(sample,eventId,now=Date.now()){
 if(!sample||!['request','maintenance','backup'].includes(sample.kind))return null;
 const operation=sample.kind==='backup'?'backup':sample.operation;
 const failed=sample.status==='error'||(typeof sample.status==='number'&&sample.status>=400);
 return createEvent('google-drive',operation,{eventId:sample.eventId||eventId,occurredAt:sample.at,app:sample.app,appVersion:sample.appVersion,kind:'interval',severity:failed?'error':'info',outcome:typeof sample.status==='string'?sample.status:failed?'error':'success',status:sample.status,metrics:sample,coverage:'partial'},now);
}
