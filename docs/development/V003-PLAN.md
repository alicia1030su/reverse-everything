# v0.0.3 实施计划

## 需求锁定

用户已给出完整 Phase 0–21 规格，并明确授权自主开发、PR、正常合并与 v0.0.3 正式发布；无需逐阶段询问。所有“已完成”必须以代码、实际执行和可重复测试为准。

## 架构原则

- 保留 npm workspaces、Fastify、SQLite、独立 Worker、React、Electron、官方 MCP SDK。
- 业务规则集中在 contracts/workflow/core；API/CLI/MCP/Web/EXE 只做适配。
- 版本、错误码、Task/Project/Evidence ID、状态、权限、日志关联统一。
- 新分析器按需启动，缺依赖时明确 BLOCKED/不可用，不返回空成功。
- 所有发行资产从同一冻结 Commit 构建，Tag 在候选验收之后创建。

## Wave 计划

| Wave | 内容 | 出口证据 |
|---|---|---|
| A | 发行追溯、版本单源、Schema 3、备份恢复 | provenance/version/migration/fault tests |
| B | 缓存分类/single-flight/统计、资源迟滞/系统压力 | cache race/corruption/hysteresis tests |
| C | 网页多页面与重建、HAR/PCAP、Ghidra、APK | 自有样本真实分析测试 |
| D | 游戏 L4、安全 V2、AI 有界闭环、证据搜索 | 端到端与故障测试 |
| E | Web/CLI/MCP/Skill/EXE 六入口 | 同任务语义一致性、Windows GUI E2E |
| F | 长稳/性能/安全/覆盖率/文档 | 报告与全绿 CI |
| G | 冻结 Commit、候选资产、Tag、正式 Release | SHA/provenance/public download 复核 |

## 安全与回滚

- 数据库升级前自动备份；恢复默认写入独立目录，不覆盖唯一副本。
- 损坏数据库保留原文件与诊断，禁止格式化为空库。
- 缓存可禁用/清空，不删除原始上传与正式证据。
- 历史 Tag/Release 不移动、不覆盖。
- 发布失败保留候选与日志；修复后从同一冻结 Commit 重建或重新冻结并重跑受影响门禁。

## 开发资源约束

- 可用内存约 18.7GB；默认单重型构建、单浏览器、单大型分析器。
- 先增量构建与局部测试；CI 承担 Windows 打包和 Linux 容器。
- 不清理用户目录，不停止无关进程，不修改系统安全配置。
