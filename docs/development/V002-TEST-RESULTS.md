# v0.0.2 测试结果

最后更新：2026-11-24 UTC+8

## Phase 0 基线

- `npm run typecheck`：通过。
- `npm run lint`：通过，0 warnings。
- `npm test`：5 文件、23 项通过。
- `npm run test:e2e`：2 项通过。
- `npm audit --omit=dev`：0 vulnerabilities。
- Windows/Ubuntu/Docker v0.0.1 CI：已在 main `4c7a46f` 通过。

## v0.0.2 新功能测试

- `npm run build`：通过（含 Electron 主进程与 Web）。
- `npm run typecheck`：通过。
- `npm run lint`：0 errors。
- `npm test`：6 文件、30 项通过（新增迁移、缓存、资源、保留、官方 MCP 双传输）。
- `npm run test:e2e`：2 项通过。
- CLI TGZ 干净 prefix 安装：`--version`/`--help` 通过。
- Skill 结构与脚本：待 CI ZIP 解压复验。
- PR CI：Windows、Ubuntu、Docker 三项检查全部通过。
- Windows EXE：本机 Electron 下载网络失败，未伪造结果；由 windows-desktop job 构建并执行安装/便携版 smoke。
- 服务端 TGZ Linux 解压安装启动：由 package job 验证。
