# Legacy Software Revival Studio

v0.0.7 新增的老软件入口，目标是把**合法保留的老软件与安装目录**转化为可追溯的只读档案、兼容性线索、数据恢复结果和独立功能重建。它不执行原程序，不恢复商业授权，也不复制未授权源码、资源或品牌标识。

## 1. 支持范围

| 类别 | 当前识别内容 |
|---|---|
| 可执行文件 | PE、ELF、Mach-O；PE 可读取有限架构信息 |
| 安装与打包 | MSI 文件头、JAR、Electron 线索、Python 脚本或打包线索、安装目录 |
| 数据文件 | SQLite、CSV、DBF、INI/CFG/CONF、JSON、XML |
| 元数据 | 文件名、相对路径、大小、SHA-256、有限 package.json 字段 |
| 诊断 | 运行时与依赖线索、兼容性建议、许可证记录状态 |

识别结果不是完整反编译报告。导入名称、字符串和文件名只能作为线索；不能证明实际运行时行为。格式无法确定时保持 `UNKNOWN`。

## 2. 只读分析流程

1. 创建 `software` 项目并确认授权。
2. 上传单个合法样本，或由 API 服务端读取显式允许的绝对路径。
3. 创建 `legacy` 任务，查看格式、架构、运行时、依赖、数据格式与限制。
4. 按需在同一任务的 `options` 中请求数据恢复或独立重建。
5. 读取 `legacy-profile.json`、恢复 manifest 或重建报告，并核对 SHA-256。

Web 的 Legacy Studio 提供同一流程的傻瓜入口与专业工作台。CLI、MCP 与 REST 最终共用后端任务契约。

## 3. 目录白名单

未上传文件而使用本机路径时，必须在 **API 服务端**配置 `RE_LEGACY_ROOTS`：

```bash
# Windows
set RE_LEGACY_ROOTS=C:\authorized\legacy;D:\retained\software

# Linux / Docker（容器内路径）
export RE_LEGACY_ROOTS=/authorized/legacy:/retained/software
```

仅允许白名单目录本身及其子目录。路径必须是绝对路径；未配置、越界、符号链接、junction 或特殊文件会被拒绝。HTTP MCP 不能绕过该限制。上传文件走普通上传契约，不需要 `RE_LEGACY_ROOTS`。

## 4. CLI

```bash
reverse-everything projects create "授权老软件样本" software --authorized
reverse-everything projects upload <projectId> ./retained-tool.exe
reverse-everything tasks create <projectId> legacy
reverse-everything tasks get <taskId>
reverse-everything report export <taskId> ./legacy-report.md
```

`tasks create` 的 adapter 已支持 `legacy`。当前 CLI 子命令只创建基础分析任务；数据恢复与独立重建选项通过 MCP `create_task` 或 REST 任务接口传入。

MCP 示例：

```json
{
  "projectId": "<projectId>",
  "adapter": "legacy",
  "options": {
    "path": "/absolute/authorized/legacy-tool"
  }
}
```

REST 示例：

```http
POST /api/v1/projects/<projectId>/tasks
Authorization: Bearer <local-token>
Content-Type: application/json

{"adapter":"legacy","options":{"path":"/absolute/authorized/legacy-tool"}}
```

## 5. 安全与资源上限

- 只读打开来源；分析期间文件大小或时间戳变化会失败，不静默使用混合结果。
- 不启动原程序，不自动安装 Wine、DOSBox、虚拟机、DLL 或运行时。
- 目录扫描默认最多 2,000 个文件、总大小 64 MiB、深度 8；单文件哈希默认最多读取 2 MiB。
- 超限文件会被跳过并记录限制；未读取内容不能被描述为已识别。
- 默认不调用远程 AI，不访问网络，不下载外部工具。

## 6. 相关文档

- [软件独立重建](SOFTWARE-RECONSTRUCTION.md)
- [数据恢复](DATA-RECOVERY.md)
- [本地隐私边界](LOCAL-PRIVACY.md)
- [兼容性与许可证诊断](LICENSE-DIAGNOSTICS.md)
