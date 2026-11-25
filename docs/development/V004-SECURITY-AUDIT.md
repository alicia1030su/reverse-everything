# v0.0.4 安全审计

状态：Phase 0 威胁面登记，修复与独立复审待执行。

## 信任边界

- 上传文件、固件、USB 记录、HID 描述符、网页内容、模型输出均为不可信输入。
- 设备所有权不等于在线服务、第三方账户或平台安全机制的完整授权。
- 网络 MCP/API 不得访问宿主 USB；实时设备能力仅本地显式选择。
- 工件暂存、对象库、SQLite、证据和私有快照之间必须保持身份/摘要/fencing 一致。
- 发布 Token、下载重定向 URL、模型 Key 不进入日志或子进程环境。

## 必须验证的攻击面

- ZIP/压缩嵌套炸弹、路径穿越、symlink/Junction/Reparse、硬链接、文件替换。
- PCAP/PCAPNG/usbmon 长度、计数、接口、endpoint、ISO 描述符边界。
- HID report descriptor item 长度、usage stack、逻辑范围。
- HEX/UF2/ELF/分区/文件系统恶意长度、地址溢出、超大输出。
- SQLite 事务重入、锁等待、旧 worker 覆盖、GC 删除提交/下载对象。
- AI prompt injection、工具越权、预算绕过、虚假“已测试”结论。
- 多 API 实例、远程 MCP、SSRF/DNS 固定、Host/Origin/token。
- Draft Release 上传不完整、Tag/Commit 漂移、资产 digest 不一致。

## 当前结论

Phase 0 未发现新的可复现 P0；已确认 P1 见 DEFECT-REGISTER。硬件实现前不宣称安全验收完成。
