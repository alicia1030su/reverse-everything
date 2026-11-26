# V006 缺陷登记

更新：2026-11-26。

| ID | 级别 | 问题 | 根因/证据 | 修复方向 | 状态 |
| --- | --- | --- | --- | --- | --- |
| V006-001 | P1 | L4 仅单兼容会话，不能表达多人服务端 | 旧 `game` adapter 只生成单 `server.mjs` | 独立 Game Revival 引擎与 L0-L7 | 已修复 |
| V006-002 | P1 | 无房间、权威战斗、结算、重连 | 旧 adapter 无多人状态机 | 自有 FPS/RPG 真实联机与持久化 | 已修复 |
| V006-003 | P1 | 无完整独立部署工程 | 旧工件缺少源码、数据库、后台和部署材料 | 生成 TS 工程、Docker/脚本/后台 | 已修复 |
| V006-004 | P1 | 游戏目录只能单文件上传 | 上传限制且无目录索引 | 本机只读增量扫描与强制根白名单 | 已修复 |
| V006-005 | P2 | 固定模板响应容易误解为服务端恢复 | compatibilityModel 的 observed responses | 明确独立兼容实现边界 | 已记录 |
| V006-006 | P2 | AI 未参与通用服务端重建 | 旧 adapter 确定性推断 | 可选、有界、Schema 校验；不虚构 AI 验收 | PARTIAL |
| V006-007 | P2 | 本地 main 指针落后于已发布 v0.0.5 | 本地 b259042，远端 6cbd36c | 以发布快照建立 v006 基线 | 已修复 |
| V006-008 | P2 | 性能复测与历史数值不同 | 环境与运行波动 | 记录真实采样，不伪称一致 | 已确认 |
| V006-009 | P1 | Windows 安装器偶发 0xC0000005 | 历史发布失败日志；本轮首次失败为运行时缺依赖 | 刷新 desktop-runtime、保留 `signAndEditExecutable:false`、静默安装+smoke | 已修复并复验 |
| V006-010 | P2 | 9 项 skipped 测试需逐项审计 | 平台/工具条件 | 区分平台限制与真实缺陷，CI 对应平台执行 | 已完成 |
| V006-011 | P1 | 扫描目录 TOCTOU 可越出根目录 | `lstat` 与 `opendir` 之间可替换链接 | realpath 前后校验、身份比对、no-follow | 已修复 |
| V006-012 | P1 | 文件增长可绕过 maxBytes | 读取前单次 stat | 读取硬上限、实际字节计数、读后 fstat 四元校验 | 已修复 |
| V006-013 | P1 | skipped 数组无界 | 达到字节上限仍继续遍历 | 达上限停止，skipped 最多 100 | 已修复 |
| V006-014 | P1 | 增量哈希可复用过期摘要 | 仅 size+mtime | 加入 ctime/dev/ino，复用降为 INFERRED | 已修复 |
| V006-015 | P1 | 客户端可自报 VERIFIED observation | API 未校验且 spec 直接信任 | 完整 schema；客户端最高 INFERRED | 已修复 |
| V006-016 | P1 | 无证据模块/地图被无关文件提升 | 默认 INFERRED | 无证据 UNKNOWN，相关观察才提升 | 已修复 |
| V006-017 | P1 | 无扫描文件也可升 L2 | API 无条件写 L2 | 使用 `spec.level`，无文件保持 L0 | 已修复 |
| V006-018 | P1 | 重建失败仍保留 L3 | 初始等级虚标 | 初始/失败恢复 L2，报告驱动晋级 | 已修复 |
| V006-019 | P1 | 扫描/重建无全局并发上限 | 仅同项目互斥 | 扫描最多 2、重建最多 1，超限 429/503 | 已修复 |
| V006-020 | P1 | 重建无总超时 | 未传 AbortSignal | 总超时、取消、失败清理输出 | 已修复 |
| V006-021 | P1 | 验证器握手/fetch 无超时、非法 JSON 可崩溃 | WS/fetch 缺少统一截止时间 | 全程超时、解析失败拒绝 waiter 并关闭 socket | 已修复 |
| V006-022 | P1 | 生成服务认证/房间/token 无资源上限 | 未认证 scrypt 与无界 Map | 连接/速率/scrypt 信号量/token 清扫/房间配额与 TTL | 已修复 |
| V006-023 | P1 | resume token 可重放并双会话控制 | 未吊销旧连接 | 强制关闭旧 socket、轮换 token、旧 close 不删新会话 | 已修复 |
| V006-024 | P1 | 持久化失败仍健康、关停不等待保存 | 错误仅打印日志 | 健康 503、flush 与关停超时 | 已修复 |
| V006-025 | P1 | WS 同源检查可被 DNS rebinding 绕过 | 只比较请求 Host/Origin | ALLOWED_HOSTS/ORIGINS 白名单，本地默认 loopback | 已修复 |
| V006-026 | P1 | ZIP 中央目录按文件内容猜 header | 普通内容可伪装 PK header | 直接使用遍历元数据 | 已修复 |
| V006-027 | P1 | 归档打包 node_modules 且全量进内存 | 无排除/上限/流式 | 排除依赖与数据，2000 条目/64MiB 上限 | 已修复 |
| V006-028 | P1 | 归档根与条目名缺少 canonical/zip slip 校验 | 仅词法 relative | realpath+lstat、POSIX 相对名、拒绝盘符/反斜杠/控制字符 | 已修复 |
| V006-029 | P1 | Docker 清理失败无兜底 | 仅一次 compose down | 重试、项目 label/container ID 强制清理、失败报告 | 已修复 |
| V006-030 | P1 | 生成镜像可打包数据且以 root 运行 | 无 .dockerignore/USER | 非 root、最小 COPY、数据卷可写 | 已修复 |
| V006-031 | P1 | 发行门禁只信任 Docker 布尔值 | 未校验 evidence 内容 | 独立校验清理、健康、WS、管理认证、checks、schema/hash | 已修复 |
| V006-032 | P1 | 工作台跨项目 spec/active 串台 | 切换项目未重置状态 | 项目绑定、重置 mutation、历史按项目过滤 | 已修复 |
| V006-033 | P1 | rootPath 变更后旧扫描证据/等级仍有效，旧重建可覆盖新档案 | 档案 UPSERT 未失效证据，重建无条件更新等级 | 变更时清理文件/规格/重建并重置 L0；updated_at 条件更新 | 已修复 |
| V006-034 | P1 | API 关停不取消/等待后台重建 | 后台任务脱离请求生命周期 | preClose/onClose 取消并等待，清理输出 | 已修复 |
| V006-035 | P1 | 子进程超时只杀直接进程，可能遗留进程树 | Windows shell/POSIX npm 后代未终止 | detached 进程组/taskkill /T /F，等待 close | 已修复 |
| V006-036 | P1 | 归档 readFile 无硬读取上限且下载无并发限制 | stat 后文件增长；API 无限并发 | FileHandle 限读 max+1；归档信号量最多 2 | 已修复 |
| V006-037 | P1 | 同一 socket 并发认证产生孤儿 session | 无 authenticating 互斥 | 认证互斥，重复认证关闭连接 | 已修复 |
| V006-038 | P1 | 持久化队列无界且 flush 失败仍成功 | 每次变更追加全库保存，错误被吞 | 有界合并、pendingWrites、flush 失败返回 false | 已修复 |
| V006-039 | P1 | Docker 仅删容器就宣称清理成功 | 未删卷/网络 | 按 label 删容器/卷/网络并核验残留 | 已修复 |
| V006-040 | P1 | 发行证据可接受矛盾报告且 hash 未绑定 | 只校验布尔值 | 拒绝 errors/失败 check，embedded 深一致，SHA256SUMS 实算 | 已修复 |
| V006-041 | P1 | Windows 桌面端未闭合 npm 运行时 | 普通用户无系统 Node/npm | 固定 npm@10.9.7、runtime 290 包、RE_NPM_CLI、真实重建 smoke | 已修复 |
| V006-042 | P1 | 负向 observation 被当作正向证据 | 非 UNKNOWN 均提升 | NOT_IMPLEMENTED/INACCESSIBLE 映射 UNKNOWN | 已修复 |

所有 P0/P1 已清零。Docker/L7 仍为发行阻断项：本地无 Docker，必须由 CI 真实执行 FPS/RPG Compose 验收并通过严格证据校验后才可发布。
