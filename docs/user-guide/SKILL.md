# Agent Skill（v0.0.6）

Skill 源目录为 `skills/reverse-everything`。可运行 `npm run package:skill` 生成 `dist/release/reverse-everything-skill-0.0.6.zip`，将包内 `reverse-everything` 目录整体放入客户端技能目录。

```bash
npm run validate:skill
node skills/reverse-everything/scripts/check-environment.mjs
node skills/reverse-everything/scripts/inspect-task.mjs <task-id>
```

技能优先使用已配置 MCP，否则使用 CLI/API。必须先确认授权，再选择入口。更新时替换整个技能目录；卸载时删除该目录。技能不保存密钥，不自动忽略授权。

## 工作流

1. 检查环境、CLI/API/MCP 配置与版本。
2. 确认用户拥有目标或获明确授权。
3. 选择网页、软件、Android、游戏、网络、安全、硬件、固件、开发板或主机研究场景；智能分析先创建授权范围和确定性计划。游戏复活使用 Game Revival Studio 或 `game profile|scan|spec|rebuild|status|download`，目录扫描必须位于 API 服务端 `RE_GAME_ROOTS` 允许范围内。
4. 创建真实任务并轮询终端状态；不得伪造进度。
5. 读取证据、`UNKNOWN` 与报告，区分 `EVIDENCE` / `INFERENCE` / `VERIFIED`。
6. 导出产物并核对 SHA-256。

开发板不是新 adapter：串口/设备只读列表来自硬件 API，固件使用 `firmware` 任务。Ghidra/JADX 已通过官方工具已知答案 CI；使用范围限于已验证样本与格式，不替代物理设备或未授权目标验收。

## 安全

- 不绕过登录、验证码、付费、DRM、反作弊或访问控制。
- 不执行未知上传，不进行未授权漏洞利用或扫描。
- 不打开 USB/串口、不改变 DTR/RTS、不捕获键盘、不安装驱动、不刷写固件。
- HTTP MCP 使用 base64；stdio 本地路径限制在 `RE_MCP_ALLOWED_ROOTS`。
- 模型文本永远不是事实证据，也不能授予权限。
- 游戏产物是独立兼容实现，不是原始服务端，不保证商业原客户端兼容。
- `scan_game_directory` 仅扫描 API 服务端 `RE_GAME_ROOTS` 显式允许的目录；未配置返回 403，HTTP MCP 不能绕过。
- 游戏复活 L0-L7 由真实报告推进；当前最高实测 L6，Docker/L7 待 CI。
