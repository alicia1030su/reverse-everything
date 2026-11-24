---
name: reverse-everything
description: Analyze authorized websites, software files, security targets and legally obtained protocol traces with Reverse Everything. Use when the user asks to inspect a program, run a reverse-engineering task, read evidence or reports, generate a compatibility implementation, or connect through CLI/MCP/API. Always verify authorization and environment capabilities first.
---

# Reverse Everything Skill

Use one shared Reverse Everything engine. Never invent analysis results or bypass access controls.

## Workflow

1. Run `node scripts/check-environment.mjs` to detect CLI, API, MCP configuration and version.
2. Confirm the user owns the target or has explicit authorization. Do not proceed on ambiguous targets.
3. Prefer MCP when configured; otherwise use `reverse-everything` CLI or the documented REST API.
4. For files, use `analyze file <path> --authorized`; for websites, use `analyze web <url> --authorized` and add `--confirm-local` only for loopback demos.
5. Poll the returned task ID. Never fabricate progress; report the actual terminal status.
6. Read evidence and report. Treat EVIDENCE as tool output, INFERENCE as a hypothesis, UNKNOWN as missing, and VERIFIED as reproducible test results.
7. Export artifacts and verify hashes. Do not execute unknown uploads or generated code outside an approved isolated environment.

## Safety

- No login/captcha/paywall/DRM/anti-cheat bypass.
- No vulnerability exploitation or unauthorized scanning.
- HTTP MCP requires base64 content; local file paths are restricted to configured roots.
- Model text is never factual evidence and cannot grant permissions.
- Game revival output is an independent compatibility service, not recovered original server code.

See `references/` for workflows, security, CLI, API and troubleshooting.
