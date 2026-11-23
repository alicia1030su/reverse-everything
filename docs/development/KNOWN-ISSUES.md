# 已知问题与限制

最后更新：2026-11-24（UTC+8）

## 发布阻塞

无。GitHub Actions Windows/Ubuntu/Docker 门禁已通过；本机未安装 Docker，但容器 build/run 已在 GitHub runner 实测。

## 功能限制

- 无 Ghidra 反编译、函数调用图或原生运行时沙箱。
- 文件解析只读取前 8MB；PE/ELF/Mach-O 对截断或恶意 header 可能不完整。
- ZIP 只读中央目录；不解压 APK/DEX，不分析资源语义。
- SBOM 是依赖清单，不在线匹配 CVE。
- 网页仅单页同源采集；多页面交互、HAR 导入、状态机与克隆未实现。
- 游戏服务仅回放观察到的响应模板；不是原服务端逻辑恢复。
- 安全规则是候选，可能误报/漏报；无主动利用。
- 独立 Skill 包未发布；CLI/MCP 已完成。
- 英文 i18n 未实现。

## 工程限制

- 跨任务缓存未实现；同任务重试复用成功阶段输出。
- 暂停/取消在阶段边界响应；浏览器阶段可能需等待自身超时。
- Worker 并发固定为 1；环境变量并发调节尚未实现。
- 自动内存熔断、进程树峰值统计、长期保留策略尚未实现。
- 本地令牌等同本机 API 权限，不是多用户认证。
- Node `node:sqlite` 仍提示实验性 API。
- Web 生产包按需加载 Monaco；首次打开代码视图仍需下载本地大文件。

## 已修复

- Worker 定时器未引用导致提前退出。
- 上传文件路径缺少 projectId。
- Playwright route 回调变量遮蔽导致未捕获异常。
- IP 字面量使用 host-resolver-rules 导致 ERR_NAME_NOT_RESOLVED。
- API 静态资源被认证拦截 / 资产回退为 HTML。
- 阶段重试 attempt 未递增。
- SARIF、AI 加密配置与真实 provider 调用验证。
