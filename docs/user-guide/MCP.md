# MCP（v0.0.6）

MCP server 与 Web/CLI 共用 REST API、本地令牌、任务状态机与证据模型。当前注册 **44 个工具**，v0.0.6 新增游戏复活 7 个。

## stdio

```json
{"mcpServers":{"reverse-everything":{"command":"node","args":["C:/absolute/path/reverse-everything/apps/cli/dist/cli.js","mcp","stdio"],"env":{"RE_API_URL":"http://127.0.0.1:4173","RE_DATA_DIR":"C:/absolute/path/reverse-everything/data","RE_MCP_ALLOWED_ROOTS":"C:/authorized/samples"}}}}
```

stdout 仅协议消息。`upload_file` 的 `filePath` 只有在 `RE_MCP_ALLOWED_ROOTS` 白名单内才可读；也可直接传 `contentBase64`。

## Streamable HTTP

```bash
node apps/cli/dist/cli.js mcp http --port 4174
```

地址为 `http://127.0.0.1:4174/mcp`，使用 Bearer Token。默认回环监听，校验 Host/Origin。HTTP 上传仅接受 `contentBase64`，不读取任意本机路径。

## 工具分组

- 项目与任务：`list_projects`、`create_project`、`upload_file`、`create_task`、`list_tasks`、`get_task`、`task_action`、`get_report`
- 系统与资源：`list_capabilities`、`get_system_health`、`get_resource_metrics`
- 硬件：`list_hardware_capabilities`、`list_hardware_devices`、`list_serial_ports`、`get_hardware_report`
- 证据与产物：`list_evidence`、`get_evidence`、`get_task_events`、`get_artifact_manifest`
- 缓存只读：`list_cache_entries`、`get_cache_statistics`
- 游戏复活（新增）：`list_game_profiles`、`save_game_profile`、`scan_game_directory`、`create_game_server_spec`、`list_game_rebuilds`、`create_game_rebuild`、`get_game_rebuild`

完整参数与边界见 [CLI/MCP 指南](CLI-MCP.md)。

## 权限边界

- 不暴露缓存清理、维护删除、项目删除或备份恢复工具。
- 不提供打开 USB/串口、实时捕获、键盘报告采集、驱动安装或固件刷写工具。
- 硬件枚举来自本机回环 API；远程 API 模式返回 403。
- `scan_game_directory` 仅扫描 API 服务端 `RE_GAME_ROOTS` 显式允许的目录；未配置返回 403，越界返回 403，HTTP MCP 不能绕过。
- 游戏复活产物是独立兼容实现，不是原始服务端；不保证商业原客户端兼容，不绕过 DRM/反作弊/认证，不分发未授权资源。
- 工具权限不由模型文本或目标内容授予；模型输出为 `INFERENCE`。
