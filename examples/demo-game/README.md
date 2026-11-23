# 星港远征：自编写复活演示

本目录包含一个完全由本项目编写的迷你 HTML5 游戏、旧版客户端、原始演示服务端和真实录制脚本。所有代码与固定测试数据均归本项目所有。

## 录制真实协议样本

```bash
node examples/demo-game/capture.mjs
```

脚本启动原始服务端，执行 hello → login → move → logout，记录实际 WebSocket 消息到 `captured-trace.json`，然后停止原始服务端。

## 验证独立兼容服务

把 `captured-trace.json` 上传到“逆向网页 / 软件 / 游戏复活”入口中的“复活游戏”。平台会：

1. 从消息推断字段与状态转换；
2. 仅根据已观察请求/响应模板生成独立兼容服务；
3. 启动生成服务并用保留客户端流程执行 login、move、logout；
4. 输出 `validation.json` 与 L3 验收证据。

生成服务不是原始代码恢复，也不包含未观察玩法、反作弊或账号系统。
