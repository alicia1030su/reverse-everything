import { createHash } from 'node:crypto';

export function assertFinalDeliveryPassed(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.status !== 'PASSED') {
    throw new Error('Final delivery must explicitly report status PASSED; BLOCKED or missing delivery evidence fails the release gate');
  }
}

/** Serializes the exact model-response evidence file and returns its SHA-256. */
export function serializeModelResponseEvidence(input) {
  const evidence = {
    stage: input.stage,
    requestId: input.requestId,
    finishReason: input.finishReason,
    usageSource: input.usageSource,
    refusal: input.refusal,
    usage: input.usage,
    promptSha256: input.promptSha256,
    realModelCalled: true,
    provider: input.provider,
    model: input.model,
    response: input.response,
    parsed: input.parsed,
  };
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  return { evidence, serialized, sha256: createHash('sha256').update(serialized).digest('hex') };
}
