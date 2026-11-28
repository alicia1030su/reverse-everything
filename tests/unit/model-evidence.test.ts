import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { assertFinalDeliveryPassed, serializeModelResponseEvidence } from '../../scripts/model-evidence.mjs';

describe('model evidence serialization', () => {
  it('rejects BLOCKED or missing final delivery evidence', () => {
    expect(() => assertFinalDeliveryPassed({ status: 'BLOCKED' })).toThrow(/Final delivery/);
    expect(() => assertFinalDeliveryPassed(undefined)).toThrow(/Final delivery/);
    expect(() => assertFinalDeliveryPassed({ status: 'PASSED' })).not.toThrow();
  });
  it('binds the response digest to the exact evidence file bytes', () => {
    const result = serializeModelResponseEvidence({
      stage: 'program-analysis', requestId: 'req-1', finishReason: 'stop', usageSource: 'provider', refusal: false,
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }, promptSha256: 'a'.repeat(64),
      provider: 'openai-compatible', model: 'fixture', response: '{"summary":"ok"}', parsed: { summary: 'ok' },
    });
    expect(result.sha256).toBe(createHash('sha256').update(result.serialized).digest('hex'));
    expect(JSON.parse(result.serialized)).toMatchObject({ stage: 'program-analysis', requestId: 'req-1', realModelCalled: true, usageSource: 'provider' });
    expect(JSON.parse(result.serialized)).not.toHaveProperty('responseSha256');
  });
});
