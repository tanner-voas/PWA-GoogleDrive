/** Keep recent + daily/weekly/monthly checkpoints. Do not rely on Drive native revisions. */
export function retainedIds(items,now=Date.now()){
 const sorted=[...items].filter(x=>Number.isFinite(Date.parse(x.at))).sort((a,b)=>Date.parse(b.at)-Date.parse(a.at));
 const keep=new Set(sorted.slice(0,10).map(x=>x.id));const seen={day:new Set(),week:new Set(),month:new Set()};
 for(const item of sorted){
  const ms=Date.parse(item.at),days=(now-ms)/86400000;if(days<0)continue;
  const d=new Date(ms),day=d.toISOString().slice(0,10),week=Math.floor(ms/(7*86400000)),month=d.getUTCFullYear()*12+d.getUTCMonth();
  if(days<=14&&!seen.day.has(day)){keep.add(item.id);seen.day.add(day);}
  if(days<=84&&!seen.week.has(week)){keep.add(item.id);seen.week.add(week);}
  if(days<=366&&!seen.month.has(month)){keep.add(item.id);seen.month.add(month);}
 }
 // Unknown timestamps never become deletion candidates.
 for(const item of items)if(!Number.isFinite(Date.parse(item.at)))keep.add(item.id);
 return keep;
}
export function checkRevision(revision){
 if(!revision||typeof revision!=='object'||revision.format!==1||typeof revision.id!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(revision.id))throw Error('Invalid cloud revision');
 if(typeof revision.operationId!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(revision.operationId))throw Error('Invalid operation ID');
 if(!revision.sections||typeof revision.sections!=='object'||Array.isArray(revision.sections))throw Error('Missing revision sections');
 for(const [key,value] of Object.entries(revision.sections))if(!/^[a-zA-Z0-9_-]{1,80}$/.test(key)||typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))throw Error('Invalid section checksum');
 return revision;
}
