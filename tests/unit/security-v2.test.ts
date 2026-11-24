import { describe, expect, it } from 'vitest';
import { redactResponseHeaders, redactTargetUrl, reviewHeaders } from '../../packages/core/src/adapters/security.js';

describe('security adapter v2 passive checks',()=>{
  it('does not report missing cookie attributes when no cookie is present',()=>{
    expect(reviewHeaders({'content-type':'text/html'}).filter(check=>check.title.startsWith('Cookie security'))).toEqual([]);
  });
  it('detects missing attributes from the actual Set-Cookie header value',()=>{
    const checks=reviewHeaders({'set-cookie':['session=abc; Path=/']},'https://example.com/');
    const cookie=checks.find(check=>check.title.startsWith('Cookie security'));
    expect(cookie?.observed).toBe(true);
    expect(cookie?.details).toContain('HttpOnly');
    expect(cookie?.details).toContain('Secure');
    expect(cookie?.details).toContain('SameSite');
  });
  it('accepts secure cookie attributes and distinguishes credentialed CORS',()=>{
    const checks=reviewHeaders({'set-cookie':['session=abc; Secure; HttpOnly; SameSite=Lax'],'access-control-allow-origin':'*','access-control-allow-credentials':'true'},'https://example.com/');
    expect(checks.find(check=>check.title.startsWith('Cookie security'))?.observed).toBe(false);
    expect(checks.find(check=>check.id==='WSTG-CONFIG-08'&&check.severity==='high')?.observed).toBe(true);
    expect(checks.find(check=>check.id==='WSTG-CONFIG-08'&&check.severity==='low')?.observed).toBe(false);
  });
  it('redacts raw cookie and authorization values before evidence persistence',()=>{
    const redacted=redactResponseHeaders({'set-cookie':['session=live-secret; Path=/; HttpOnly','second=another-secret; Secure'],authorization:'Bearer live-token','content-type':'text/html','x-trace':'token=query-secret'});
    expect(redacted['set-cookie']).toBe('[REDACTED], [REDACTED]');
    expect(redacted.authorization).toBe('[REDACTED]');
    expect(redacted['content-type']).toBe('text/html');
    expect(JSON.stringify(redacted)).not.toContain('live-secret');
    expect(JSON.stringify(redacted)).not.toContain('another-secret');
    expect(JSON.stringify(redacted)).not.toContain('live-token');
    expect(JSON.stringify(redacted)).not.toContain('query-secret');
  });
  it('redacts sensitive query parameters in the persisted final target URL',()=>{
    const redacted=redactTargetUrl('https://example.com/reset?token=live-secret&session=live-session&page=2');
    expect(redacted).toContain('token=%5BREDACTED%5D');
    expect(redacted).toContain('session=%5BREDACTED%5D');
    expect(redacted).toContain('page=2');
    expect(redacted).not.toContain('live-secret');
    expect(redacted).not.toContain('live-session');
  });
  it('handles multiple cookies independently',()=>{
    const checks=reviewHeaders({'set-cookie':['a=1; Secure; HttpOnly; SameSite=Strict','b=2; Path=/']},'https://example.com/');
    const cookies=checks.filter(check=>check.title.startsWith('Cookie security'));
    expect(cookies).toHaveLength(2);
    expect(cookies.map(check=>check.observed)).toEqual([false,true]);
  });
});
