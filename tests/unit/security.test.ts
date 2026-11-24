import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { lookup } from 'node:dns/promises';
import type { AddressInfo } from 'node:net';
import type { LookupAddress } from 'node:dns';
import { encryptSecret, decryptSecret, isPublicAddress, safeFetch, SecurityError, validateTarget } from '@reverse/security';
import { redactSecrets, estimateTokens, withinBudget } from '@reverse/ai';
vi.mock('node:dns/promises',async(importOriginal)=>{
  const actual=await importOriginal<typeof import('node:dns/promises')>();
  return {...actual,lookup:vi.fn(actual.lookup)};
});
const actualDns=await vi.importActual<typeof import('node:dns/promises')>('node:dns/promises');
interface LookupMock { mockResolvedValueOnce(value:LookupAddress[]):LookupMock }
function lookupMock():LookupMock { return vi.mocked(lookup) as unknown as LookupMock; }
const servers:http.Server[]=[];
async function listen(handler:http.RequestListener):Promise<string> {
  const server=http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
function drip(res:http.ServerResponse,count=30,intervalMs=20):void {
  let sent=0;
  const timer=setInterval(()=>{
    if(res.destroyed) return;
    res.write('a');
    sent++;
    if(sent>=count) {clearInterval(timer);res.end();}
  },intervalMs);
  res.on('close',()=>clearInterval(timer));
}
afterEach(async()=>{
  vi.mocked(lookup).mockReset();
  vi.mocked(lookup).mockImplementation(actualDns.lookup);
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map(server=>new Promise<void>(resolve=>{
    server.closeAllConnections();
    server.close(()=>resolve());
  })));
});
describe('SSRF policy',()=>{
  it('blocks private, loopback, metadata and reserved addresses',()=>{for(const ip of ['127.0.0.1','10.0.0.1','192.168.1.1','172.16.0.1','169.254.169.254','100.64.0.1','0.0.0.0','::1','fd00::1','fe80::1','::ffff:127.0.0.1'])expect(isPublicAddress(ip),ip).toBe(false);});
  it('blocks IPv4-embedded, non-public and reserved IPv6 addresses',()=>{
    for(const ip of [
      '::ffff:7f00:1',
      '::ffff:10.0.0.1',
      '::7f00:1',
      '::10.0.0.1',
      '0:0:0:0:0:ffff:7f00:1',
      '2002:7f00:1::',
      '2002:a00:1::',
      '2001:0:a00:1:0:0:808:808',
      '2001:0:808:808:0:0:80ff:fffe',
      '64:ff9b::7f00:1',
      '::ffff:169.254.169.254',
      'ff02::1',
      'fe80::1',
      'fec0::1',
      'fc00::1',
      '2001:db8::1',
      '3fff::1',
      '100::1',
    ]) expect(isPublicAddress(ip),ip).toBe(false);
  });
  it('allows public addresses',()=>{
    for(const ip of [
      '8.8.8.8',
      '1.1.1.1',
      '2606:4700:4700::1111',
      '::ffff:8.8.8.8',
      '2002:808:808::',
      '64:ff9b::808:808',
      '2001:0:808:808:0:0:f7f7:f7f7',
    ]) expect(isPublicAddress(ip),ip).toBe(true);
  });
  it('fails closed for malformed addresses',()=>{
    for(const ip of ['', 'not-an-ip', '999.1.1.1', '2001:db8:::1', '[::1]', 'fe80::1%eth0', '::ffff:999.1.1.1']) {
      expect(isPublicAddress(ip),ip).toBe(false);
    }
  });
  it('rejects unsafe URL forms',async()=>{for(const url of ['file:///etc/passwd','http://user:pass@example.com','http://[::1']){await expect(validateTarget(url)).rejects.toBeInstanceOf(SecurityError);}});
  it('requires explicit opt-in for loopback',async()=>{await expect(validateTarget('http://127.0.0.1:3100')).rejects.toThrow(/loopback/i);await expect(validateTarget('http://127.0.0.1:3100',true)).resolves.toMatchObject({url:{hostname:'127.0.0.1'}});});
  it('does not relax public hostname policy when allowLocal is true',async()=>{
    lookupMock().mockResolvedValueOnce([{address:'10.0.0.1',family:4}]);
    await expect(validateTarget('http://example.com',true)).rejects.toMatchObject({code:'SSRF_BLOCKED'});
    lookupMock().mockResolvedValueOnce([{address:'8.8.8.8',family:4}]);
    await expect(validateTarget('http://example.com:8080',true)).rejects.toMatchObject({code:'PORT_BLOCKED'});
    lookupMock().mockResolvedValueOnce([{address:'8.8.8.8',family:4}]);
    await expect(validateTarget('http://example.com',true)).resolves.toMatchObject({addresses:['8.8.8.8']});
  });
  it('never allows private LAN or metadata targets through allowLocal',async()=>{
    await expect(validateTarget('http://10.0.0.1',true)).rejects.toMatchObject({code:'SSRF_BLOCKED'});
    await expect(validateTarget('http://169.254.169.254',true)).rejects.toMatchObject({code:'SSRF_BLOCKED'});
    lookupMock().mockResolvedValueOnce([{address:'10.0.0.1',family:4}]);
    await expect(validateTarget('http://localhost',true)).rejects.toMatchObject({code:'SSRF_BLOCKED'});
  });
  it('revalidates redirect targets',async()=>{await expect(safeFetch('http://127.0.0.1:3100')).rejects.toThrow(/loopback/i);});
});
describe('safeFetch bounds and cancellation',()=>{
  it('sends POST bodies and refuses redirects when followRedirects is false',async()=>{
    let secondConnections=0;
    const next=await listen((_req,res)=>{secondConnections++;res.end('must not be requested');});
    let method:string|undefined;let body='';let authorization:string|undefined;
    const base=await listen((req,res)=>{
      method=req.method;authorization=req.headers.authorization;
      req.on('data',chunk=>body+=chunk.toString());req.on('end',()=>{res.writeHead(307,{location:next});res.end();});
    });

    await expect(safeFetch(`${base}/chat/completions`,{allowLocal:true,method:'POST',headers:{authorization:'Bearer test-key','content-type':'application/json'},body:'{"prompt":"sensitive"}',followRedirects:false})).rejects.toMatchObject({code:'REDIRECT_BLOCKED'});

    expect(method).toBe('POST');
    expect(body).toBe('{"prompt":"sensitive"}');
    expect(authorization).toBe('Bearer test-key');
    expect(secondConnections).toBe(0);
  });
  it('rejects a public hostname resolving to loopback before opening a connection',async()=>{
    lookupMock().mockResolvedValueOnce([{address:'127.0.0.1',family:4}]);
    const requestSpy=vi.spyOn(http,'request');
    await expect(safeFetch('http://ai.example/chat/completions')).rejects.toMatchObject({code:'SSRF_BLOCKED'});
    expect(requestSpy).not.toHaveBeenCalled();
  });
  it('destroys a stalled response as soon as maxBytes is reached',async()=>{
    const base=await listen((_req,res)=>{
      res.writeHead(200,{'content-length':String(10*1024*1024)});
      res.write('a'.repeat(1024));
    });
    const started=performance.now();
    const result=await safeFetch(base,{allowLocal:true,maxBytes:1024,timeoutMs:5000});
    expect(result.truncated).toBe(true);
    expect(result.body).toHaveLength(1024);
    expect(performance.now()-started).toBeLessThan(2000);
  });
  it('keeps array-valued response headers and resolves on a normal end',async()=>{
    const base=await listen((_req,res)=>{
      res.writeHead(200,{'content-type':'text/plain','set-cookie':['a=1; Path=/','b=2; Path=/']});
      res.end('ok');
    });
    const result=await safeFetch(base,{allowLocal:true});
    expect(result.status).toBe(200);
    expect(result.headers['set-cookie']).toEqual(['a=1; Path=/','b=2; Path=/']);
    expect(result.body.toString()).toBe('ok');
    expect(result.truncated).toBe(false);
  });
  it('uses approved addresses without performing another DNS lookup',async()=>{
    const base=await listen((_req,res)=>res.end('pinned'));
    vi.mocked(lookup).mockRejectedValue(new Error('DNS must not run for approved addresses'));
    const result=await safeFetch(base,{allowLocal:true,addresses:['127.0.0.1']});
    expect(result.body.toString()).toBe('pinned');
    expect(lookup).not.toHaveBeenCalled();
  });
  it('rejects empty or unsafe approved address lists',async()=>{
    await expect(safeFetch('http://example.com',{addresses:[]})).rejects.toMatchObject({code:'INVALID_ADDRESSES'});
    await expect(safeFetch('http://example.com',{allowLocal:true,addresses:['10.0.0.1']})).rejects.toMatchObject({code:'SSRF_BLOCKED'});
    await expect(safeFetch('http://10.0.0.1',{allowLocal:true,addresses:['8.8.8.8']})).rejects.toMatchObject({code:'SSRF_BLOCKED'});
    expect(lookup).not.toHaveBeenCalled();
  });
  it('reuses approved addresses for same-origin pinned redirects',async()=>{
    const base=await listen((req,res)=>{
      if(req.url==='/start') {res.writeHead(302,{location:'/final'});res.end();}
      else res.end('ok');
    });
    vi.mocked(lookup).mockRejectedValue(new Error('DNS must not run for approved addresses'));
    const result=await safeFetch(`${base}/start`,{allowLocal:true,addresses:['127.0.0.1']});
    expect(result.finalUrl).toBe(`${base}/final`);
    expect(result.body.toString()).toBe('ok');
    expect(lookup).not.toHaveBeenCalled();
  });
  it('enforces a total timeout during a slow response drip',async()=>{
    const base=await listen((_req,res)=>drip(res));
    const started=performance.now();
    await expect(safeFetch(base,{allowLocal:true,timeoutMs:50})).rejects.toMatchObject({code:'TIMEOUT'});
    expect(performance.now()-started).toBeLessThan(300);
  });
  it('shares one total timeout budget across redirects',async()=>{
    const next=await listen((_req,res)=>drip(res));
    const base=await listen((_req,res)=>{
      const delay=setTimeout(()=>{res.writeHead(302,{location:next});res.end();},150);
      res.on('close',()=>clearTimeout(delay));
    });
    const started=performance.now();
    await expect(safeFetch(base,{allowLocal:true,timeoutMs:200})).rejects.toMatchObject({code:'TIMEOUT'});
    expect(performance.now()-started).toBeLessThan(400);
  });
  it('rejects non-finite or negative byte and timeout limits',async()=>{
    for(const maxBytes of [Infinity,-1,Number.NaN]) await expect(safeFetch('http://example.com',{maxBytes})).rejects.toMatchObject({code:'INVALID_LIMIT'});
    for(const timeoutMs of [Infinity,-1,Number.NaN]) await expect(safeFetch('http://example.com',{timeoutMs})).rejects.toMatchObject({code:'INVALID_LIMIT'});
    expect(lookup).not.toHaveBeenCalled();
  });
  it('rejects promptly when an external signal aborts a stalled request',async()=>{
    const controller=new AbortController();
    const base=await listen((_req,res)=>{
      res.writeHead(200,{'content-length':String(10*1024*1024)});
      res.write('a');
      controller.abort();
    });
    const started=performance.now();
    await expect(safeFetch(base,{allowLocal:true,timeoutMs:5000,signal:controller.signal})).rejects.toMatchObject({name:'AbortError'});
    expect(performance.now()-started).toBeLessThan(2000);
  });
  it('can abort target DNS resolution',async()=>{
    const controller=new AbortController();
    const pending=validateTarget('http://dns-lookup.invalid',false,controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({name:'AbortError'});
  });
  it('does not carry allowLocal from a public initial target into redirects',async()=>{
    lookupMock()
      .mockResolvedValueOnce([{address:'8.8.8.8',family:4}])
      .mockResolvedValueOnce([{address:'127.0.0.1',family:4}]);
    const response=new EventEmitter() as http.IncomingMessage;
    Object.assign(response,{statusCode:302,headers:{location:'http://127.0.0.1:3100/private'},destroy:vi.fn().mockReturnValue(response)});
    const request=new EventEmitter() as http.ClientRequest;
    request.setTimeout=vi.fn().mockReturnValue(request);
    request.destroy=vi.fn().mockReturnValue(request);
    request.end=vi.fn(()=>{
      callback(response);
      queueMicrotask(()=>response.emit('end'));
      return request;
    });
    let callback:(response:http.IncomingMessage)=>void=()=>{};
    const requestSpy=vi.spyOn(http,'request').mockImplementation(((url:string|URL,options:http.RequestOptions,onResponse:(response:http.IncomingMessage)=>void)=>{
      callback=onResponse;
      return request;
    }) as typeof http.request);
    await expect(safeFetch('http://8.8.8.8/start',{allowLocal:true})).rejects.toMatchObject({code:'SSRF_BLOCKED'});
    expect(requestSpy).toHaveBeenCalledTimes(1);
  });
  it('allows an explicitly local initial target to redirect to another loopback target',async()=>{
    const next=await listen((_req,res)=>res.end('local'));
    const base=await listen((_req,res)=>{res.writeHead(302,{location:next});res.end();});
    const result=await safeFetch(base,{allowLocal:true});
    expect(result.body.toString()).toBe('local');
    expect(result.finalUrl).toBe(`${next}/`);
  });
  it('revalidates a private redirect before issuing another request',async()=>{
    const response=new EventEmitter() as http.IncomingMessage;
    Object.assign(response,{statusCode:302,headers:{location:'http://127.0.0.1:3100/private'},destroy:vi.fn().mockReturnValue(response)});
    const request=new EventEmitter() as http.ClientRequest;
    request.setTimeout=vi.fn().mockReturnValue(request);
    request.destroy=vi.fn().mockReturnValue(request);
    request.end=vi.fn(()=>{
      callback(response);
      queueMicrotask(()=>response.emit('end'));
      return request;
    });
    let callback:(response:http.IncomingMessage)=>void=()=>{};
    const requestSpy=vi.spyOn(http,'request').mockImplementation(((url:string|URL,options:http.RequestOptions,onResponse:(response:http.IncomingMessage)=>void)=>{
      callback=onResponse;
      return request;
    }) as typeof http.request);
    await expect(safeFetch('http://8.8.8.8/start',{addresses:['8.8.8.8']})).rejects.toMatchObject({code:'REDIRECT_BLOCKED'});
    expect(requestSpy).toHaveBeenCalledTimes(1);
    expect(lookup).not.toHaveBeenCalled();
  });
});
describe('secret handling and budgets',()=>{
  it('encrypts API keys reversibly without storing plaintext',()=>{const key='ab'.repeat(32);const encrypted=encryptSecret('sk-test-secret',key);expect(encrypted).not.toContain('sk-test-secret');expect(decryptSecret(encrypted,key)).toBe('sk-test-secret');expect(()=>decryptSecret(encrypted,'cd'.repeat(32))).toThrow();});
  it('redacts tokens and estimates token budgets',()=>{expect(redactSecrets('Authorization: Bearer abc.def.ghi')).not.toContain('abc.def');expect(redactSecrets('api_key="abcdefghijklmnop"')).toContain('[REDACTED]');expect(estimateTokens('abcd')).toBe(1);expect(withinBudget('a'.repeat(800),{input:200,output:50})).toBe(false);});
});
