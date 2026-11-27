import type { EvidenceRef, ProgramIr } from '@reverse/program-ir';
import { buildSemanticContext, parseFunctionSemanticOutput, promptDigest, renderSemanticPrompt, SEMANTIC_SYSTEM_PROMPT } from './prompt.js';
import type { SemanticAnalysis, SemanticAnalysisOptions, SemanticCompletionPort, SemanticModelResult } from './types.js';

function assertBoundedResult(result: SemanticModelResult): void {
  if (!result.providerId || !result.model || !result.completedAt) throw new Error('Semantic model result is missing provider/model/completion metadata');
  if (!['real', 'test-double'].includes(result.invocation)) throw new Error('Semantic model invocation must be explicitly classified');
  if (!Number.isFinite(result.usage.promptTokens) || !Number.isFinite(result.usage.completionTokens) || !Number.isFinite(result.usage.totalTokens)) throw new Error('Semantic model usage is invalid');
  if (result.usage.totalTokens !== result.usage.promptTokens + result.usage.completionTokens) throw new Error('Semantic model usage totals are inconsistent');
  if (result.content.length > 1_000_000) throw new Error('Semantic model output exceeded the bounded response size');
  if (result.invocation === 'real') {
    if (!result.requestId || !result.finishReason || !result.usageSource || !result.responseSha256) throw new Error('Real semantic model evidence requires requestId, finishReason, usageSource and responseSha256');
    if (result.refusal) throw new Error('Semantic model refused the analysis request');
    if (result.finishReason !== 'stop') throw new Error(`Semantic model did not finish normally: ${result.finishReason}`);
    if (result.usageSource !== 'provider') throw new Error('Real semantic model acceptance requires provider-reported token usage');
  }
}

function validateGrounding(program: ProgramIr, functionId: string, evidence: EvidenceRef[], output: ReturnType<typeof parseFunctionSemanticOutput>): void {
  if (output.functionId !== functionId) throw new Error('Semantic model returned a different functionId');
  const availableEvidence = new Set(evidence.map(item => item.id));
  const fn = program.functions.find(item => item.id === functionId);
  if (!fn) throw new Error('Function disappeared during semantic analysis');
  const availableVariables = new Set([...fn.parameterIds, ...fn.localIds].map(id => program.variables.find(item => item.id === id)?.name).filter((name): name is string => name !== undefined));
  for (const variable of output.variables) if (!availableVariables.has(variable.name)) throw new Error(`Semantic model invented variable: ${variable.name}`);
  for (const item of [...output.behaviors, ...output.hypotheses]) {
    if (!item.evidenceIds.length) throw new Error('Semantic behaviors and hypotheses must cite evidence');
    for (const id of item.evidenceIds) if (!availableEvidence.has(id)) throw new Error(`Semantic model cited unavailable evidence: ${id}`);
  }
}

/** Real semantic inference over bounded Program IR. Model prose is never promoted to fact. */
export class SemanticReverseEngineeringEngine {
  constructor(private readonly complete: SemanticCompletionPort) {}

  async analyzeFunction(program: ProgramIr, functionId: string, options: SemanticAnalysisOptions = {}): Promise<SemanticAnalysis> {
    const maxPromptChars = options.maxPromptChars ?? 60_000;
    const context = buildSemanticContext(program, functionId, maxPromptChars);
    const prompt = renderSemanticPrompt(context, maxPromptChars);
    const result = await this.complete({ system: SEMANTIC_SYSTEM_PROMPT, prompt, maxTokens: 4096, ...(options.signal ? { signal: options.signal } : {}) });
    assertBoundedResult(result);
    const output = parseFunctionSemanticOutput(result.content);
    validateGrounding(program, functionId, context.evidence, output);
    const modelEvidence: EvidenceRef = {
      id: `ev-model:${promptDigest(prompt).slice(0, 24)}:${result.completedAt}`,
      kind: 'EVIDENCE', source: `model:${result.providerId}`, locator: `function:${functionId}`,
      summary: `${result.invocation === 'real' ? 'Real model' : 'Test-double model'} ${result.model} returned a semantic analysis; its claims remain INFERENCE`,
    };
    return {
      schemaVersion: 1, programId: program.id, functionId, output, classification: 'INFERENCE',
      model: { providerId: result.providerId, model: result.model, usage: result.usage, invocation: result.invocation, completedAt: result.completedAt },
      promptSha256: promptDigest(prompt), evidence: [...context.evidence, modelEvidence],
      limitations: [
        'Model output is an inference and is not proof of runtime behavior or functional equivalence.',
        ...(result.invocation === 'test-double' ? ['Test-double output does not count as real-model acceptance.'] : []),
        ...(prompt.endsWith('[PROMPT TRUNCATED]') ? ['Program context was truncated to the configured prompt budget.'] : []),
      ],
    };
  }
}
