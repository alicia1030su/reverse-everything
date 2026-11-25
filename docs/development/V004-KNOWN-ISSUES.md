# v0.0.4 已知问题与限制

最后更新：2026-11-25。

- 真实物理 USB 设备、实时捕获、驱动安装和用户凭证未授权；相关能力不宣称已实测。
- 当前 WorkBuddy 宿主 safe-delete 会让 `platform.test.ts` 在 8 项测试通过后清理失败；修复前本地全量 suite 非零退出。
- Windows 未签名安装包可能触发 SmartScreen；不伪造代码签名。
- 网页兼容产物是静态预览，不是原后端或完整动态网站克隆。
- 游戏 L4 是独立状态化兼容服务，不是原始服务端恢复。
- AI 无真实 Key 时只运行规则分析；fake model 测试不标为真实模型验收。
- Docker 默认无宿主 USB；不提供 privileged 或整目录设备映射。
- 加密固件保持 UNKNOWN，不自动绕过保护。
- v0.0.4 正式 Release 尚未创建。
