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
    const cited = item.evidenceIds.map(id => {
      if (!availableEvidence.has(id)) throw new Error(`Semantic model cited unavailable evidence: ${id}`);
      return evidence.find(candidate => candidate.id === id)!;
    });
    if (!cited.some(item => /^(?:instruction|block|variable|call|xref):/.test(item.locator))) throw new Error('Semantic claims must cite fine-grained structural evidence, not only function identity');
  }
  const allowedKinds = new Set(['iteration', 'memory-copy', 'memory-initialization', 'file-io', 'network-io', 'cryptographic-primitive', 'parsing', 'data-flow', 'control-flow', 'call-graph', 'state-machine', 'other']);
  const claimPatterns: Record<string, RegExp> = {
    'network-io': /\b(?:socket|connect|send|recv|WSAStartup|getaddrinfo|network|exfiltrat\w*)\b/i,
    'file-io': /\b(?:fopen|fread|fwrite|CreateFileA?|ReadFile|WriteFile|file\s+io)\b/i,
    'cryptographic-primitive': /\b(?:AES|SHA1|SHA256|MD5|RC4|EVP_|BCrypt|cryptograph\w*)\b/i,
    'memory-copy': /\b(?:memcpy|memmove|memory\s+copy)\b/i,
    'memory-initialization': /\b(?:memset|memory\s+initializ\w*)\b/i,
    'parsing': /\b(?:strtol|strtoul|sscanf|parse|decode|parsing)\w*\b/i,
    'iteration': /\b(?:for|while|do|loop|iterat\w*)\b/i,
  };
  const structuralText = [fn.pseudocode ?? '', ...program.instructions.filter(instruction => instruction.functionId === fn.id).flatMap(instruction => [instruction.mnemonic, ...(instruction.pcode ?? [])]), ...program.calls.filter(call => call.callerId === fn.id).map(call => program.functions.find(candidate => candidate.id === call.calleeId)?.name ?? '')].join('\n');
  for (const behavior of output.behaviors) {
    if (!allowedKinds.has(behavior.kind)) throw new Error(`Unsupported semantic behavior kind: ${behavior.kind}`);
    for (const [kind, pattern] of Object.entries(claimPatterns)) {
      if (pattern.test(behavior.description) && !pattern.test(structuralText)) throw new Error(`Semantic behavior claim ${kind} is not supported by function structure`);
    }
  }
  for (const hypothesis of output.hypotheses) {
    for (const [kind, pattern] of Object.entries(claimPatterns)) {
      if (pattern.test(hypothesis.summary) && !pattern.test(structuralText)) throw new Error(`Semantic hypothesis claim ${kind} is not supported by function structure`);
    }
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
