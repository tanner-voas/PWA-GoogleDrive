import {WorkerEntrypoint} from 'cloudflare:workers';
import http,{telemetrySession,telemetryAppend,telemetryControl,translationUsage} from './index.js';
export {AccountCoordinator} from './index.js';
// The HTTP interface remains unchanged. RPC is accessible only via trusted
// service bindings in the same account; never proxy arbitrary RPC calls.
export default class ProfilesWorker extends WorkerEntrypoint {
 fetch(request){return http.fetch(request,this.env);}
 telemetrySession(origin,cookieHeader,action,query){return telemetrySession(this.env,origin,cookieHeader,action,query);}
 telemetryControl(capability,action){return telemetryControl(this.env,capability,action);}
 translationUsage(origin,cookieHeader,sample){return translationUsage(this.env,origin,cookieHeader,sample);}
 telemetryAppend(capability,events){return telemetryAppend(this.env,capability,events);}
}
