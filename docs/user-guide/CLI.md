# CLI 指南（v0.0.7）

## 启动与认证

先运行 `npm run build`。仓库内使用：

```bash
node apps/cli/dist/cli.js --help
node apps/cli/dist/cli.js --version
```

安装 CLI 包后使用 `reverse-everything`。CLI 默认连接 `http://127.0.0.1:4173`，从 `RE_DATA_DIR/local-token`（默认 `data/local-token`）读取令牌，也可设置：

```bash
export RE_API_URL=http://127.0.0.1:4173
export RE_API_TOKEN=<local-token>
export RE_DATA_DIR=/absolute/data
```

不要把令牌放入 URL 或提交到仓库。全局参数为 `--json`、`--quiet`、`--timeout <ms>`、`--api-url <url>`；`--timeout` 同时用于 HTTP 超时和任务等待预算。Ctrl+C 只终止当前等待，不删除服务端任务。

## 分析入口与实际路由

| 用户入口 | `projects create` 的 kind | `tasks create` 的 adapter |
|---|---|---|
| website | `website` | `website` |
| software | `software` | `file` |
| legacy | `software` | `legacy` |
| android | `software` | `apk` |
| game | `game` | `game` |
| network | `protocol` | `network` |
| security | `security` | `security` |
| usb | `hardware` | `hardware` |
| firmware | `firmware` | `firmware` |
| board | `hardware` | `hardware` |
| console | `console` | `console` |

`usb` 对应 `hardware`。`board` 是开发板场景路由，仅复用 `hardware`，不调用 `firmware`，不是新 adapter，也不宣称特定品牌/型号或实时设备支持。`legacy` 使用 `software` 项目和独立 adapter；本机路径必须位于 API 服务端 `RE_LEGACY_ROOTS` 白名单内，不执行原程序。Ghidra 使用 `software` 项目与 `ghidra` adapter；官方 Ghidra/JDK 已知答案 CI 已通过，验证范围限于 CI 覆盖的 PE/ELF 样本。

## 健康、能力与资源

```bash
reverse-everything health
reverse-everything capabilities
reverse-everything analyzers list
reverse-everything config show
reverse-everything resources status
reverse-everything cache stats
reverse-everything retention show
```

`capabilities` 与 `analyzers list` 都读取 `/api/capabilities`。`resources status` 返回真实 API/Worker/Desktop 快照；采样限制记录在 `limitations`。

## 创建项目、上传与分析

```bash
reverse-everything projects list
reverse-everything projects create "授权软件样本" software --authorized
reverse-everything projects upload <projectId> ./sample.bin
reverse-everything tasks create <projectId> file
reverse-everything analyze file ./sample.bin --authorized
reverse-everything analyze web https://example.com --authorized
reverse-everything analyze web http://127.0.0.1:3100 --authorized --confirm-local
reverse-everything firmware inspect ./firmware.bin --authorized
```

`analyze file` 与 `firmware inspect` 会自动创建项目、上传并创建任务；加 `--no-wait` 可立即返回任务 ID。`analyze web` 只接受 HTTP/HTTPS，本地目标还需 `--confirm-local`。

项目 kind 的有效值为 `website`、`software`、`game`、`security`、`protocol`、`hardware`、`firmware`、`console`。任务 adapter 的有效值为 `website`、`file`、`legacy`、`security`、`game`、`network`、`apk`、`ghidra`、`hardware`、`firmware`、`console`。

## 任务与报告

```bash
reverse-everything tasks list
reverse-everything tasks get <taskId>
reverse-everything tasks logs <taskId>
reverse-everything tasks action <taskId> pause
reverse-everything tasks action <taskId> resume
reverse-everything tasks action <taskId> cancel
reverse-everything tasks action <taskId> retry
reverse-everything report export <taskId> ./report.md
```

动作在安全阶段边界生效；非法状态转换返回 409。`report export` 在报告就绪后下载 Markdown。当前 CLI 没有 `tasks report` 或 `tasks artifact` 子命令。

## 硬件与开发板

```bash
reverse-everything hardware list
reverse-everything hardware doctor
reverse-everything hardware serial
```

当前 CLI 硬件子命令为 `hardware list|doctor|serial`；硬件能力也可由 `capabilities` 或 REST `GET /api/hardware/capabilities` 获取。

这些命令仅从本机回环 API 读取 OS 可见信息：

- 不打开 USB 设备句柄或串口，不改变 DTR/RTS。
- 不启动实时捕获，不采集键盘报告，不安装驱动。
- 远程 API 模式会拒绝硬件枚举。
- 开发板分析使用用户提供的离线固件/记录；查看串口不等于获得登录、复位或刷写授权。

离线上传示例：

```bash
reverse-everything projects create "授权 USB 记录" hardware --authorized
reverse-everything projects upload <projectId> ./usb-capture.pcapng
reverse-everything tasks create <projectId> hardware
```

## 主机研究、计划与演示

```bash
reverse-everything console devices
reverse-everything console device ps5
reverse-everything plans create <projectId> "总结离线请求" ./capture.har --authorized
reverse-everything plans list <projectId>
reverse-everything plans get <planId>
reverse-everything plans execute <planId>
reverse-everything tools list
reverse-everything demos list
reverse-everything demos run firmware
reverse-everything report plain <taskId> ./plain-report.md
```

`plans create` 会创建显式授权范围、读取文件头部并生成确定性计划；不会自动安装工具或扩大权限。`demos run` 创建真实项目与任务，不伪造成功结果。

## 老软件（Legacy Studio）

```bash
reverse-everything projects create "授权老软件" software --authorized
reverse-everything projects upload <projectId> ./retained-tool.exe
reverse-everything tasks create <projectId> legacy
reverse-everything tasks get <taskId>
reverse-everything report export <taskId> ./legacy-report.md
```

`legacy` adapter 只读识别软件与数据格式，生成兼容性/许可诊断，不执行原程序。未上传而使用本机路径时，必须在 API 服务端配置 `RE_LEGACY_ROOTS`（Windows 用 `;`，Linux/Docker 用 `:`），仅允许绝对目录及其子目录。

当前 CLI 的 `tasks create` 只传 adapter；恢复与独立重建选项通过 MCP `create_task` 或 REST `POST /api/projects/:id/tasks` 的 `options` 传入。详见 [老软件指南](../LEGACY-SOFTWARE.md)、[数据恢复](../DATA-RECOVERY.md) 与 [独立重建](../SOFTWARE-RECONSTRUCTION.md)。

## 游戏复活（Game Revival）

先创建 `game` 项目，并在 **API 服务端**配置 `RE_GAME_ROOTS`。Windows 使用 `;` 分隔多个绝对目录，Linux 使用 `:`；仅允许目录本身及其子目录。未配置或路径越界返回 403，HTTP MCP 也不能绕过。

```bash
reverse-everything projects create "自有 FPS" game --authorized
reverse-everything game profile <projectId> "自有 FPS" fps /absolute/games/owned-fps --authorized
reverse-everything game scan <projectId> /absolute/games/owned-fps --authorized
reverse-everything game spec <projectId>
reverse-everything game rebuild <specId>
reverse-everything game status <rebuildId>
reverse-everything game download <rebuildId> ./server.zip
```

`profile` 的类型为 `fps|rpg|unknown`；`scan` 只读、增量扫描并保存指纹，可读取唯一 `behavior.json`/`gameplay.json` 的 V5 行为 IR；`spec` 生成证据分级规格；`rebuild` 异步生成并验证独立服务端；`status` 返回真实阶段、L0-L7 实现等级与目标兼容证据；`download` 仅在重建完成且通过验证后提供 ZIP。

生成服务包含自有多人 FPS/RPG、权威状态、房间隔离、持久化、重连、结算、多房间并发与认证管理后台，可独立构建/启动，不依赖平台 API。L0-L7 只表示实现等级；目标行为、原客户端和协议兼容分开报告，原客户端与协议默认 `UNKNOWN`。v0.0.6 正式候选 CI 的 Docker/L7 已通过，但不保证商业原客户端兼容。详见 [游戏兼容指南](../GAME-COMPATIBILITY.md)。

### 独立服务端部署

解压 ZIP 后，Windows/Linux 使用 Node.js 22.13+：

```bash
npm ci
npm run build
npm start
```

启动前按生成物 `.env.example` 通过环境变量设置至少 16 字符的 `ADMIN_TOKEN`、`GAME_PORT`、`ADMIN_PORT` 与数据路径（生成服务不自动读取 `.env` 文件）；管理后台/API 默认仅回环，必须 Bearer 认证。Docker 环境可在生成物目录运行 `docker compose up -d --build`，其 Compose 文件包含健康检查与数据卷。v0.0.6 正式候选 CI 已验证该部署路径；未在本机实跑时，本机报告仍应注明限制。

## MCP

```bash
reverse-everything mcp stdio
reverse-everything mcp http --port 4174
```

stdio 的本地文件读取必须配置 `RE_MCP_ALLOWED_ROOTS`；HTTP MCP 只接受 `contentBase64`，不读取任意本机路径。默认 HTTP 地址为 `http://127.0.0.1:4174/mcp`，使用同一 Bearer Token。

## 退出码与失败

- `0`：命令成功。
- `2`：缺少/无效本地令牌或认证失败。
- `3`：任务状态冲突。
- `4`：超时或队列/速率限制。
- `1`：参数、网络、适配器不可用或其他错误。

任务等待超时不会取消任务；使用返回的任务 ID 继续查询。能力不可用时不要创建假任务，先检查 `health`、`capabilities` 与工具可用性。
