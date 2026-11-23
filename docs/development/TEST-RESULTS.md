# 测试结果

最后更新：2026-11-24（UTC+8）

> 本文件只记录实际执行的命令与结果。最终发布前必须重跑并更新；未执行的检查标为“未验证”。

## 环境

- Windows 11 专业版 x64，Node 22.22.2，npm 10.9.7。
- 内存 31.48GB；审计时空闲 21.15GB。
- Chrome 157 已安装；Docker CLI/服务未安装。
- GitHub CLI 2.105.0，登录 `alicia1030su`。

## 已验证（2026-11-24 UTC+8）

- `npm run build`：通过；Monaco 本地拆包并懒加载，主包约 484KB（gzip 154KB）。
- `npm run typecheck`：通过。
- `npm run lint`：通过，0 errors / 0 warnings。
- `npm test`：**5 个文件、23 项全部通过**。
  - 单元 15 项：SSRF、加密/脱敏、协议推断、证据哈希、工作流暂停/重试、ZIP 安全。
  - 真实集成 8 项：认证、文件 Worker、网页采集、游戏 E2E、静态安全正负样本、AI 加密/INFERENCE、SARIF、CLI/MCP。
- `npm run test:e2e`：**2 项全部通过**（真实文件创建、真实本地网页采集）。
- `npm run check:secrets`：123 个文本文件通过。
- `npm audit --omit=dev`：**0 vulnerabilities**。
- `npm run licenses`：119 个生产依赖；MIT 89、ISC 14、BSD-3-Clause 7、BlueOak 6、Apache-2.0 2、MPL-2.0 OR Apache-2.0 1；无不兼容项。
- 游戏捕获：`capture.mjs` 实际录制 9 条消息。
- 游戏 E2E：生成服务通过 hello/login/move/logout；等级 L3（协议兼容，不是原服务恢复）。

## 修复过程中复现的问题

1. Worker 仅持有 unref 定时器导致进程退出 → 移除 unref。
2. INTAKE 上传路径缺 projectId → 修正目录。
3. Playwright route 回调 TDZ 变量遮蔽 → 移除错误调用。
4. IP 字面量 host resolver 规则 → IP 目标不注入 MAP 规则。
5. 静态页面被令牌拦截、资产回退 HTML → 静态 GET 放行 + fastify-static。
6. retry attempt 未递增 → 修正。
7. 归档路径穿越测试夹具需绕过 yazl 自身文件名校验 → 二进制替换同名长度字段。

## 性能（`node scripts/benchmark.mjs`，Windows 单机顺序任务）

- 启动至 API 健康：27ms。
- API 空闲：RSS 113MB，heap 50MB。
- Worker 空闲/文件任务自报：RSS 91MB，heap 37MB。
- 文件任务：229ms；API 峰值 113MB；9 条证据、7 个产物。
- 网页任务：1110ms；API 峰值 115MB；Worker 自报峰值 106MB；11 条证据、8 个产物。
- 游戏任务：583ms；API 峰值 117MB；Worker 自报峰值 106MB；9 条证据、10 个产物。

完整数据见 `PERFORMANCE.json`。RSS 是 Node 进程自报，**不包含 Chromium 子进程**；这些观察不是资源保证。API 空闲观察值低于 350MB 参考目标，但不能据此宣称所有轻量任务峰值都低于 1GB。

## Docker

本机未安装 Docker，**本机容器验证未执行**。GitHub Actions `docker` job 将执行 compose build、健康检查、Web 页面与容器内 CLI；只有该 job 通过才作为发布证据。

## 依赖与安全扫描

- `npm audit --omit=dev`：0 vulnerabilities。
- 生产依赖许可证：119 个包，无不兼容项。
- 仓库秘密扫描：通过。
