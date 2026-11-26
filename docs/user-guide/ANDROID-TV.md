# Android TV 研究指南

逆向万物支持 Android TV 和 Android 电视盒子的设备档案、合法 ADB 连接指引、自有应用分析、日志诊断、系统配置分析和公开固件研究。

## 授权前提

- 设备必须由用户所有或明确授权。
- USB 调试需要用户在官方系统设置中显式启用并授权。
- 遇到未授权设备时停止操作，不自动绕过设备认证、锁屏、启动保护或厂商访问控制。

## 可以做什么

- 记录设备型号、系统版本和 OEM 信息。
- 提供官方开发者选项与 ADB 授权指引。
- 在已合法启用的 ADB 连接中读取型号、系统版本和自有应用信息。
- 分析自有 APK、日志诊断、系统配置和公开固件。
- 生成应用兼容性研究报告。

## 不能做什么

- 不自动解锁 Bootloader 或绕过厂商限制。
- 不自动 root、提权或关闭安全启动。
- 不刷写未知固件。
- 不在未授权连接上执行命令。

## 官方资料

- [Create and run a TV app](https://developer.android.com/training/tv/start/start)
- [Android TV receiver debugging](https://developers.google.com/cast/docs/android_tv_receiver/debugging)
- [Android Debug Bridge](https://developer.android.com/tools/adb)

## 建议流程

1. 建立 C0 档案并保存 OEM/Android 官方资料。
2. 记录设备身份与官方资料，达到 C1（不表示设备已验证）。
3. 在合法授权下确认 ADB 接口，达到 C2。
4. 分析自有 APK 或公开固件，达到 C3。
5. 在授权开发环境完成应用测试，达到 C4。
6. 仅在自有实验设备完成独立兼容实现后，才可达到 C5。

真实设备未提供时，相关能力保持 `BLOCKED` / `UNKNOWN`。
