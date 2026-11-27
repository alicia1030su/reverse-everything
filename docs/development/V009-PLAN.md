# v0.0.9 核心逆向引擎计划

> 起始基线：v0.0.8 正式版，Commit `ce8bf95137459d97a3b98c64866170fe3e587e47`。
> 本文件记录执行 Wave 与硬门禁，不以测试数量替代程序理解能力。

## 终极目标

输入一个自有、开源或明确授权的二进制，在隔离环境中形成可查询的程序模型，提出并验证行为假设，生成可独立构建和测试的实现，并交付可复核证据。

## 实施 Wave

### Wave 0：能力审计与基线

- 逐项核对 Ghidra、JADX、固件、Game Revival、Legacy Studio、Autopilot、Provider、重建与知识库。
- 标注真实分析、工具封装、元数据提取、固定模板、无真实模型、不可独立运行。
- 输出带文件与行号的修复清单；发现的问题进入实现，不停留在报告。

### Wave 1：Program IR 与静态语义索引

- 新增独立 `@reverse/program-ir` 包，保持旧 Ghidra 元数据兼容。
- 统一 Program、Module、Function、BasicBlock、Instruction、Variable、CallSite、DataItem、Xref、Evidence 与 SemanticHypothesis。
- 扩展 Ghidra 导出：函数签名、参数/局部变量、调用约定、CFG、交叉引用与有界 P-Code。
- 提供函数上下文、调用路径、CFG 可达性/环路、字符串引用、变量与证据查询。
- 所有规则语义标记为 INFERENCE；工具观察标记为 EVIDENCE；未验证标记为 UNKNOWN/VERIFIED。

### Wave 2：动态与符号执行

- 仅在授权、隔离样本上评估 GDB/LLDB/WinDbg/QEMU 与 angr/Z3。
- 记录时间线、寄存器、内存、线程、模块与文件/网络观察，并关联静态函数。
- 每个 Adapter 必须产生真实执行或求解证据；仅安装依赖不计能力。

### Wave 3：语义智能体与独立重建

- 将 Program IR 查询作为 Autopilot 工具，模型依据证据选择下一步实验。
- 实现假设管理、失败记录、重规划、函数级检索与检查点恢复。
- 生成独立工程，执行真实 build/test；固定模板只能作为工程外壳，核心逻辑必须来自证据。

### Wave 4：Binary Diff 与盲测

- 比较自有程序不同编译版本的函数匹配、增删改、CFG/数据/接口变化。
- 建立不向智能体暴露源码的盲测样本与独立答案。
- 至少三个未参与生成器开发的真实案例通过未公开功能测试。

### Wave 5：性能、全入口与正式发行

- 按需启动重型分析器，限制 JVM/符号执行预算，函数级缓存与分块读取。
- 同步 Web/API/CLI/MCP/Skill/Desktop，保留现有发行体系。
- 真实核心能力验收通过后，按 Tag = Build = Acceptance Commit 的原子流程发布。

## 硬门禁

1. 至少一个真实模型完整参与分析、计划、工具选择、假设、重建、修复与交付，并保存可复核调用记录。
2. 至少三个独立未知样本通过未公开功能测试。
3. 函数语义准确率、算法重建、独立构建、行为等价、时间与峰值内存均有实测数据。
4. 真实动态、符号执行、Binary Diff 与游戏原客户端兼容逐项按证据披露。
5. P0/P1 清零、资产与公开复验通过；任一项缺失不得发布 v0.0.9。

## Wave 1 当前状态（2026-11-27，已合并）

- PR #25 已合并，合并提交 `8e65bdd494212d40edb621dc0b171e81cf9e1aaf`。
- 已新增 `@reverse/program-ir` 与 `@reverse/program-semantics`，支持函数/变量/CFG/指令/P-Code/调用/数据/交叉引用查询。
- Ghidra headless 已扩展真实结构化导出，并生成带二进制哈希、分析器与提交来源的 Program IR。
- Autopilot APK 主链已启用 JADX；Provider 密钥状态与真实响应证据已修复。
- 已实现 `scripts/check-v009-core-gate.mjs`，真实模型、盲测或核心能力证据缺失时强制阻断发布。
- 最终 CI：Ubuntu 932 passed / 7 skipped，Windows 931 passed / 8 skipped；真实 Ghidra 12.2 Ubuntu PE/ELF 与 Windows PE、真实 JADX 全部通过。
- 独立 Server 包干净安装与健康检查通过；两轮独立复审 P0=0/P1=0。
- Wave 2 已实现：GDB/MI 动态执行时间线、线程/模块/寄存器/调用栈证据、Program IR 关联，以及 angr/Z3 路径探索、约束求解、测试输入生成与原生执行复现。
- Wave 2 本地全量 Vitest 956 passed / 9 skipped；动态/符号/打包拓扑 31/31；真实 GDB 与 angr/Z3 由 Ubuntu CI 验证。真实模型、Binary Diff 与三个盲测仍未验收。

## Wave 2 当前状态（2026-11-28，已合并）

- PR #26 已合并，合并提交 `1d0ee1539ea9149b0d07eaab9e08a34589c95a4d`。
- GDB/MI 动态引擎支持真实断点、线程、寄存器、调用栈、模块与时间线证据，并关联 Program IR；共享 MI/inferior 输出通道明确按 best-effort 分流。
- angr/Z3 符号执行支持路径探索、约束求解、测试输入生成、原生执行复现及 partial 原因/截断契约；真实样本求解输入 `3713000000000000` 并复现目标路径。
- Linux 进程清理使用 `/proc` 三态观测、PID+startTicks 身份、pidfd 单飞回收与 PGID 复用防护；观测失败、迟到 MI 事件和不完整快照均 fail-closed。
- Desktop/Server 运行时均包含 `pidfd_cleanup.py` 与符号执行 worker，打包路径有回归测试。
- 最终 CI：Ubuntu 993 passed / 7 skipped，Windows 983 passed / 17 skipped；真实 GDB Run `46074956253`、真实 angr/Z3 Run `46074956247`、全量 CI Run `46074956310` 全部通过。
- 独立最终复审 P0=0/P1=0。真实模型八阶段、Binary Diff 与三个源码隔离盲测仍未验收。

## 当前外部阻塞

- 本机未发现 `OPENAI_API_KEY`、`ANTHROPIC_API_KEY` 或 Ollama；真实模型验收保持 BLOCKED，直到配置真实提供方或本地模型。
- 本机未发现 Ghidra/JDK/GDB/objdump；真实 Ghidra 导出通过既有 CI 门禁验证，本地先使用标准夹具验证 IR 与查询。
