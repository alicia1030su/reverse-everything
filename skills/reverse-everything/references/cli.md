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
```

Flags: `--json`, `--quiet`, `--timeout <ms>`, `--api-url <url>`, `--no-wait`. Ctrl+C stops waiting but does not delete the remote task.
