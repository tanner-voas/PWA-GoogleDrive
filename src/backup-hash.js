/** Hash exact serialized JSON bytes, never parsed/re-serialized objects. */
export const hex=bytes=>[...new Uint8Array(bytes)].map(b=>b.toString(16).padStart(2,'0')).join('');
export async function checksum(text){return hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)));}
