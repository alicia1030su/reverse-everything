# REST API

- 基础地址：`http://127.0.0.1:4173/api/v1`
- 兼容地址：`/api`，两者路由相同。
- 认证：`Authorization: Bearer <local-token>`
- OpenAPI：`/api/openapi.json` 或 `docs/api/openapi-v0.0.2.json`
- 错误：`{error:{code,message,requestId,details?}}`
- 列表：`limit`/`offset`；项目/任务保留数组响应并提供 `x-total-count`。
- 长任务：创建后轮询 `/api/tasks/{id}` 或订阅 SSE `/api/tasks/{id}/events`。

远程监听必须显式设置 `RE_ALLOW_REMOTE=true` 和 `RE_ALLOWED_HOSTS`，并使用非空本地令牌。默认仅回环。
