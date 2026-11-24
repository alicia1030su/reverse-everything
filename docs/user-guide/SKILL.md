# Agent Skill

解压 `reverse-everything-skill-0.0.2.zip`，将 `reverse-everything` 目录放入客户端技能目录。

```bash
node reverse-everything/scripts/check-environment.mjs
node reverse-everything/scripts/inspect-task.mjs <task-id>
```

技能优先使用已配置 MCP，否则使用 CLI/API。必须先确认授权，再选择分析入口。更新时替换整个技能目录；卸载时删除该目录。技能不保存密钥，不自动忽略授权。
