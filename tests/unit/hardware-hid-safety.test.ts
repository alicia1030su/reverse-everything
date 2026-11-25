import { describe, expect, it } from 'vitest';
import { parseHidReportDescriptor } from '../../packages/hardware/src/index.js';

describe('HID descriptor adversarial boundaries',()=>{
  it('rejects inverted usage ranges instead of silently accepting them',()=>{
    const report=parseHidReportDescriptor(Buffer.from([0x05,0x01,0x19,0x05,0x29,0x02]));
    expect(report.valid).toBe(false);expect(report.anomalies.join(' ')).toMatch(/usage range/i);
  });

  it('bounds usage range expansion without iterating to a hostile maximum',()=>{
    const report=parseHidReportDescriptor(Buffer.from([0x05,0xff00,0x19,0x00,0x2b,0xff,0xff,0xff,0x7f]));
    expect(report.usages).toHaveLength(256);expect(report.truncated).toBe(true);
  });

  it('rejects impossible report sizes and unterminated collections',()=>{
    const size=parseHidReportDescriptor(Buffer.from([0x75,33,0x95,1,0x81,0]));
    expect(size.valid).toBe(false);expect(size.anomalies.join(' ')).toMatch(/report size/i);
    const collection=parseHidReportDescriptor(Buffer.from([0x05,0x01,0x09,0x06,0xa1,0x01]));
    expect(collection.valid).toBe(false);expect(collection.anomalies.join(' ')).toMatch(/unterminated collection/i);
  });

  it('hard-caps descriptor bytes even when the caller supplies a larger limit',()=>{
    const report=parseHidReportDescriptor(Buffer.alloc(70_000,0),Number.MAX_SAFE_INTEGER);
    expect(report.bytes).toBe(65_536);expect(report.truncated).toBe(true);
  });

  it('parses signed four-byte logical bounds without precision loss',()=>{
    const report=parseHidReportDescriptor(Buffer.from([0x17,0xff,0xff,0xff,0xff,0x27,0xff,0xff,0xff,0x7f]));
    expect(report.logicalMinimum).toBe(-1);expect(report.logicalMaximum).toBe(2_147_483_647);expect(report.keyboardCaptureDefault).toBe('DISABLED');
  });
});
