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
reverse-everything analyze web https://example.com --authorized
reverse-everything tasks get <task-id>
reverse-everything report export <task-id> ./report.md
reverse-everything game profile <project-id> "Owned FPS" fps /absolute/games/owned-fps --authorized
reverse-everything game scan <project-id> /absolute/games/owned-fps --authorized
reverse-everything game spec <project-id>
reverse-everything game rebuild <spec-id>
reverse-everything game status <rebuild-id>
reverse-everything game download <rebuild-id> ./server.zip
```

Flags: `--json`, `--quiet`, `--timeout <ms>`, `--api-url <url>`, `--no-wait`. Ctrl+C stops waiting but does not delete the remote task. Game scanning requires an absolute path under the API server's `RE_GAME_ROOTS`; missing configuration returns 403 and HTTP MCP cannot bypass it.
