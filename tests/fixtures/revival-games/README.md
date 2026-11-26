# 自有游戏复活测试样本

`examples/revival-games/fps` 与 `examples/revival-games/rpg` 均为本仓库新编写的测试游戏，使用原创名称、原创规则与固定虚构测试数据；未复制任何第三方游戏代码、协议、地图、角色或资源。

- `original-server.mjs`：Node.js 22 ESM 原始 WebSocket 服务，仅使用 `ws`。
- `client.mjs`：真实 WebSocket 客户端，自动执行完整流程并断言结果。
- `capture.mjs`：启动原始服务、执行客户端、停止服务、重启同一持久化文件验证恢复，再生成 `captured-trace.json`。
- `captured-trace.json`：由运行中的服务与客户端实际收发的消息，包含方向、客户端标识、消息类型、真实 payload 与流程验证结果；不是预先写死的重建答案。
- `spec.json`：供平台重建使用的 `GameServerSpec` 通用草案。

运行：

```sh
node examples/revival-games/fps/capture.mjs
node examples/revival-games/rpg/capture.mjs
```

两个脚本均使用临时持久化目录与随机本地端口，并在 `finally` 中回收服务进程。测试账号、密码和角色名均为固定虚构数据。
