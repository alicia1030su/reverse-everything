import { assertProgramIr, type ProgramIr } from '@reverse/program-ir';
import type { SemanticCompletionPort, SemanticModelRequest, SemanticModelResult } from '@reverse/program-semantics';
import type { ModelProviderService } from './providers.js';

/** Adapts the real HTTP provider service to the evidence-strict semantic engine port. */
export function createSemanticCompletionPort(service: ModelProviderService, taskId = 'program-semantics'): SemanticCompletionPort {
  return async (request: SemanticModelRequest): Promise<SemanticModelResult> => {
    const result = await service.complete({
      role: 'main', taskId, system: request.system, prompt: request.prompt, maxTokens: request.maxTokens,
      requiredCapabilities: ['structuredOutput'], ...(request.signal ? { signal: request.signal } : {}),
    });
    return {
      content: result.content, providerId: result.providerId, model: result.model, usage: result.usage,
      invocation: 'real', completedAt: new Date().toISOString(),
      requestId: result.requestId ?? `response:${result.responseSha256}`,
      ...(result.finishReason ? { finishReason: result.finishReason } : {}),
      usageSource: result.usageSource, responseSha256: result.responseSha256, refusal: result.refusal,
    };
  };
}

export function parseProgramIrArtifact(content: string): ProgramIr {
  let value: unknown;
  try { value = JSON.parse(content); } catch { throw new Error('program-ir.json is not valid JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('program-ir.json must contain an object');
  const program = value as ProgramIr;
  assertProgramIr(program);
  return program;
}
