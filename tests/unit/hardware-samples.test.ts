import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { assertSampleExpectation, decodeSample, MAX_DOWNLOAD_BYTES, SAMPLES, sha256, summarizeEnumeration } from '../../scripts/validate-hardware-samples.mjs';

describe('hardware sample integrity',()=>{
  it('locks official Wireshark sample URLs to HTTPS GitLab raw files',()=>{
    expect(SAMPLES.map(sample=>sample.file)).toEqual(['usb-hid.pcapng','usb_coverage.pcapng.gz','usb_hid_coverage.pcapng.gz']);
    for(const sample of SAMPLES)expect(sample.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(MAX_DOWNLOAD_BYTES).toBe(64_000_000);
  });

  it('locks known-answer structure for every official sample and rejects drift',()=>{
    for(const sample of SAMPLES){
      expect(sample.expected.recordCount).toBeGreaterThan(0);
      expect(()=>assertSampleExpectation(sample,sample.expected)).not.toThrow();
      expect(()=>assertSampleExpectation(sample,{...sample.expected,recordCount:sample.expected.recordCount+1})).toThrow(/known-answer mismatch/);
    }
  });

  it('verifies decompressed bytes and reports distinct download hashes',()=>{
    const capture=Buffer.from('synthetic-capture');const stored=gzipSync(capture),sample={file:'fixture.pcapng.gz',gzip:true,sha256:sha256(capture)};
    const decoded=decodeSample(sample,stored);expect(decoded.bytes).toEqual(capture);expect(decoded.sha256).toBe(sample.sha256);expect(decoded.downloadedSha256).toBe(sha256(stored));expect(decoded.downloadedSha256).not.toBe(decoded.sha256);
  });

  it('reports real enumeration counts and capabilities without device names or identities',()=>{
    const summary=summarizeEnumeration({platform:'win32',status:'OK',devices:[{product:'PRIVATE-DEVICE-NAME'}],serialPorts:[{}],capabilities:{openDeviceHandles:false},anomalies:[],limitations:[],truncated:false});
    expect(summary).toMatchObject({platform:'win32',status:'OK',usbDeviceCount:1,serialPortCount:1,capabilities:{openDeviceHandles:false}});expect(JSON.stringify(summary)).not.toContain('PRIVATE-DEVICE-NAME');
  });

  it('fails closed on a decompressed SHA256 mismatch',()=>{
    const stored=gzipSync(Buffer.from('tampered')),sample={file:'fixture.pcapng.gz',gzip:true,sha256:createHash('sha256').update('expected').digest('hex')};
    expect(()=>decodeSample(sample,stored)).toThrow(/SHA256 mismatch/);
  });
});
