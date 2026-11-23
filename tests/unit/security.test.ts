import { describe, expect, it } from 'vitest';
import { encryptSecret, decryptSecret, isPublicAddress, safeFetch, SecurityError, validateTarget } from '@reverse/security';
import { redactSecrets, estimateTokens, withinBudget } from '@reverse/ai';
describe('SSRF policy',()=>{
  it('blocks private, loopback, metadata and reserved addresses',()=>{for(const ip of ['127.0.0.1','10.0.0.1','192.168.1.1','172.16.0.1','169.254.169.254','100.64.0.1','0.0.0.0','::1','fd00::1','fe80::1','::ffff:127.0.0.1'])expect(isPublicAddress(ip),ip).toBe(false);});
  it('allows public addresses',()=>{for(const ip of ['8.8.8.8','1.1.1.1','2606:4700:4700::1111'])expect(isPublicAddress(ip),ip).toBe(true);});
  it('rejects unsafe URL forms',async()=>{for(const url of ['file:///etc/passwd','http://user:pass@example.com','http://[::1']){await expect(validateTarget(url)).rejects.toBeInstanceOf(SecurityError);}});
  it('requires explicit opt-in for loopback',async()=>{await expect(validateTarget('http://127.0.0.1:3100')).rejects.toThrow(/loopback/i);await expect(validateTarget('http://127.0.0.1:3100',true)).resolves.toMatchObject({url:{hostname:'127.0.0.1'}});});
  it('revalidates redirect targets',async()=>{await expect(safeFetch('http://127.0.0.1:3100')).rejects.toThrow(/loopback/i);});
});
describe('secret handling and budgets',()=>{
  it('encrypts API keys reversibly without storing plaintext',()=>{const key='ab'.repeat(32);const encrypted=encryptSecret('sk-test-secret',key);expect(encrypted).not.toContain('sk-test-secret');expect(decryptSecret(encrypted,key)).toBe('sk-test-secret');expect(()=>decryptSecret(encrypted,'cd'.repeat(32))).toThrow();});
  it('redacts tokens and estimates token budgets',()=>{expect(redactSecrets('Authorization: Bearer abc.def.ghi')).not.toContain('abc.def');expect(redactSecrets('api_key="abcdefghijklmnop"')).toContain('[REDACTED]');expect(estimateTokens('abcd')).toBe(1);expect(withinBudget('a'.repeat(800),{input:200,output:50})).toBe(false);});
});
