import { createHash } from 'node:crypto';
import { UNKNOWN, type DeviceAuthorization, type DeviceIdentity } from './types.js';

const HASH_PATTERN=/^(?:sha256:)?[a-f0-9]{64}$/i;
export function hashIdentity(...parts:(string|number|undefined)[]):string {
  return createHash('sha256').update(parts.map(part=>part===undefined?UNKNOWN:String(part)).join('\0')).digest('hex');
}
/** Accepts already-hashed identity values; plaintext serials are hashed in memory and never returned. */
export function redactSerial(value:string|undefined):string {
  if(value===undefined||value.length===0)return UNKNOWN;
  return HASH_PATTERN.test(value)?`sha256:${value.replace(/^sha256:/i,'').toLowerCase()}`:`sha256:${hashIdentity(value)}`;
}
export function deviceIdentity(input:{stableKey?:string;vendorId?:string;productId?:string;serial?:string;serialHash?:string;instance?:string;authorization?:DeviceAuthorization}):DeviceIdentity {
  const stableKey=input.stableKey??(input.instance?`instance:${hashIdentity(input.instance)}`:`usb:${input.vendorId??UNKNOWN}:${input.productId??UNKNOWN}:${hashIdentity(input.instance??'')}`);
  const serialHash=redactSerial(input.serialHash??input.serial);
  return {stableKey,...(input.vendorId?{vendorId:input.vendorId.toLowerCase()}:{}),...(input.productId?{productId:input.productId.toLowerCase()}:{}),serialHash,identityHash:hashIdentity(stableKey,input.vendorId,input.productId,serialHash),authorization:input.authorization??'REQUIRED'};
}
/** No permission state is persisted. A new tracker/session always starts unauthorized. */
export function requireReauthorization(previous:DeviceIdentity|undefined,next:DeviceIdentity):boolean {
  return !previous||previous.identityHash!==next.identityHash||(previous.authorization==='GRANTED'&&next.authorization!=='GRANTED');
}
