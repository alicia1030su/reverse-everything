# CLI

```bash
reverse-everything --version
reverse-everything health
reverse-everything capabilities
reverse-everything analyze file ./sample.exe --authorized
reverse-everything analyze web https://example.com --authorized
reverse-everything tasks get <task-id>
reverse-everything report export <task-id> ./report.md
```

Flags: `--json`, `--quiet`, `--timeout <ms>`, `--api-url <url>`, `--no-wait`. Ctrl+C stops waiting but does not delete the remote task.
