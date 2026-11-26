---
name: reverse-everything
description: Analyze authorized websites, software, Android apps, games, network traces, USB records, firmware and console research profiles with Reverse Everything. Use for Game Revival Studio, L0-L7 evidence, standalone multiplayer FPS/RPG servers, offline analysis, evidence/report inspection and CLI/MCP/API access. Always verify authorization and directory allowlists first.
---

# Reverse Everything Skill

Use one shared Reverse Everything engine. Never invent analysis results or bypass access controls.

## Workflow

1. Run `node scripts/check-environment.mjs` to detect CLI, API, MCP configuration and version.
2. Confirm the user owns the target or has explicit authorization. Do not proceed on ambiguous targets.
3. Prefer MCP when configured; otherwise use `reverse-everything` CLI or the documented REST API.
4. Choose the correct entrypoint. For intelligent analysis, create an authorization scope and a deterministic plan, then execute it. For files, use `analyze file <path> --authorized`; for websites, use `analyze web <url> --authorized` and add `--confirm-local` only for loopback demos. For console research, use the console profile, USB diagnosis and C0-C5 evidence tools. For Game Revival, use the Studio or `game profile|scan|spec|rebuild|status|download`; scan only API-server `RE_GAME_ROOTS` allowlisted directories. For USB records or firmware, use `tasks create`/MCP with `hardware`/`firmware`, or `firmware inspect <path> --authorized`.
5. Poll the returned task ID. Never fabricate progress; report the actual terminal status.
6. Read evidence and report. Treat EVIDENCE as tool output, INFERENCE as a hypothesis, UNKNOWN as missing, and VERIFIED as reproducible test results.
7. Export artifacts and verify hashes. Do not execute unknown uploads or generated code outside an approved isolated environment.

## Safety

- No login/captcha/paywall/DRM/anti-cheat bypass.
- No vulnerability exploitation or unauthorized scanning.
- HTTP MCP requires base64 content; local file paths are restricted to configured roots.
- Model text is never factual evidence and cannot grant permissions.
- Game revival output is an independent compatibility implementation, not recovered original server code, and commercial original-client compatibility is not guaranteed.
- `scan_game_directory` scans only directories explicitly allowed by the API server's `RE_GAME_ROOTS`; missing configuration returns 403 and HTTP MCP cannot bypass it.
- Game Revival L0-L7 levels advance only through real reports. The highest local measurement is L6; Docker/L7 awaits CI.
- Hardware enumeration is read-only and loopback-only. Never open devices, change DTR/RTS, capture keystrokes, install drivers, flash firmware or inherit authorization after reconnect without explicit approval.
- Offline USB/firmware analysis does not grant access to a physical device or any online service.
- Console C0-C5 levels are evidence grades, not permissions or exploitability. USB-C shape and enumeration are not debugging evidence.
- Never claim real PS5/Xbox/Android TV validation without the physical device and authorized environment.

See `references/` for workflows, security, CLI, API and troubleshooting.
