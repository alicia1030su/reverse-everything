# 老软件数据恢复

数据恢复以**只读来源、独立导出、哈希校验**为边界。它解析可识别的结构化数据并导出 JSON/CSV，不修复来源文件，不覆盖原数据库，不保证损坏或加密数据可完整恢复。

## 1. 支持格式

| 格式 | 当前解析 | 主要限制 |
|---|---|---|
| CSV | 有界 UTF-8、引号、换行、重复列名检查 | 不猜测编码，不执行公式 |
| DBF | 文件头、字段描述符、记录与删除标记 | Latin-1 保守解码；不自动恢复备注文件和索引 |
| SQLite | 只读打开，枚举最多 100 张表并读取记录 | 最多 50,000 行；不恢复视图、触发器或权限 |
| INI/CFG/CONF | section 与 `key=value` | 不展开环境变量，不执行配置 |
| JSON | 保留结构并展平为记录预览 | 不执行脚本或公式 |
| XML | 有界元素名、属性字符串与文本 | 不解析 DTD 或外部实体 |

来源文件默认上限 128 MiB，记录数默认上限 50,000。格式不支持或结构损坏时返回真实错误，保持 `UNKNOWN`，不伪造恢复结果。

## 2. 请求恢复

MCP `create_task` 示例：

```json
{
  "projectId": "<projectId>",
  "adapter": "legacy",
  "options": {
    "path": "/absolute/authorized/old-data/records.dbf",
    "recover": true
  }
}
```

REST 对应 `POST /api/v1/projects/<projectId>/tasks`。本机路径必须位于 API 服务端 `RE_LEGACY_ROOTS` 白名单内；也可以先上传合法数据文件，再创建 `legacy` 任务。

## 3. 输出

默认写入 `data/tasks/<taskId>/recovered-data/`：

- `recovered.json`：完整有界记录。
- `recovered.csv`：按统一字段导出的 CSV。
- `manifest.json`：来源 SHA-256、格式、记录数、字段与限制。

任务同时生成 `recovery-manifest.json` 工件，并返回最多 20 条预览。导出目录必须不存在或为空；不会覆盖已有数据。

## 4. 完整性核验

恢复前后都会计算来源 SHA-256；若来源在读取期间变化，任务失败。`integrity.sourceUnchanged=true` 只证明来源未被本次恢复修改，`exportSha256` 用于核对导出文件，不代表内容语义正确。

## 5. 使用建议

- 优先在来源副本上操作，并保留原始介质。
- 导出后独立打开 JSON/CSV 复核字段、编码、空值与记录数。
- DBF 备注、索引、SQLite 视图/触发器/权限不在当前恢复范围。
- 加密、压缩或损坏数据保持 `UNKNOWN`，不要用猜测值填补。
