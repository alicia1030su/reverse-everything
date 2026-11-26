# V006 开发计划

## 需求锁定

- 档位：Q3 / 已降级（用户明确要求全过程自主执行；未确认假设 0 条涉及商业游戏兼容，全部作为显式阻塞处理）。
- S1：生成至少一个经过真实多人联机、可独立运行与部署的自有游戏服务端。
- S2：In：通用重建引擎、自有 FPS/RPG、Web/API/CLI/MCP/Skill、发行；Out：绕过 DRM/反作弊/认证、来源不明商业源码/数据、未授权资源公开。
- S3：生成工程实际 build/start；两个以上客户端完成同场游戏；持久化/重连；Docker Compose 实跑；既有测试与 E2E 无回归。
- S4：沿用 React/Vite、Fastify、Node Worker、SQLite、npm workspaces；默认 AI 关闭；证据优先。
- S5：Schema 5 游戏档案、文件索引、规格、重建任务与验证证据；旧库迁移前备份。
- S6：正式 Release 为不可逆公开操作，按用户明确授权执行候选验收→Tag→唯一 Draft→校验→公开；失败不新建重复 Tag。

## 架构决策

- 新增 `@reverse/game-revival`：目录扫描、规格建模、独立工程生成、真实联机验证。
- 生成服务使用 TypeScript + Node + WebSocket，模块化单体，JSON 原子持久化；不依赖平台 API。
- 平台持久化仅保存档案/规格/验证报告与工件哈希；游戏运行状态由生成服务独立持有。
- 旧 game adapter 保留为协议/状态兼容分析，不再用 L4 表示多人服务端完成。
- L0-L7 必须由验证报告推进；原始商业客户端兼容性与自有客户端验证分开计量。

## Wave

1. Phase 0：基线、缺陷登记、能力矩阵。
2. Phase 1-4：档案、增量目录扫描、证据与规格。
3. Phase 5-8：生成、构建、联机、持久化、重连、部署。
4. Phase 9-10：管理后台与 Studio。
5. Phase 11-13：FPS/RPG/公开许可样本、并发基准、Adapter SDK。
6. Phase 14-18：文档、全入口、资源限制、全量复审。
7. Phase 19：原子发行与公开下载复验。

## 检查点

每完成一个 Wave 更新 `docs/development/V006-PROGRESS.md` 与项目记忆。任何 P0/P1、构建失败、联机失败或部署失败均阻断正式发布。
