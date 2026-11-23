# 架构与开发决策

## ADR-001：本地单用户模块化单体

选择 Fastify API + 独立 Worker + SQLite。多用户、微服务、Kubernetes 对 v0.0.1 无收益。Web 静态资源由 API 同端口提供，减少开发服务器数量。

## ADR-002：Node 22 内置 SQLite

使用 `node:sqlite`，避免 Windows 本机编译原生 SQLite 绑定。要求 Node >=22.13。实验性警告保留，不隐藏。

## ADR-003：npm workspaces

本机无 pnpm；使用 npm lockfile 与 workspaces，不引入额外包管理器阻塞。

## ADR-004：独立 Worker

分析不占用 API 事件循环。Worker 默认并发 1，定时器必须保持引用；早期未引用导致进程退出的问题已由集成测试捕获并修复。

## ADR-005：证据四分类

EVIDENCE / INFERENCE / UNKNOWN / VERIFIED。模型文本永远不是事实依据；VERIFIED 必须来自可重复测试。

## ADR-006：授权与 SSRF

项目授权 + 阶段授权 + 本地额外确认。URL 每次重定向重验证；HTTP 固定 DNS IP；浏览器固定 resolver 并拒绝跨源。

## ADR-007：规则型独立兼容服务

游戏演示从真实回放推断请求/响应模板并生成服务。明确不是原始代码恢复；不包含未观察玩法、账号或反作弊。

## ADR-008：默认关闭 AI

无 Key 可完成基础分析。远程端点需显式数据同意；API Key AES-256-GCM 加密。模型输出统一 INFERENCE。

## ADR-009：有界静态分析

不执行未知上传；文件、字符串、DOM、网络记录、归档均有上限。原生反编译留待 Ghidra provider。

## ADR-010：本地 Monaco

代码查看器本地打包并按需加载，不依赖 CDN；避免证据页面加载时拉取外部脚本。

## ADR-011：诚实发布

Docker 本地不可用时由 GitHub Actions Docker job 验证；任何门禁失败都不发布假装完成的正式版。
