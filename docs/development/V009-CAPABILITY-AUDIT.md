# v0.0.9 核心逆向能力审计

> 审计基线：v0.0.8 正式版 `ce8bf95137459d97a3b98c64866170fe3e587e47`。
> 结论用于直接修复，不以测试数量或工具调用次数代替程序理解能力。

## 能力分类

| 模块 | 当前真实能力 | 不能宣称的能力 | 直接修复 |
|---|---|---|---|
| Ghidra | 真实 headless 导入、函数清单、有界反编译、直接调用边、字符串引用 | CFG、变量、P-Code、跨函数语义、行为验证 | 扩展结构化导出并生成 Program IR；新增函数级查询与真实 CI 验收 |
| JADX/APK | 真实 DEX 清单、Manifest/AXML、可选固定版本 JADX 反编译与资源解码 | 原始源码恢复、语义调用图、可独立重建 | 修复 Autopilot APK 主链未传 `apkDecompile=true`；后续增加 Java IR/调用图 |
| 固件 | 真实 ELF/HEX/UF2/归档解析、熵、布局与流式边界 | 固件功能语义、硬件行为等价 | 复用 Program IR 分析 ELF；保留未验证项 |
| Game Revival | 行为 IR、独立兼容服务端、原客户端兼容证据 | 从任意未知游戏自动恢复完整服务端 | 继续仅以授权样本与原客户端证据验收 |
| Legacy Studio | 真实档案/文件/归档/编码识别、数据恢复候选与独立重建 | 任意旧软件完整功能恢复 | 将恢复候选接入行为测试，未通过不得标 VERIFIED |
| Autopilot | 持久化规则编排、真实子任务、工具调用、检查点、重规划、交付规则验收 | 真实模型自主选择分析步骤、假设驱动研究 | 接入 Program IR 查询与语义模型；建立真实模型硬门禁 |
| Provider V4 | OpenAI 兼容/Ollama/custom HTTP 调用、角色、预算、结构化输出 | 已验收的真实模型逆向主链 | 增加请求/响应/usage/结束原因证据；无 Key 保持 BLOCKED |
| 程序重建 | 静态站点、游戏/特定 Legacy 场景可生成独立工件 | 通用算法/文件格式/模块的证据驱动独立重建 | 以 Program IR 和行为等价测试驱动生成器，禁止固定模板冒充 |
| 证据知识库 | 证据分类、检索与任务关联 | 自动证明模型结论为事实 | 所有模型输出保持 INFERENCE，行为测试后才可 VERIFIED |

## 已确认缺陷与修复状态

1. **APK 主链未启用 JADX**：`planner.ts` 生成 `analyzer:apk`，但 `engine.ts` 创建子任务时未传 `apkDecompile`，`apk.ts` 因此跳过反编译。已补 `apkDecompile=true` 与真实主链回归。
2. **Ghidra 输出是扁平元数据**：缺少可查询 CFG、变量、P-Code 与函数语义。Wave 1 正在扩展真实导出并转换为 Program IR。
3. **真实模型不是 v0.0.8 发布硬门禁**：候选允许 `BLOCKED / MISSING_API_KEY`。v0.0.9 必须改为阻断发布。
4. **真实模型验收任务过弱**：仅生成小型 TypeScript 计划，不能证明参与逆向。v0.0.9 必须覆盖程序分析、函数理解、计划、工具选择、假设、重建、修复与交付。
5. **Provider 密钥状态误导**：`hasApiKey` 仅根据 `apiKeyRef` 是否存在返回 true，未检查秘密是否真实存在。需修复并回归。
6. **Autopilot 未调用模型**：`ModelProviderService` 已存在，但引擎没有注入或调用，`modelCalls` 没有真实来源。不得把规则编排称为 AI 自主逆向。

## 验证边界

- 本机未发现 GCC/Clang/Rust/Go/JDK/Ghidra/GDB/objdump/Ollama，也未发现远程模型 Key。
- 本地可验证 Type IR、转换、查询、证据约束与主链选项；真实 Ghidra 导出由既有官方工具 CI 验证。
- 动态调试、符号执行、Binary Diff、真实模型与三个未知样本盲测在获得工具/凭证前保持未验收。
