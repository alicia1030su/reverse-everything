# v0.0.4 硬件验收

状态：实现前。

## 验收层

1. 模拟：枚举、热插拔、断开、权限拒绝、超时、畸形描述符、数据截断、预算。
2. 真实公开样本：Wireshark 官方 USB/HID PCAP/PCAPNG，记录 URL、许可证、SHA-256、预期结构。
3. 真实物理设备：仅用户明确指定的设备；当前未授权，不访问全部连接设备。

## 已取得公开样本

| 样本 | 来源 | SHA-256 |
|---|---|---|
| usb-hid.pcapng | wireshark/wireshark master test/captures | `893f285dce30121687f164c57572dc873595a7bc289dde3596b7bb0ec160bc34` |
| usb_coverage.pcapng | 官方 gzip 解压 | `98b5742ef016ea9fb1c2b1035e44f4552262ce69a86255b20f31eeb44d884b3e` |
| usb_hid_coverage.pcapng | 官方 gzip 解压 | `24d751a1625f7ea5a9f9390987f7bce28667c8b87be4251bc0f214b4657372a3` |

样本只在测试/CI 临时目录下载验证；仓库不默认再分发 GPL 样本。Wireshark 源码许可证为 GPL-2.0-or-later，测试运行不代表本项目改为 GPL。

## 设备能力声明

- H0 设备身份识别：支持 Windows PnP/CIM 与 Linux sysfs 只读枚举；VID/PID、拓扑与实例哈希可用于身份关联，序列号不读取，设备自由文本仅返回单向哈希。
- H1 标准描述符：Linux sysfs 与离线记录；Windows 仅暴露 OS 可读字段。
- H2 授权通信记录：离线 PCAP/PCAPNG/usbmon。
- H3 可验证协议理解：必须关联原始位置，未知字段保持 UNKNOWN。
- H4/H5：需独立真实设备证据，当前不宣称。
