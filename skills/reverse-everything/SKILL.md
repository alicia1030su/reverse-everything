---
name: reverse-everything
description: Analyze authorized websites, legacy software, Android apps, games, network traces, USB records, firmware and console research profiles with Reverse Everything. Use for Legacy Software Revival Studio, read-only identification, data recovery, independent INI/CSV/text tools, Game Revival V5 behavior IR, compatibility evidence, offline analysis and CLI/MCP/API access. Always verify authorization and directory allowlists first.
---

# Reverse Everything Skill

Use one shared Reverse Everything engine. Never invent analysis results or bypass access controls.

## Workflow

1. Run `node scripts/check-environment.mjs` to detect CLI, API, MCP configuration and version.
2. Confirm the user owns the target or has explicit authorization. Do not proceed on ambiguous targets.
3. Prefer MCP when configured; otherwise use `reverse-everything` CLI or the documented REST API.
4. Choose the correct entrypoint. For intelligent analysis, create an authorization scope and a deterministic plan, then execute it. For files, use `analyze file <path> --authorized`; for websites, use `analyze web <url> --authorized` and add `--confirm-local` only for loopback demos. For Legacy Studio, use `tasks create <projectId> legacy` or MCP `create_task` with adapter `legacy`; local paths must be under API-server `RE_LEGACY_ROOTS`, and recovery/reconstruction options go through MCP or REST. For console research, use the console profile, USB diagnosis and C0-C5 evidence tools. For Game Revival, use the Studio or `game profile|scan|spec|rebuild|status|download`; scan only API-server `RE_GAME_ROOTS` allowlisted directories. For USB records or firmware, use `tasks create`/MCP with `hardware`/`firmware`, or `firmware inspect <path> --authorized`.
5. Poll the returned task ID. Never fabricate progress; report the actual terminal status.
6. Read evidence and report. Treat EVIDENCE as tool output, INFERENCE as a hypothesis, UNKNOWN as missing, and VERIFIED as reproducible test results.
7. Export artifacts and verify hashes. Do not execute unknown uploads or generated code outside an approved isolated environment.

## Safety

- No login/captcha/paywall/DRM/anti-cheat bypass.
- No vulnerability exploitation or unauthorized scanning.
- HTTP MCP requires base64 content; local file paths are restricted to configured roots.
- Model text is never factual evidence and cannot grant permissions.
- Legacy analysis never executes the original program, bypasses licenses, or recreates unauthorized assets. Recovery is read-only and writes to an independent directory.
- `legacy` local paths and `scan_game_directory` are restricted to API-server `RE_LEGACY_ROOTS` and `RE_GAME_ROOTS`; missing or out-of-scope configuration returns 403 and HTTP MCP cannot bypass it.
- Game Revival consumes V5 `revival-behavior/v1`. L0-L7 grades the generated service implementation; target behavior, original-client and protocol compatibility are separate, with the latter two defaulting to UNKNOWN. v0.0.6 Docker/L7 has official candidate-CI evidence, but commercial original-client compatibility is not guaranteed.
- Hardware enumeration is read-only and loopback-only. Never open devices, change DTR/RTS, capture keystrokes, install drivers, flash firmware or inherit authorization after reconnect without explicit approval.
- Offline USB/firmware analysis does not grant access to a physical device or any online service.
- Console C0-C5 levels are evidence grades, not permissions or exploitability. USB-C shape and enumeration are not debugging evidence.
- Never claim real PS5/Xbox/Android TV validation without the physical device and authorized environment.

See `references/` for workflows, security, CLI, API and troubleshooting.
