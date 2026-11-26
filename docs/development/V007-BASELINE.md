# V007 基线核实

更新：2026-11-26。范围：v0.0.6 正式源码、GitHub Release、CI 与本机复跑。结论仅适用于本次核实；开发中的 v0.0.7 不得沿用本文件的通过状态。

## 发布基线

| 项目 | 核实结果 | 证据 |
| --- | --- | --- |
| 仓库 | `alicia1030su/reverse-everything` | GitHub API |
| 默认分支 | `main` | GitHub API |
| v0.0.6 Commit | `787846a454c3bf001a84502dc85735c9b41c4049` | Release Run `head_sha`；本地分支基点 |
| Annotated Tag object | `1ac497fdec54ae3040432f42bd31b462c339b8dd` | Git Tag API，解引用上述 Commit |
| Release Run | `45792899427`，`success` | freeze/candidate-linux/candidate-windows/candidate-game-docker/candidate-acceptance/tag-draft/upload-verify/publish-stable 全成功 |
| Release | `v0.0.6`，`draft=false`，`prerelease=false` | GitHub Release API |
| Latest | `v0.0.6` | GitHub Latest API |
| 资产 | 12 个 | Release API 与本地发布记录 |
| 开发分支 | `feat/v0.0.7-legacy-revival` | 从正式 `787846a...` 创建 |

12 个资产为：`ACCEPTANCE.json`、`BUILD-INFO.json`、`docker-image.json`、`openapi-v0.0.6.json`、`RELEASE-MANIFEST.json`、CLI TGZ、Windows Portable ZIP、Server TGZ、Windows Setup EXE、Skill ZIP、`SBOM-v0.0.6.json`、`SHA256SUMS.txt`。

## 工程基线

| 项目 | 结果 | 说明 |
| --- | --- | --- |
| 本机运行时 | Node `v22.22.2`，npm `10.9.7` | 满足 `engines.node >=22.13.0` |
| 工作区 | npm workspaces；React/Vite Web、Fastify API、独立 Worker、SQLite、Electron | `package.json` 与现有架构 |
| 数据库 | Schema 5 | `packages/contracts/src/index.ts` |
| MCP 工具 | 44 | `apps/cli/src/tools.ts` 注册项 |
| 版本 | 0.0.6 | `package.json`、OpenAPI 与版本文档 |
| 发行方式 | EXE、Portable、CLI、Server、MCP stdio/HTTP、Skill、REST、Docker | v0.0.6 资产与入口 |

## 本机复跑

| 命令 | 结果 | 证据类型 |
| --- | --- | --- |
| `npm test` | 64 files，724 passed / 9 skipped / 0 failed，退出码 0 | 命令+测试报告；2026-11-26 本机复跑 |
| `npm run test:e2e` | 26/26 passed，退出码 0 | 命令+浏览器报告；2026-11-26 本机复跑 |
| Release Run | 8 个发行阶段全部成功 | GitHub API |
| FPS/RPG Docker | 正式候选 Run 中真实通过 | CI 证据；不是本机 Docker |

## 9 项历史跳过测试

本机 Windows 的 9 项均属单元/集成套件，E2E 不计入该数字。

| 文件 | 数量 | 条件 | 覆盖要求 |
| --- | --- | --- | --- |
| `tests/unit/deep-adapters.test.ts` | 2 | 外部 Ghidra/JADX 未配置 | 真实工具 CI 必须单独通过，不能用模拟替代 |
| `tests/unit/android-real.test.ts` | 1 | `RE_RUN_ANDROID_REAL !== '1'` | Android 真实验收工作流 |
| `tests/unit/windows-file-safety.test.ts` | 1 | 非 Windows 分支 | Windows CI |
| `tests/unit/artifact-read-safety.test.ts` | 1 | Windows 跳过符号链接用例 | Ubuntu CI |
| `tests/unit/hardware-enumerate.test.ts` | 1 | Windows 跳过 sysfs 用例 | Ubuntu CI |
| `tests/unit/upload-read-safety.test.ts` | 1 | Windows 跳过符号链接用例 | Ubuntu CI |
| `tests/integration/api-safety.test.ts` | 2 | Windows 跳过链接/符号链接用例 | Ubuntu CI |

平台跳过本身不是缺陷；缺陷是未建立跨平台证据映射或把跳过项宣传为通过。

## 真实性基线结论

- Game Revival 能生成、构建并联调固定 FPS/RPG 模板；这部分能力真实存在。
- 当前规格主要依赖文件名/路径正则与用户 observation；没有目标游戏行为 IR，也没有原客户端协议生成链路。
- 当前多人验证使用项目内部的 WebSocket 客户端，不构成原客户端兼容证据。
- AI V3 存在于平台其他工作流，但 Game Revival 的 spec/rebuild 没有调用模型。
- v0.0.6 的 L0-L7 当前混合了“生成服务实现能力”和“目标游戏复活证据”，v0.0.7 必须拆分。
- CODOL 2021 仍无最终客户端、资源、协议记录或授权；不得宣称兼容。

## 已确认文档偏差

1. `README.md:29,69,195` 仍写本机 Docker 不可用、L7 待 CI，但正式候选 CI 已通过。
2. `docs/development/V006-CAPABILITY-MATRIX.md` 仍把 Docker/L7 标为 `BLOCKED`。
3. README/UI 的“基于证据生成”未明确限定为“文件指纹/路径与显式观察驱动的模板生成”。
4. 验证报告把内部协议客户端标为 `real-game-client`，证据标签过强。
5. v0.0.6 基准文件版本为 0.0.6，但记录 Commit 是 v0.0.5 快照，不能证明正式 v0.0.6 提交性能。

以上问题登记于 `V007-DEFECT-REGISTER.md`。
