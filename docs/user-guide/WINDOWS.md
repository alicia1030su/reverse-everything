# Windows 桌面版（v0.0.4）

v0.0.4 仍在开发分支；以下为候选安装包命名与使用说明，不表示正式 Release 已发布。

1. 获取 `Reverse-Everything-Setup-0.0.4-win-x64.exe`，核对发行清单中的 SHA-256。
2. 运行安装程序，选择安装目录并完成安装。
3. 从开始菜单或桌面快捷方式启动“Reverse Everything”。
4. 桌面壳自动启动本地 API/Worker 并打开 Web 控制台。
5. 数据默认位于 `%APPDATA%\reverse-everything`；更新安装器不应覆盖该目录。

便携版为 `Reverse-Everything-Portable-0.0.4-win-x64.zip`，解压后运行 EXE，不创建开始菜单快捷方式。安装包未代码签名时，Windows SmartScreen 可能提示未知发布者；请核对来源与哈希，不要关闭系统安全功能。

## 硬件与串口

- 硬件实验室通过系统 CIM/PnP 只读枚举 USB 身份与串口，不打开设备。
- 串口不打开、不改变 DTR/RTS；实时捕获、键盘采集与驱动安装保持禁用。
- 开发板分析只使用用户提供的离线记录/固件；不自动复位或刷写。
- 权限不足或平台字段缺失时显示真实限制，不生成演示设备。

## 文件与单实例

- 工件下载使用私有临时快照；Windows 通过 `icacls` 将权限限制为当前用户并移除继承。
- 拒绝 symlink/Junction/reparse point 路径；文件身份、大小与 SHA-256 在读取前后核验。
- API 使用 SQLite runtime lease 防止同一数据目录多实例；Electron 使用单实例锁，第二次启动聚焦已有窗口。

## 资源指标

桌面指标来自 Electron `app.getAppMetrics()` 与真实 API/Worker sidecar 快照，包含 main/renderer/GPU/utility/sidecar 角色、RSS、CPU、峰值、磁盘与压力。采样失败、陈旧或截断会记录在 `limitations`；缺失值不伪造。

网页分析需要 Chromium。桌面“系统状态”会显示真实可用性；缺失时可主动安装。基础离线文件、硬件与固件静态分析不依赖浏览器。
