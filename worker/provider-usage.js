import {createEvent} from '../src/workspace-telemetry-schema.js';
// Accept only scalar estimates of actual requests. Never persist user text,
// SSML, translation output, provider credentials, URLs or arbitrary labels.
export function providerSample(source,input,now=Date.now()){
 const google=source==='google-translate',azure=source==='azure-speech';if(!google&&!azure||!input)return null;
 const operation=input.operation,ops=google?['request']:['synthesis','prefetch','cache_hit'];
 if(!ops.includes(operation)||!['success','error','cancelled','cache_hit'].includes(input.outcome)||(operation==='cache_hit')!==(input.outcome==='cache_hit'))return null;
 const valid=(n,max)=>Number.isSafeInteger(n)&&n>=0&&n<=max;
 if(!valid(input.characters,google?5000:100000)||!valid(input.durationMs,3600000)||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(input.id))return null;
 const status=input.status;if(status!==undefined&&(!Number.isInteger(status)||status<100||status>599))return null;
 const cache=operation==='cache_hit';return createEvent(source,operation,{eventId:input.id,app:google?'pwa-core':'ciyan',kind:'event',outcome:input.outcome,status,coverage:'partial',severity:input.outcome==='error'?'warning':'info',metrics:{requests:cache?0:1,characters:input.characters,durationMs:input.durationMs,...(google?{reservedCharacters:input.characters}:{}),...(cache?{cacheHits:1}:{})}},now);
}
export function addProviderTotals(day,event){
 const providers={...(day.providers||{})},r={requests:0,characters:0,reservedCharacters:0,successes:0,errors:0,cancelled:0,cacheHits:0,prefetchRequests:0,...providers[event.source]};
 if(event.operation==='cache_hit')r.cacheHits++;else{r.requests++;r.characters+=event.metrics.characters;r.reservedCharacters+=event.metrics.reservedCharacters||0;if(event.operation==='prefetch')r.prefetchRequests++;if(event.outcome==='success')r.successes++;else if(event.outcome==='cancelled')r.cancelled++;else r.errors++;}
 return {...day,providers:{...providers,[event.source]:r}};
}
