# 游戏兼容与 V5 行为 IR

v0.0.7 的游戏复活从“固定 FPS/RPG 模板”转向**显式行为 IR 驱动、反模板可验收**的独立实现。目标行为证据、生成服务实现能力和原客户端兼容必须分开报告。

## 1. V5 行为 IR

扫描目标目录时，若发现唯一 `behavior.json` 或 `gameplay.json`，分析器会按 `revival-behavior/v1` 解析并校验：

- 模式、人数、回合时长、移动速度、生命值与重生规则。
- 1-16 个动作：`attack`、`gather`、`heal`，以及冷却、伤害/范围或物品/数量。
- 胜负条件：`firstToScore`、`survive`、`collect` 与目标值。
- 地图尺寸与最多 256 个障碍物。

规格上限为 64 KiB。多个行为规格会被拒绝，避免猜测目标规则。行为文件的存在只证明规格被观察，不证明它来自真实原客户端，也不证明网络协议兼容。

生成器消费行为 IR，并记录：

- `provenance.targetSpecific`：目标行为、动作、胜负与地图等具体信息。
- `provenance.sharedTemplateComponents`：WebSocket、认证、房间、持久化、管理 API、Docker 等共享基础组件。
- `targetEvidence.behavior`：`UNKNOWN` / `OBSERVED` / `VERIFIED`。
- `targetEvidence.originalClient` 与 `targetEvidence.protocol`：默认 `UNKNOWN`，只有真实原客户端与协议验收才能提升。

## 2. 反模板样本

仓库保留两个独立样本用于证明同类型游戏可以产生不同实现：

| 样本 | 机制 | 动作 | 胜负 |
|---|---|---|---|
| `duel` | 对战、重生 | `fire` | 首先达到 3 分 |
| `survival` | 生存、不重生 | `gatherHerb`、`useHerb` | 收集 6 个物品 |

验收比较行为规格、生成配置/测试与真实联机结果，而不是只改名称或路径。内部验证客户端类型明确为 `internal-protocol-client`，不能称为原游戏客户端。

## 3. 实现等级与目标兼容等级

**实现等级 L0-L7** 描述生成服务的工程能力：

`L0 档案 → L1 扫描指纹 → L2 规格 → L3 构建 → L4 独立启动/管理认证 → L5 内部客户端同场/权威状态/房间隔离 → L6 持久化/重连/结算/并发 → L7 Docker 部署`。

**目标兼容等级**描述目标游戏证据：

- 行为：是否观察并验证目标机制。
- 原客户端：是否由真实原客户端连接并完成对局。
- 协议：是否验证目标协议，而不是项目自定义 WebSocket。

L7 只证明生成服务能部署，不证明商业游戏原客户端兼容。内部客户端同场、文件生成或 Docker 通过都不能替代原客户端验收。

## 4. 真实开源游戏原客户端验收

v0.0.7 保留两个许可证明确的原始浏览器客户端，并只依据客户端协议实现独立服务端；上游服务端源码未复制、未作为生成器输入。

| 游戏 | 上游与许可证 | 原始客户端验收 | 独立服务端能力 |
| --- | --- | --- | --- |
| Pixelknight | `imdvls/Pixelknight`，ISC，固定提交 `d6636aa9` | 两个原始页面连接、移动、刷新重连、服务端重启后恢复同一玩家位置 | WebSocket JSON、权威移动/重力/平台碰撞、金币状态、JSON 持久化、同源 Cookie 身份恢复 |
| Tron | `leodhin/trongame`，ISC，固定提交 `18ca8562` | 两个原始页面入房、准备、移动、刷新重连、真实对局结束 | Socket.IO `/game`、房间/玩家状态、准备开局、方向移动、轨迹碰撞、结算与持久化 |

证据文件位于 `artifacts/v007-game-compat/`，截图位于 `docs/assets/v007-pixelknight-compat.png` 与 `docs/assets/v007-tron-compat.png`。发行时额外提供 `reverse-everything-game-compat-demo-0.0.7.zip` 与 `demo-evidence.json`。

这证明两个真实开源客户端可以连接本项目独立实现的服务端，但不证明任意商业游戏协议兼容，也不证明 CODOL 2021 可运行。

## 5. 当前真实性边界

- 默认原客户端与目标协议均为 `UNKNOWN`；只有真实原客户端验收才能提升。
- 不保证任何真实商业游戏原客户端兼容。
- CODOL 2021 缺少最终客户端、协议记录与授权，保持 `EXTERNAL_BLOCKED`。
- v0.0.6 的 FPS/RPG Docker/L7 已在正式候选 CI 真实通过；该结论仅适用于生成服务，不能外推为目标游戏兼容。

## 5. 合法边界

不绕过 DRM、反作弊、登录、付费或访问控制；不读取未授权原始服务端作为生成器输入；不分发未授权客户端、资源、账号或抓取数据。详见 [免责声明](../DISCLAIMER.md)。
