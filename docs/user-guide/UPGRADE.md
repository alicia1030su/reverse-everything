# 从 v0.0.4 升级到 v0.0.5

v0.0.5 引入 Schema 4、主机研究档案、分析计划、授权范围、工具与演示表。升级前请备份 `data/`，不要删除旧数据库。

## 升级步骤

1. 停止 API、Worker 与桌面端。
2. 备份整个 `data/` 目录，包括 SQLite、WAL/SHM、上传、产物、`secret.key` 与 `local-token`。
3. 安装 v0.0.5 或替换应用目录。
4. 启动后检查 `/api/version`：产品版本应为 `0.0.5`，当前 `schemaVersion=4`。
5. 检查现有项目、任务、证据、缓存、设置与备份是否完整。
6. 如迁移失败，保留备份与错误信息，不要手工删除数据库文件。

## 自动迁移

- Schema 3 → 4 会新增 `console_profiles`、`analysis_plans`、`authorization_scopes`、`tool_installations`、`demo_runs`、`project_deletion_intents`。
- 迁移前自动创建 `pre-v4-*.sqlite` 备份。
- 旧项目、任务、证据、缓存与加密设置保持不变。
- 新 adapter `console` 不会自动修改旧任务。

## 回滚

回滚到 v0.0.4 前应恢复升级前备份。旧版本不认识 Schema 4 新表，不要用旧 Worker 处理 v0.0.5 队列或新 adapter 任务。

## v0.0.5 新边界

- 默认只读、本地保存、凭证脱敏。
- 远程 AI 共享需显式同意。
- 主机 C0-C5 是证据等级，不是权限。
- 真实 PS5/Xbox/Android TV 未提供时，相关能力保持 `BLOCKED` / `UNKNOWN`。
