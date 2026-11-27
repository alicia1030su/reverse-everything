# 工件交付与独立验收

## 交付包结构

成功完成所有步骤后，Autopilot 在 `data/autopilot/<taskId>/artifacts` 生成交付包：

```text
START-HERE.md
使用教程.md
reports/ACCEPTANCE.json
ARTIFACT-MANIFEST.json
SHA256SUMS.txt
artifacts/
  ...真实分析与生成工件...
```

API 将包内文件登记到 `autopilot_artifacts`，交付中心只展示和下载已登记文件。

## 验收状态

| 状态 | 含义 |
|---|---|
| `DELIVERABLE_VERIFIED` | 有真实工件且全部独立规则检查通过 |
| `DELIVERABLE_PARTIAL` | 有工件，但存在未完成项或未通过检查 |
| `BUILD_FAILED` | 记录中存在失败构建检查 |
| `TEST_FAILED` | 记录中存在失败测试检查 |
| `COMPATIBILITY_UNVERIFIED` | 兼容性尚未验证 |
| `BLOCKED` | 被权限、工具或前置条件阻塞 |
| `REPORT_ONLY` | 没有可执行工件，仅报告 |

任务状态 `COMPLETED` 对应规则验收 `DELIVERABLE_VERIFIED`；`PARTIAL_SUCCESS` 保留部分交付。两者都不是商业客户端、物理设备或所有平台兼容的证明。

## 独立规则检查

交付器会：

1. 拒绝符号链接和非普通文件。
2. 复制前逐文件计算 SHA-256，并核对声明的大小与哈希。
3. 生成真实工件清单和教程。
4. 汇总真实工具检查。
5. 以 `independent-rules` 为 reviewer 生成验收报告。
6. 为清单、教程、验收报告和工件生成 `SHA256SUMS.txt`。

模型不能自称验收成功。

## 下载与校验

Web：打开 `/delivery/:id`，查看“独立验收”，逐个下载或点击“全部下载”。浏览器可能拦截多文件下载，此时请允许或逐个下载。

CLI：

```bash
reverse-everything autopilot artifacts <taskId>
reverse-everything autopilot download <taskId> 'ARTIFACT-MANIFEST.json' ./ARTIFACT-MANIFEST.json
reverse-everything autopilot download <taskId> 'SHA256SUMS.txt' ./SHA256SUMS.txt
```

下载响应包含 `x-artifact-sha256`。完整包解压后可运行：

```bash
sha256sum -c SHA256SUMS.txt
```

Windows PowerShell 可按 `ARTIFACT-MANIFEST.json` 中的字段使用 `Get-FileHash` 逐个核对。

## 使用产物

- 静态网站：按教程打开 `artifacts` 中的 `index.html`，或将产物目录托管到静态服务器。
- 分析报告：先读 `START-HERE.md` 与验收限制，再引用具体证据。
- 工程候选：只有真实构建/测试通过才能部署；构建计划不是可运行成品。
- 数据恢复：核对来源、导出格式、行数/记录数和哈希；不要覆盖原始材料。

## 安全边界

- API 下载前再次验证大小与 SHA-256；文件被篡改时返回不可用，而不是继续发送。
- 下载内容仍应视为不可信输入，不要随意执行。
- 交付包不能包含用户未授权的原始材料、密钥或凭证。
- 工件名经过规范化与 Windows 保留名处理；路径不能逃逸受管工件根目录。

## 当前限制

- Web“全部下载”是逐文件下载，不是单一 ZIP 包。
- MCP HTTP 下载大于 5 MiB 时返回限制错误，应改用 CLI。
- 教程来自真实任务上下文与默认交付模板，不保证覆盖所有专业部署场景。
- 独立规则验收证明包内一致性，不代替人工复审、渗透测试或外部兼容测试。
