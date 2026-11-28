# CLI

```bash
reverse-everything --version
reverse-everything health
reverse-everything capabilities
reverse-everything analyzers list
reverse-everything hardware doctor
reverse-everything hardware list
reverse-everything hardware serial
reverse-everything firmware inspect ./firmware.bin --authorized
reverse-everything tasks create <project-id> hardware
reverse-everything resources status
reverse-everything analyze file ./sample.exe --authorized
reverse-everything tasks create <project-id> legacy
reverse-everything analyze web https://example.com --authorized
reverse-everything tasks get <task-id>
reverse-everything report export <task-id> ./report.md
reverse-everything binary-diff <before-task-id> <after-task-id> --output ./binary-diff.json
reverse-everything game profile <project-id> "Owned FPS" fps /absolute/games/owned-fps --authorized
reverse-everything game scan <project-id> /absolute/games/owned-fps --authorized
reverse-everything game spec <project-id>
reverse-everything game rebuild <spec-id>
reverse-everything game status <rebuild-id>
reverse-everything game download <rebuild-id> ./server.zip
reverse-everything autopilot create <project-id> "Recover my old save files and explain the result" --key recovery-001
reverse-everything autopilot list <project-id>
reverse-everything autopilot get <autopilot-task-id>
reverse-everything autopilot answer <autopilot-task-id> '{"platform":"Windows"}' --contract
reverse-everything autopilot confirm <autopilot-task-id> plan
reverse-everything autopilot action <autopilot-task-id> pause
reverse-everything autopilot messages <autopilot-task-id>
reverse-everything autopilot artifacts <autopilot-task-id>
reverse-everything autopilot download <autopilot-task-id> tutorial.md ./tutorial.md
reverse-everything autopilot events <autopilot-task-id>
```

Flags: `--json`, `--quiet`, `--timeout <ms>`, `--api-url <url>`, `--no-wait`. Binary Diff also supports `--before-artifact`, `--after-artifact`, `--max-functions`, `--min-similarity`, `--max-changes`, and `--output`. Autopilot also supports `--key <idempotencyKey>`, `--contract`, and `--plan`; confirmation flags must reflect explicit user approval. MCP Autopilot tools are `autopilot_create`, `autopilot_list`, `autopilot_get`, `autopilot_answer`, `autopilot_confirm`, `autopilot_action`, `autopilot_messages`, `autopilot_artifacts`, `autopilot_tutorial`, and `autopilot_download`. Ctrl+C stops waiting but does not delete the remote task. Legacy local paths require the API server's `RE_LEGACY_ROOTS`; game scanning requires `RE_GAME_ROOTS`. Missing or out-of-scope configuration returns 403 and HTTP MCP cannot bypass it. Recovery and reconstruction options use MCP `create_task` or REST because the CLI `tasks create` command only passes the adapter.

MCP `autopilot_download` returns bounded base64 and never writes files by default. Saving is available only in stdio mode with an explicit `destination` and `RE_MCP_DOWNLOAD_ROOTS`; the destination parent must resolve inside an allowed root, the target must be a new non-symlink file, and existing files are never overwritten. HTTP MCP always rejects `destination`. `RE_MCP_DOWNLOAD_MAX_MB` bounds streamed downloads to 1-100 MiB (default 5).
