const ID=/^[A-Za-z0-9_-]{1,80}$/;
export const fields=['translateRequests','translateCharacters','speechRequests','speechCharacters','speechCacheHits','driveCalls'];
const validDay=(v,now)=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&v<=new Date(now).toISOString().slice(0,10)&&v>=new Date(now-31*86400000).toISOString().slice(0,10);
export function mergeProfileRows(old,incoming,scope,now=Date.now()){
 if(!Array.isArray(incoming)||incoming.length>16)throw Error('Invalid snapshots');
 const map=new Map((old||[]).filter(r=>validDay(r.day,now)).map(r=>[[r.profile,r.day,r.writer].join(':'),r]));
 for(const r of incoming){if(r?.scope!==scope||!ID.test(r.profile||'')||!ID.test(r.writer||'')||!validDay(r.day,now)||!r.counts||typeof r.counts!=='object'||Array.isArray(r.counts))throw Error('Invalid snapshot');
 const counts={};for(const [k,v] of Object.entries(r.counts)){if(!fields.includes(k)||!Number.isSafeInteger(v)||v<0||v>1e9)throw Error('Invalid count');counts[k]=v;}
 const key=[r.profile,r.day,r.writer].join(':'),prev=map.get(key)?.counts||{};for(const k of fields)if(k in prev||k in counts)counts[k]=Math.max(prev[k]||0,counts[k]||0);map.set(key,{profile:r.profile,day:r.day,writer:r.writer,counts});}
 const rows=[...map.values()];if(rows.length>500||JSON.stringify(rows).length>100000)throw Error('Usage capacity exceeded');return rows;
}
export function summarizeProfiles(rows){const result=Object.create(null);for(const r of rows){const profile=result[r.profile]??=Object.create(null);const day=profile[r.day]??={};for(const [k,v] of Object.entries(r.counts))day[k]=(day[k]||0)+v;}return result;}
