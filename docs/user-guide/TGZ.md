# 安装包与候选产物（v0.0.4）

v0.0.4 仍在开发分支。以下文件名对应构建脚本输出，不表示正式 Release 已发布；安装包是否可交付以最终门禁为准。

## CLI TGZ

```bash
npm run package:cli
npm install -g ./dist/release/reverse-everything-cli-0.0.4.tgz
reverse-everything --version
reverse-everything health
```

CLI 包包含 dist 与公开依赖，不依赖 monorepo 私有 workspace。需要 Node.js 22.13+。

## Server TGZ

```bash
npm run package:server
tar -xzf ./dist/release/reverse-everything-server-0.0.4.tar.gz
cd server
npm ci --omit=dev
npm start
```

服务端包需要 Node.js 22.13+，不是自带运行时便携包。网页分析另需 `npx playwright install chromium`。默认仅监听 `127.0.0.1:4173`。

## Skill ZIP

```bash
npm run validate:skill
npm run package:skill
```

输出为 `dist/release/reverse-everything-skill-0.0.4.zip`。Windows EXE/Portable 见 [Windows 指南](WINDOWS.md)。

## 验收边界

- 从干净目录安装并验证 CLI、Server、Skill、OpenAPI 与 API 版本一致。
- Ghidra Node launcher 与外部工具路径必须从 neutral CWD 验证，不只检查文件存在。
- 默认无宿主 USB、无 privileged、无实时捕获。
- 发布前核对包内版本、哈希、构建 Commit 与最终清单；不得把候选包称为已发布稳定版。
