# Reverse Everything

**AI-assisted local reverse engineering, console research, and digital compatibility reconstruction · v0.0.6**

[![CI](https://github.com/alicia1030su/reverse-everything/actions/workflows/ci.yml/badge.svg)](https://github.com/alicia1030su/reverse-everything/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Release](https://img.shields.io/badge/release-v0.0.6-blue.svg)](https://github.com/alicia1030su/reverse-everything/releases/latest)
[简体中文](README.md)

![Reverse Everything banner](docs/assets/banner.svg)

Reverse Everything turns **authorized targets** into traceable analysis jobs: real tool output, persisted stages, recoverable state, reproducible checks, and downloadable artifacts. v0.0.6 introduces Game Revival: a revival studio, L0-L7 evidence levels, generated self-owned multiplayer FPS/RPG servers, an administration console, and standalone deployment artifacts.

## Interface preview

| Intelligent wizard | Console Research Lab | Plain-language report |
|---|---|---|
| ![Intelligent wizard](docs/assets/v005-wizard.png) | ![Console Research Lab](docs/assets/v005-console-lab.png) | ![Plain-language report](docs/assets/v005-report.png) |

> Analyze only targets you own or are explicitly authorized to inspect. Do not bypass login, captcha, paywalls, DRM, anti-cheat, or access controls. The project does not provide console jailbreaking, privilege escalation, secure-boot bypass, automated exploitation, or unauthorized device access. See [DISCLAIMER.en.md](DISCLAIMER.en.md).

## What is new in v0.0.6

- **Game Revival Studio**: keep profiles for lawfully retained games, incrementally scan local directories read-only, and create evidence-bounded server specifications.
- **L0-L7**: advance from profile and file fingerprints through generation, real same-match play, persistence/reconnect, and Docker deployment. Generated files alone do not prove revival.
- **Self-owned multiplayer FPS/RPG**: generate standalone TypeScript/Node/WebSocket servers with authoritative state, room isolation, reconnect, persistence, settlement, multi-room concurrency, and an authenticated administration console.
- **Standalone generated servers**: downloaded artifacts do not depend on this platform API and can be built, started, and deployed in an isolated environment.
- **Every entrypoint**: new `game profile|scan|spec|rebuild|status|download` CLI commands, REST routes, and 7 MCP tools bring the MCP total to 44.
- **Measured boundary**: the highest local result is L6. Docker is unavailable locally, so Docker/L7 remains pending CI and is not marked passed.

## Six ways to use it

| Method | Audience | Entrypoint |
|---|---|---|
| Web console | Browser users | `npm start`, then open `http://127.0.0.1:4173` |
| Windows desktop | General users | Install the EXE or unpack Portable |
| CLI | Scripts and automation | `reverse-everything` |
| REST API | Integrations and custom clients | `/api/v1` or `/api` |
| MCP | AI clients | stdio and Streamable HTTP |
| Skill | General AI assistants | `skills/reverse-everything` |

## Quick start

Requirements: Node.js **22.13+**, npm, Git. Website analysis requires Chrome/Chromium.

```bash
npm ci
npm run build
npm start
```

Open <http://127.0.0.1:4173>. API and Web share the port. Startup creates `data/local-token`; never commit `data/`.

For development, start only API and the independent Worker:

```bash
npm run dev
```

Docker:

```bash
docker compose up -d --build
curl http://127.0.0.1:4173/api/health
docker compose down          # keep data
docker compose down -v       # delete the data volume
```

The host port binds only to `127.0.0.1`. USB is not mapped and privileged mode is not used by default. On Windows, use the installer, Portable build, or the Node.js flow above; on Linux, use Node.js 22.13+ or Docker Compose. Game scanning also requires the API server's explicit `RE_GAME_ROOTS` allowlist (`;`-separated on Windows, `:`-separated on Linux/Docker) of absolute directories and their descendants. See [docker-compose.yml](docker-compose.yml) and [.env.example](.env.example) for read-only mounts and configuration. Local Docker is unavailable; these instructions do not mean Docker/L7 has passed.

## Game Revival Studio

Create a game revival project and open the studio:

1. Save the game name, FPS/RPG genre, source, authorization scope, and unrecovered features.
2. Configure `RE_GAME_ROOTS` on the API server and enter an absolute path inside an allowed directory; missing configuration or out-of-scope paths return 403.
3. Scan read-only and incrementally for file fingerprints without uploading original game files.
4. Generate an evidence-graded specification, then create a standalone server rebuild.
5. Inspect real build, two-client same-match, room isolation, persistence, reconnect, settlement, and concurrency reports; download a validated ZIP when available.

L0 profile → L1 scan fingerprints → L2 specification → L3 generation/build → L4 standalone start/admin authentication → L5 two-client same match/authoritative state/room isolation → L6 persistence/reconnect/settlement/multi-room concurrency → L7 Docker deployment. Only validation reports advance a level. This does not guarantee commercial original-client compatibility or constitute recovery of the original server.

## Start intelligent analysis

1. Click “Start intelligent analysis”.
2. Choose PS5, Xbox, Android TV, USB, firmware, software, Android, web, game, protocol, or security.
3. Provide a file, device summary, or authorized URL and confirm the lawful analysis scope.
4. The system detects the environment, selects available analyzers, and creates a bounded plan.
5. Inspect real steps, logs, evidence, and resource usage.
6. Switch between plain-language and professional reports and export the result.

Deterministic planning and rule-based analysis work without AI configuration. AI text is always `INFERENCE` and cannot replace tool evidence.

## Console Research Lab

The lab targets **console devices themselves**, not game controllers.

- Device catalog: PS5, PS5 Slim, PS5 Pro, PS4, Xbox Series X/S, Xbox One, Android TV, Android TV boxes, and other open embedded devices.
- Profiles: manufacturer, series, model, hardware version, system version, official interfaces, authorized development environments, firmware samples, evidence, and limitations.
- USB diagnostics: read-only assessment of OS recognition, descriptors, normal interfaces, topology, official-environment needs, and hardware safety risk.
- Levels: C0 profile, C1 identity and official-document record, C2 lawful interface, C3 static analysis, C4 authorized development-environment test, C5 independent compatibility implementation on owned lab hardware. C1 only records source material; C2 and above require backend-verified evidence, and user statements cannot raise the level.

A device appearing in the catalog does not mean its internal system is supported. USB Type-C shape is not evidence of debugging. Ordinary retail console-to-console connections are not supported.

See the [console research guide](docs/user-guide/CONSOLE-RESEARCH.md), [PS5](docs/user-guide/PS5.md), [Xbox](docs/user-guide/XBOX.md), and [Android TV](docs/user-guide/ANDROID-TV.md).

## Capability entrypoints

| Entrypoint | Inputs and outputs | Actual routing and boundary |
|---|---|---|
| `website` | DOM, scripts, routes, forms, screenshots, same-origin network metadata | `website` adapter; no access-control bypass |
| `software` | PE/ELF/Mach-O, sections/imports, entropy, bounded strings, ZIP, SBOM | `file` adapter; unknown programs are not executed |
| `android` | Safe APK/ZIP inventory, AXML manifest, DEX tables, native-library metadata | `apk` adapter; JADX decompilation requires the official tool |
| `game` | Protocol fields, state transitions, and an independent compatibility service from a lawful replay | `game` adapter; not recovery of the original server |
| `network` | HAR, PCAP, PCAPNG endpoints, HTTP/DNS/TLS and transport metadata | `network` adapter; offline uploads only |
| `security` | Passive HTTP header/cookie/CORS checks, static CWE candidates, SARIF | `security` adapter; no exploitation |
| `usb` | USB identity/topology, offline PCAP/PCAPNG/usbmon, HID descriptors, snapshots | `hardware` adapter; read-only enumeration; no device handles |
| `firmware` | BIN/IMG, Intel HEX, UF2, ELF, layout, entropy, strings, component/SBOM clues | `firmware` adapter; bounded static analysis; no flashing |
| `board` | Board USB/HID/enumeration records and read-only serial inventory | `hardware` adapter; no model-specific or live-device claims |
| `console` | Device profiles, USB diagnostics, C0-C5 evidence, offline samples, reports | `console` adapter; no device operations or bypass |

Ghidra Headless is an advanced option inside the `software` card and uses the separate `ghidra` adapter. Ghidra 12.2 and JADX 1.5.3 have passed official-tool known-answer CI; this does not cover every format, architecture, or physical device.

## CLI examples

```bash
reverse-everything --version
reverse-everything health
reverse-everything capabilities
reverse-everything console devices
reverse-everything projects create "Authorized sample" software --authorized
reverse-everything projects upload <projectId> ./sample.bin
reverse-everything analyze file ./sample.bin --authorized
reverse-everything plans create <projectId> "Summarize offline requests" ./capture.har --authorized
reverse-everything plans execute <planId>
reverse-everything demos list
reverse-everything demos run firmware
reverse-everything report plain <taskId> ./report.md
reverse-everything game profile <projectId> "Owned FPS" fps /absolute/games/owned-fps --authorized
reverse-everything game scan <projectId> /absolute/games/owned-fps --authorized
reverse-everything game spec <projectId>
reverse-everything game rebuild <specId>
reverse-everything game status <rebuildId>
reverse-everything game download <rebuildId> ./server.zip
reverse-everything mcp stdio
reverse-everything mcp http --port 4174
```

Local URLs require `--confirm-local`. The CLI reads `RE_DATA_DIR/local-token` by default; override with `RE_API_URL`, `RE_API_TOKEN`, or `RE_DATA_DIR`. See the [CLI guide](docs/user-guide/CLI.md).

## REST API, OpenAPI, and MCP

- API: `http://127.0.0.1:4173/api/v1`; `/api` remains an alias.
- OpenAPI: runtime `GET /api/openapi.json`.
- MCP: stdio and Streamable HTTP share the API and expose **44 tools**, including the new `list_game_profiles`, `save_game_profile`, `scan_game_directory`, `create_game_server_spec`, `list_game_rebuilds`, `create_game_rebuild`, and `get_game_rebuild`.
- Skill: `skills/reverse-everything`; prefer MCP, otherwise CLI/API.

All entrypoints share backend authorization, schemas, budgets, and structured errors. Cleanup, device opening, live capture, flashing, driver installation, and arbitrary host command execution are not exposed to MCP.

## Security and privacy

- Read-only, local storage, credential redaction, and isolation of unknown programs are the defaults.
- Arbitrary hardware writes, driver installation, administrator operations, and arbitrary host commands are disabled by default.
- User samples are not uploaded to remote AI by default; remote sharing requires explicit consent.
- Device-controlled free text is represented only by one-way hashes by default.
- Unauthorized physical devices are not accessed. Live USB capture, driver installation, and flashing remain disabled.
- Firmware analysis is bounded and static. Encrypted or high-entropy content remains `UNKNOWN`.

See the [security policy](SECURITY.md) and [disclaimer](DISCLAIMER.en.md).

## Downloads

| Platform / form | File |
|---|---|
| Windows installer | [Reverse-Everything-Setup-0.0.6-win-x64.exe](https://github.com/alicia1030su/reverse-everything/releases/latest/download/Reverse-Everything-Setup-0.0.6-win-x64.exe) |
| Windows Portable | [Reverse-Everything-Portable-0.0.6-win-x64.zip](https://github.com/alicia1030su/reverse-everything/releases/latest/download/Reverse-Everything-Portable-0.0.6-win-x64.zip) |
| CLI | [reverse-everything-cli-0.0.6.tgz](https://github.com/alicia1030su/reverse-everything/releases/latest/download/reverse-everything-cli-0.0.6.tgz) |
| Server | [reverse-everything-server-0.0.6.tar.gz](https://github.com/alicia1030su/reverse-everything/releases/latest/download/reverse-everything-server-0.0.6.tar.gz) |
| Skill | [reverse-everything-skill-0.0.6.zip](https://github.com/alicia1030su/reverse-everything/releases/latest/download/reverse-everything-skill-0.0.6.zip) |

Download `SHA256SUMS.txt` and run `sha256sum -c SHA256SUMS.txt`. Windows installers are unsigned and may trigger SmartScreen; no code-signing claim is made.

## Tests and documentation

```bash
npm run typecheck
npm run lint
npm test
npm run test:e2e
npm run docs:check
npm run validate:skill
npm run version:check
```

Test counts, skips, CI run IDs, and gate conclusions are governed by the [v0.0.6 test results](docs/development/V006-TEST-RESULTS.md). Checks that did not run are not marked passed. Local Docker is unavailable; the highest measured level is L6 and L7 awaits CI.

- [PRD](docs/PRD.md) · [Architecture](docs/ARCHITECTURE.md) · [Security model](docs/SECURITY-MODEL.md) · [Roadmap](docs/ROADMAP.md)
- [Beginner guide](docs/user-guide/BEGINNER.md) · [Console research](docs/user-guide/CONSOLE-RESEARCH.md)
- [CLI](docs/user-guide/CLI.md) · [CLI/MCP](docs/user-guide/CLI-MCP.md) · [API](docs/user-guide/API.md) · [Skill](docs/user-guide/SKILL.md)
- [Windows](docs/user-guide/WINDOWS.md) · [Upgrade](docs/user-guide/UPGRADE.md) · [Capability matrix](docs/development/V006-CAPABILITY-MATRIX.md)

## License

Apache-2.0. Third-party components retain their own licenses; see [NOTICE](NOTICE) and [DISCLAIMER.en.md](DISCLAIMER.en.md). Do not distribute unauthorized commercial software, firmware, or game assets with this project.
