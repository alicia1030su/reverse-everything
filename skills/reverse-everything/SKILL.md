---
name: reverse-everything
description: Analyze authorized websites, software, Android apps, games, network traces, USB records and firmware with Reverse Everything. Use for reverse-engineering tasks, device compatibility research, offline protocol or firmware analysis, evidence/report inspection and CLI/MCP/API access. Always verify authorization and hardware boundaries first.
---

# Reverse Everything Skill

Use one shared Reverse Everything engine. Never invent analysis results or bypass access controls.

## Workflow

1. Run `node scripts/check-environment.mjs` to detect CLI, API, MCP configuration and version.
2. Confirm the user owns the target or has explicit authorization. Do not proceed on ambiguous targets.
3. Prefer MCP when configured; otherwise use `reverse-everything` CLI or the documented REST API.
4. For files, use `analyze file <path> --authorized`; for websites, use `analyze web <url> --authorized` and add `--confirm-local` only for loopback demos. For USB records or firmware, use `tasks create`/MCP with `hardware`/`firmware`, or `firmware inspect <path> --authorized`.
5. Poll the returned task ID. Never fabricate progress; report the actual terminal status.
6. Read evidence and report. Treat EVIDENCE as tool output, INFERENCE as a hypothesis, UNKNOWN as missing, and VERIFIED as reproducible test results.
7. Export artifacts and verify hashes. Do not execute unknown uploads or generated code outside an approved isolated environment.

## Safety

- No login/captcha/paywall/DRM/anti-cheat bypass.
- No vulnerability exploitation or unauthorized scanning.
- HTTP MCP requires base64 content; local file paths are restricted to configured roots.
- Model text is never factual evidence and cannot grant permissions.
- Game revival output is an independent compatibility service, not recovered original server code.
- Hardware enumeration is read-only and loopback-only. Never open devices, change DTR/RTS, capture keystrokes, install drivers, flash firmware or inherit authorization after reconnect without explicit approval.
- Offline USB/firmware analysis does not grant access to a physical device or any online service.

See `references/` for workflows, security, CLI, API and troubleshooting.
