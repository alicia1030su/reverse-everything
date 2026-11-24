# CLI

```bash
reverse-everything --version
reverse-everything health
reverse-everything capabilities
reverse-everything analyze file ./sample.exe --authorized
reverse-everything analyze web https://example.com --authorized
reverse-everything tasks get <task-id>
reverse-everything tasks logs <task-id>
reverse-everything tasks cancel <task-id>
reverse-everything report export <task-id> ./report.md
reverse-everything resources
reverse-everything cache stats
reverse-everything retention show
```

全局参数：`--json`、`--quiet`、`--timeout <ms>`、`--api-url <url>`、`--no-wait`。本地 URL 需 `--confirm-local`。Ctrl+C 只终止等待，不删除任务。Token 从 `RE_API_TOKEN` 或 `RE_DATA_DIR/local-token` 读取，不放在 URL。
