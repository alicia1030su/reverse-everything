# 逆向万物安全模型（v0.0.4）

## 1. 资产与威胁

平台处理来源不可信的软件、网页、APK、USB/HID 记录、固件、日志、反编译文本与模型输出。主要资产：用户文件、授权会话、API Key、本地数据库、分析产物、设备/串口身份、Agent 指令与执行权限。

威胁包括：SSRF/DNS 重绑定、路径穿越、压缩炸弹、恶意网页、提示词注入、秘密泄露、任意代码执行、任务失控、跨站请求、产物污染、reparse point、缓存投毒、越权设备访问与固件刷写。

## 2. 授权门禁

- 创建项目必须显式 `authorizationConfirmed=true`，任务在 AUTHORIZATION_CHECK 阶段再次验证。
- 本地 URL 需 `allowLocal=true` 且 `confirmLocal=true`。
- 不绕过登录、验证码、付费、DRM、反作弊或第三方账号验证。
- 主动安全测试默认关闭；只做被动 HTTP 与静态规则。
- 设备所有权不等于在线服务、第三方账户、平台安全机制或刷写授权。
- 商业工具仅使用用户合法授权版本，不打包许可证或绕过激活。

## 3. 输入与执行

- 默认上传上限 100MB；流式写入随机文件名并计算 SHA-256。
- 扩展名与 MIME 不是可信证明；按 magic/header 与结构识别。
- 不执行未知上传程序、APK 代码或固件。
- 网页在 Chromium 中运行，仅访问已授权同源；跨源子资源受限。
- 游戏验证只启动本项目根据证据生成的 Node 服务，不启动原客户端二进制。
- 子进程有超时、退出清理与磁盘/内存边界；生成服务仅绑定 127.0.0.1。

## 4. 网络

- 仅 HTTP/HTTPS；URL 不允许内嵌凭证。
- 默认拒绝 loopback、私网、link-local、metadata、保留地址、组播与公网非标准端口。
- 每次重定向重新解析与验证；HTTP 固定已验证 IP，浏览器使用 host-resolver-rules。
- 同源检查覆盖导航与子资源；HAR/响应体不默认保存。
- HAR/PCAP/PCAPNG 是离线输入，不访问记录中的目标。

## 5. 本地访问控制与单实例

- API 默认绑定 127.0.0.1；容器宿主端口仅映射 127.0.0.1。
- Host 必须匹配 localhost/127.0.0.1 或显式白名单；Origin 必须与 Host 同源。
- 随机 32 字节本地令牌存 `data/local-token`，POSIX 模式 0600。
- Web 使用 HttpOnly、SameSite=Strict cookie；CLI/MCP 使用 Bearer token。
- API 使用 SQLite runtime lease 防止同一数据目录多实例；租约丢失后请求 fail-closed。
- Electron 使用单实例锁，第二次启动聚焦已有窗口。
- 本地令牌不是多用户身份系统；拿到令牌等于本地 API 权限。

## 6. 秘密与隐私

- API Key 使用 AES-256-GCM 加密；密钥存 `data/secret.key`，POSIX 模式 0600。
- 设置接口只返回 `hasApiKey`，不返回明文。
- 日志、报告与缓存对 Bearer token、api_key/password/secret/token 等模式脱敏。
- 默认本地存储；AI 关闭。远程模型必须 HTTPS 且显式允许数据共享。
- 模型请求仅发送有界分析摘要，不发送原始上传文件或凭证。
- 公开仓库不得包含 `data/`、`.env`、真实凭证、用户上传或商业资源。

## 7. 硬件与串口

- Windows/Linux 只读枚举 OS 可见 USB 身份、拓扑与串口；不打开设备句柄。
- 序列号不读取；设备可控的 friendly name、manufacturer、driver、interface/configuration 自由文本默认不返回原文，仅返回单向哈希，避免夹带序列号；字段缺失保持 `UNKNOWN`，不生成演示设备。
- 串口仅列出，不打开、不读取、不写入、不改变 DTR/RTS。
- 实时 USB 捕获、驱动安装、键盘报告捕获默认禁用；远程 API 模式拒绝硬件枚举。
- 断开/重连后必须重新核验稳定身份与授权，不继承旧授权。
- 开发板入口复用 `hardware`；固件镜像另走 `firmware`。入口不授予登录、复位、控制线或刷写权限。

## 8. 离线 USB 与 HID

- 接受 USB PCAP/PCAPNG、usbmon、HID report descriptor 与枚举快照。
- 限制输入字节、记录数、时间线条目、描述符数与输出大小；截断必须显式披露。
- 校验 link type、接口/endpoint、ISO 描述符与 item 长度边界；畸形输入 fail-closed。
- 原始数据包 payload 不写入证据；时间线只保留有界传输元数据。
- 离线描述符解析不捕获真实键盘报告，也不证明设备完整语义。

## 9. 固件

- BIN/IMG、Intel HEX、UF2、ELF 与 ZIP 均按不可信输入处理。
- 流式/分块读取，限制镜像大小、地址范围、字符串、熵桶与输出。
- ZIP 只读中央目录；不自动释放、挂载或执行文件系统。
- 不执行、不刷写、不绕过加密/认证/安全启动。
- 加密、高熵或缺少格式证据的内容保持 `UNKNOWN`；组件/SBOM/风险为 `INFERENCE`。

## 10. Windows 文件与工件

- 工件读取前核验普通文件、打开前后身份、大小、mtime 与 SHA-256。
- Windows 私有下载快照使用 `icacls` 重置、仅授予当前 SID 并移除继承；权限设置失败则拒绝读取。
- 拒绝 symlink/Junction/reparse point 路径与读取期间文件替换。
- 临时快照在响应结束或错误路径清理；不把源工件复制到公开目录。

## 11. 缓存、保留与删除

- 缓存仅用于可复用纯阶段；默认项目隔离，global scope 需显式批准。
- 缓存键包含 policy、输入哈希、adapter/阶段/工具版本与脱敏 options；敏感字段不进入键。
- 读取验证 payload SHA-256；损坏按 miss 处理并删除元数据/payload。
- 淘汰只针对 `ref_count=0`；TTL 与容量上限由保留策略配置。
- 维护先 preview 再 apply；活动任务的临时文件与日志受保护。
- 文件删除前再次核验 canonical path、普通文件与身份，避免 symlink/替换竞态。
- 保留策略不自动删除原始上传或正式任务产物。
- 清缓存需 `confirm=CLEAR_CACHE`；维护需 `confirm=CLEAN`；项目删除需精确名称且无活动任务。

## 12. 桌面资源指标

- Electron `app.getAppMetrics()` 与 API/Worker sidecar 快照合并，按 PID/角色去重。
- 指标接口仅本机回环，远程模式拒绝；校验时间新鲜度、进程上限与 RSS 合计。
- 采样失败、进程退出、陈旧、截断或 CPU 缺失写入 `limitations`，不伪造完整值。
- 指标用于观测与压力判断，不构成性能验收；最终数据以测试记录为准。

## 13. 不可信内容与提示词注入

- 外部内容标为数据，不进入系统指令。
- AI system prompt 要求将目标内容视为不可信数据，不声称未验证事实。
- 工具权限不由模型文本授予；动作通过固定 API/Adapter 契约。
- 模型输出统一记为 `INFERENCE`；只有可重复工具测试能记为 `VERIFIED`。
- 前端使用 React 文本渲染，不把证据 HTML 注入页面；代码查看器只读。

## 14. MCP 与 Skill

- stdio `upload_file` 的本地路径必须位于 `RE_MCP_ALLOWED_ROOTS`，解析后不得越界。
- HTTP MCP 只接受 base64，不读取任意本机路径。
- MCP 不暴露缓存清理、维护删除、备份恢复、设备打开、实时捕获或刷写。
- Skill 不保存密钥，不绕过授权；环境检查失败时不得伪造能力可用。

## 15. 安全分析结果

每条候选发现包含标题、分类、等级、位置、依据、前提、证据 ID、置信度、修复建议与状态。默认需复核，不标为已确认漏洞。报告支持 Markdown、JSON/manifest、SARIF 2.1.0。

## 16. 已知边界

- 浏览器仍执行目标 JavaScript；容器/OS 隔离不能替代谨慎授权。
- DNS 固定不能防止目标网页自身发起合法的同源恶意行为。
- 静态规则存在误报/漏报；在线依赖漏洞匹配未启用。
- 硬件只读枚举受 OS 权限与字段限制；不代表物理设备验收。
- Ghidra/JADX 在真实 CI 证据完成前为 `PARTIAL` / `BLOCKED`，不得标 `VERIFIED`。
- 运行时原生程序沙箱、容器 seccomp 细粒度策略与自动内存熔断仍受最终门禁约束。
