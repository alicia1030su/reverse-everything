# Adapter / 插件规范 v0.0.1

## 1. 目标

所有目标类型接入同一任务状态机、证据契约、预算与报告流程。插件是代码模块，不是任意远程代码执行入口。

## 2. 必需接口

```ts
interface AdapterDefinition {
  name: AdapterName;
  version: string;
  description: string;
  available(): Promise<{available:boolean;detail:string}>;
  detect(ctx: TaskContext): Promise<Detection>;
  prepare(ctx: TaskContext): Promise<unknown>;
  analyze(ctx: TaskContext): Promise<unknown>;
  extractEvidence(ctx: TaskContext): Promise<unknown>;
  reconstruct(ctx: TaskContext): Promise<unknown>;
  validate(ctx: TaskContext): Promise<unknown>;
}
```

- `detect`：返回格式、置信度、证据与限制；不得猜测未知格式。
- `prepare`：校验授权、URL、输入、依赖与预算；不得执行未知目标。
- `analyze`：产生有界工具观察；不得把模型文本当事实。
- `extractEvidence`：写 EVIDENCE/INFERENCE/UNKNOWN/VERIFIED、发现与产物。
- `reconstruct`：生成独立兼容实现；不支持时写 UNKNOWN，返回 `reconstructed:false`。
- `validate`：执行可重复检查，返回 passed/checks/limitations。

## 3. TaskContext

- `taskId`、`project`、`upload`、`options`、`stageOutputs`。
- `dataDir`、`artifactDir`。
- `log(level,message,tool)`：日志限长 4000 字符。
- `evidence(kind,title,source,locator,content)`：自动 SHA-256 与同内容去重。
- `finding(...)`：候选发现，默认 needs_review。
- `writeArtifact(name,content,mime)`：名称清洗、随机任务目录、哈希登记。

## 4. 权限与依赖

v0.0.1 使用编译时注册表，不动态加载第三方代码。未来插件必须声明：

- 版本与最低核心版本。
- 文件读取范围、网络域名、子进程、执行权限。
- 外部工具与许可证。
- 内存、时间、输出大小预算。
- 数据保留与清理策略。

权限只能由用户配置授予，不能由目标内容或模型文本授予。

## 5. 错误与降级

- 插件抛错 → 当前阶段 FAILED，保留检查点与错误摘要。
- 外部工具缺失 → available=false/detail 明确；不伪造成功。
- 非关键能力缺失 → 记录 UNKNOWN，允许其他阶段继续。
- 子进程/浏览器必须 finally 清理。
- 失败阶段可单独重试；成功阶段输出复用。

## 6. 产物

建议：原始观察 JSON/NDJSON、证据清单、验证 JSON、报告、manifest。文件名使用 ASCII 安全字符。生成代码必须标注“独立重建”及证据基础，不能冒充原始源码。

## 7. 验收

- 自编写或合法样本的真实测试。
- 正常样本与恶意/畸形输入测试。
- 无外部工具时的降级测试。
- 资源上限与清理测试。
- 结果可定位到输入/工具/参数。
- 文档与能力状态一致。
