import { createHash } from 'node:crypto';
import type { EvidenceRef, ProgramIr, SemanticHypothesis } from './types.js';

interface SemanticRule { kind: string; pattern: RegExp; summary: string; confidence: number; falsification: string }

/** Conservative rule-based hypotheses, explicitly not AI conclusions. */
const RULES: SemanticRule[] = [
  { kind: 'iteration', pattern: /\b(?:for|while|do)\s*\(/i, summary: 'Pseudocode contains an iteration construct; loop bounds and termination remain unverified.', confidence: 0.55, falsification: 'Recover CFG backedges and validate loop bounds with boundary inputs.' },
  { kind: 'memory-copy', pattern: /\b(?:memcpy|memmove)\s*\(/i, summary: 'Function appears to copy a memory range.', confidence: 0.7, falsification: 'Trace source/destination ranges and overlap behavior with guarded buffers.' },
  { kind: 'memory-initialization', pattern: /\bmemset\s*\(/i, summary: 'Function appears to initialize a memory range.', confidence: 0.7, falsification: 'Observe writes and validate length/value parameters dynamically.' },
  { kind: 'file-io', pattern: /\b(?:fopen|fread|fwrite|CreateFileA?|ReadFile|WriteFile)\s*\(/i, summary: 'Function references file input/output operations.', confidence: 0.65, falsification: 'Run against an isolated fixture and correlate file system events.' },
  { kind: 'network-io', pattern: /\b(?:socket|connect|send|recv|WSAStartup|getaddrinfo)\s*\(/i, summary: 'Function references network operations.', confidence: 0.6, falsification: 'Observe traffic only in an isolated authorized network namespace.' },
  { kind: 'cryptographic-primitive', pattern: /\b(?:AES|SHA1|SHA256|MD5|RC4|EVP_|BCrypt)\w*\b/i, summary: 'Function references a cryptographic primitive or provider symbol.', confidence: 0.5, falsification: 'Recover key/IV/mode and compare against published test vectors.' },
  { kind: 'parsing', pattern: /\b(?:strtol|strtoul|sscanf|parse|decode)\w*\s*\(/i, summary: 'Function appears to parse or decode input.', confidence: 0.45, falsification: 'Recover grammar and differential-test valid and malformed inputs.' },
];

export function inferSemanticHypotheses(program: ProgramIr): SemanticHypothesis[] {
  const hypotheses: SemanticHypothesis[] = [];
  for (const fn of program.functions) {
    if (fn.external || fn.pseudocode === undefined) continue;
    const functionEvidence = fn.evidenceIds[0];
    if (!functionEvidence) continue;
    for (const rule of RULES) {
      if (!rule.pattern.test(fn.pseudocode)) continue;
      const evidenceIds = [functionEvidence];
      for (const blockId of fn.blockIds) {
        const block = program.blocks.find(item => item.id === blockId);
        evidenceIds.push(...(block?.evidenceIds ?? []));
        for (const instructionId of block?.instructionIds ?? []) {
          const instruction = program.instructions.find(item => item.id === instructionId);
          evidenceIds.push(...(instruction?.evidenceIds ?? []));
        }
      }
      hypotheses.push({ id: `hyp:${createHash('sha256').update(`${fn.id}:${rule.kind}`).digest('hex').slice(0, 24)}`, functionId: fn.id, kind: rule.kind, summary: rule.summary, confidence: rule.confidence, kindEvidence: 'INFERENCE', evidenceIds: [...new Set(evidenceIds)], falsification: rule.falsification });
    }
  }
  return hypotheses;
}

export function attachEvidence(program: ProgramIr, evidence: EvidenceRef[]): ProgramIr {
  return { ...program, evidence: [...program.evidence, ...evidence] };
}
