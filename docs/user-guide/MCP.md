# MCP

## stdio

```json
{"mcpServers":{"reverse-everything":{"command":"reverse-everything","args":["mcp","stdio"],"env":{"RE_API_URL":"http://127.0.0.1:4173","RE_DATA_DIR":"/absolute/data"}}}}
```

stdout 仅协议消息；日志写 stderr。`upload_file` 的本地路径只有在 `RE_MCP_ALLOWED_ROOTS` 白名单内才可读。

## Streamable HTTP

```bash
reverse-everything mcp http --port 4174
```

地址 `http://127.0.0.1:4174/mcp`，使用同一 Bearer Token。默认仅回环，校验 Host/Origin。HTTP 上传使用 `contentBase64`，禁用任意本地路径读取。

保留原 8 个工具，并增加能力、健康、资源、证据、事件、产物清单和缓存只读工具。清理工具不暴露给 MCP。
