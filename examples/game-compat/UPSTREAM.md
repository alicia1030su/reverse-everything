# 原始客户端样本与许可证

本目录只保留原始浏览器客户端资源，用于验证独立兼容服务端；上游服务端源码未复制、未作为生成器输入。

## Pixelknight

- 上游：https://github.com/imdvls/Pixelknight
- 固定提交：`d6636aa971983947bb5d1b0e9b40861d305e3f6e`
- 许可证：ISC（上游 `package.json` 明确声明 `"license": "ISC"`）
- 保留文件：`index.html`、`game.js`、`styles.css`
- 客户端协议：WebSocket JSON，固定连接 `ws://localhost:8080`

## Tron

- 上游：https://github.com/leodhin/trongame
- 固定提交：`18ca856294758807749be4964e7544fd1896d140`
- 许可证：ISC（上游 `package.json` 明确声明 `"license": "ISC"`）
- 保留文件：`public/` 下 HTML、CSS、JavaScript 与音频资源
- 客户端协议：Socket.IO namespace `/game`

ISC 许可证允许使用、复制、修改和分发，前提是保留版权与许可声明。两个上游仓库的 `package.json` 均声明 `"license": "ISC"`，但 README 的许可证段落写的是 MIT，且仓库未包含独立 LICENSE 文件；本项目按较明确的包元数据 ISC 声明处理，同时在演示包内保留 ISC 文本与版权说明，不声明拥有上游商标或素材权利。原始客户端文件摘要固定在 `CLIENT-SHA256.json`，E2E 在启动服务前校验。v0.0.7 的演示 ZIP 会随 Release 公开发布这些 ISC 客户端资源；如上游权利人提出异议，应立即下线对应演示资产。
