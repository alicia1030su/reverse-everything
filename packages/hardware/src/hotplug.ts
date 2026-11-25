import type { DeviceEvent, UsbDevice } from './types.js';
import { requireReauthorization } from './identity.js';

/** Pure event reducer. It stores identities only, never grants or inherits authorization. */
export class DeviceHotplugTracker {
  private readonly known=new Map<string,UsbDevice>();
  apply(devices:readonly UsbDevice[]):DeviceEvent[] {
    if(devices.length>10_000)throw new Error('Device inventory exceeds the 10000 bound');
    const events:DeviceEvent[]=[];const seen=new Set<string>();
    for(const device of devices){
      const previous=this.known.get(device.identity.stableKey);seen.add(device.identity.stableKey);
      if(!previous){events.push({type:'connect',device,stableKey:device.identity.stableKey,authorizationRequired:true,reason:'New device identity; explicit authorization required'});this.known.set(device.identity.stableKey,device);continue;}
      if(requireReauthorization(previous.identity,device.identity)){events.push({type:'reconnect',device,stableKey:device.identity.stableKey,authorizationRequired:true,reason:'Device identity or authorization changed; explicit authorization required'});this.known.set(device.identity.stableKey,device);}
    }
    for(const [key,device] of this.known)if(!seen.has(key)){events.push({type:'disconnect',device,stableKey:key,authorizationRequired:true,reason:'Device disappeared; authorization is not retained'});this.known.delete(key);}
    return events;
  }
}
