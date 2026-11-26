# 软件独立重建

独立重建只根据用户提供的功能需求与合法样本档案生成新项目。它不是原软件源码恢复、官方替代品或完整兼容承诺；不得复制未授权代码、资源、商标或品牌界面。

## 1. 可生成项目

| kind | 当前产物 | 边界 |
|---|---|---|
| `ini-editor` | 浏览器 INI 编辑器、`bin/ini-tool.mjs`、测试 | 仅处理 `key=value` 与 section；不展开环境变量 |
| `csv-viewer` | 浏览器 CSV 查看器、`bin/csv-tool.mjs`、测试 | 基础 CSV 展示；不执行公式，不代表完整 CSV 标准实现 |
| `text-tool` | 浏览器文本编辑区、`bin/text-tool.mjs`、静态服务 | 独立文本复制工具；不复用原程序代码 |
| `data-converter` | adapter 接受该规格类型，但当前生成通用文本工具 | 功能完整性为 `PARTIAL`，不得宣称通用数据转换器已完成 |

生成项目包含 `package.json`、`server.mjs`、`RECONSTRUCTION.json`、独立测试与运行说明。静态服务默认仅监听 `127.0.0.1`。

## 2. 请求重建

先完成 `legacy` 分析，再通过 MCP `create_task` 或 REST 在同一任务选项中提供 `reconstruction`：

```json
{
  "projectId": "<projectId>",
  "adapter": "legacy",
  "options": {
    "path": "/absolute/authorized/legacy-tool",
    "reconstruction": {
      "kind": "ini-editor",
      "name": "independent-ini-editor",
      "requirements": ["read INI sections", "export an independent copy"]
    }
  }
}
```

REST 对应 `POST /api/v1/projects/<projectId>/tasks`。名称和至少一条需求为必填；需求应描述功能，而不是要求绕过许可、认证或复制受保护资源。

## 3. 输出与验证

默认输出到 `data/tasks/<taskId>/reconstruction/`，并生成 `reconstruction.json` 工件。验证阶段会：

1. 执行生成项目的 `node --test`。
2. 在回环随机端口启动生成服务并请求首页。
3. 将真实检查结果写入任务报告。

生成文件存在不等于重建成功。只有测试和启动检查均通过，才能描述该独立项目在当前离线环境中可运行；这仍不代表原软件完整兼容。

## 4. 使用产物

```bash
cd data/tasks/<taskId>/reconstruction
npm test
npm start
```

打开 `http://127.0.0.1:4173`。CLI 工具位于 `bin/`。在隔离环境中审查生成代码后再执行，不要把未知生成物直接投入生产。

## 5. 明确不做

- 不恢复、提取或复用原软件专有源码。
- 不复刻未授权资源、品牌标识、字体、图标或界面素材。
- 不绕过许可证、激活、登录、DRM 或访问控制。
- 不自动安装外部运行时；Wine/DOSBox/虚拟机仅可作为用户自行核验的建议。
