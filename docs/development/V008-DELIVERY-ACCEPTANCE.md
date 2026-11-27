# v0.0.8 交付验收单

> 目标版本：v0.0.8。状态：正式发行验收通过。

## 验收信息

| 字段 | 值 |
|---|---|
| 验收日期 | 2026-11-27 |
| 冻结 Commit | `d2334ee267098e30f44b72c80f975e520abbc47c` |
| Build Commit | `d2334ee267098e30f44b72c80f975e520abbc47c` |
| Annotated Tag 解引用 Commit | `d2334ee267098e30f44b72c80f975e520abbc47c` |
| 候选验收 Run | `45986134905` |
| 正式发行 Run | `45994026211` |
| 资产清单 | Release `RELEASE-MANIFEST.json` 与 `SHA256SUMS.txt`，共 15 个资产 |
| 验收方式 | 独立规则验收 + CI/候选/公开下载复验 |
| 当前稳定版 | v0.0.8 |

## 功能验收

| 项 | 通过条件 | 当前状态 |
|---|---|---|
| 自然语言创建 | Web/API/CLI/MCP 返回同一任务模型 | PASS：单元/API/E2E |
| 动态追问 | 只问缺失字段，答案合并且不重复 | PASS：单元/E2E |
| 契约与计划批准 | 未批准不执行，未授权被阻塞 | PASS：单元/API/CLI/MCP 回归 |
| 真实执行 | 子任务真实终态，步骤结果持久化 | PASS：真实 WorkflowEngine 与 E2E |
| 暂停/恢复/取消 | 状态版本正确，成功步骤复用 | PASS：Autopilot 单元/API/E2E |
| 交付完整性 | 五类文件、manifest、SHA-256、独立验收 | PASS：单元/API/E2E |
| 模型管理 | Provider、角色、探测、预算、脱敏 | PASS：Mock/API |
| 远程模型 E2E | 真实 Key 完成目标任务 | BLOCKED：V008-003，`MISSING_API_KEY` |
| Web 产品化 | 首页、任务、交付、模型管理四态 | PASS：真实 API E2E |
| 文档 | 用户/开发文档、README、docs:check | PASS |
| 安全审计 | P0=0、P1=0，独立复审 | PASS |
| 性能 | 固定环境 P50/P95、资源与恢复 | PASS：本机 Engine/E2E 基准 |
| 分平台 | Ubuntu/Windows/macOS 口径明确 | PASS：Ubuntu/Windows；macOS UNVERIFIED |
| 安装升级 | 覆盖安装、Portable、neutral CWD smoke | PASS：Windows 候选 |
| 公开发行复验 | 固定 URL 下载、哈希、Latest、Run | PASS：15 资产复验 |

## 证据包

- [x] `V008-TEST-RESULTS.md` 回填最终分平台与发行结果。
- [x] `V008-PERFORMANCE.md` 回填固定环境测量。
- [x] `V008-MODEL-VALIDATION.md` 保持真实模型 BLOCKED。
- [x] `V008-SECURITY-AUDIT.md` 回填独立复审与缺陷关闭证据。
- [x] 原客户端 E2E 证据来自本次运行，未回退历史 JSON。
- [x] 资产清单、SHA256SUMS、BUILD-INFO、RELEASE-MANIFEST、ACCEPTANCE、provenance 完整。
- [x] Tag Commit = Build Commit = Acceptance Commit。
- [x] 上一稳定版 v0.0.7 固定下载链接保留且可访问。

## 当前结论

**v0.0.8 正式发行验收通过。** 全量测试、E2E、性能、安全复审、候选安装升级、原子发布与公开复验均完成；V008-003 真实远程模型保持 OPEN P2 / BLOCKED，不影响 P0/P1 清零结论。
