# Windows 桌面版

1. 下载 `Reverse-Everything-Setup-0.0.2-win-x64.exe`。
2. 运行安装程序，选择安装目录并完成安装。
3. 从开始菜单或桌面快捷方式启动“Reverse Everything”。
4. 桌面壳自动启动本地 API/Worker 并打开现有 Web 控制台。
5. 数据位于 `%APPDATA%\reverse-everything`，更新安装器不会覆盖该目录。

安装包未代码签名，Windows SmartScreen 可能提示未知发布者。请核对 Release 页面和 `SHA256SUMS.txt`，不要关闭系统安全功能。

便携版：解压 `Reverse-Everything-Portable-0.0.2-win-x64.zip` 后运行其中的 EXE。功能与安装版一致，但不创建开始菜单快捷方式。

网页分析需要 Chromium。桌面“系统状态”页面会显示可用性；缺失时可主动安装。基础离线文件/静态分析不依赖浏览器。
