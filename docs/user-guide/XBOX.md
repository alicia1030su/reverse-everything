# Xbox 主机研究指南

逆向万物支持建立 Xbox Series X、Series S 和 Xbox One 研究档案，整理官方 Developer Mode / GDK 指引、自有 UWP 应用样本、运行日志和兼容性证据。

## Developer Mode 与 Retail Mode

- **Developer Mode** 是平台提供的受限开发环境，不等于获得零售系统全部权限。
- **Retail Mode** 是普通零售模式，不能从 USB 接口推定存在调试权限。
- 具体能力取决于获批计划、许可证、开发硬件和系统版本。

## 可以做什么

- 记录主机型号、系统版本和合法开发环境。
- 关联 Microsoft GDK / Xbox Extensions 官方文档。
- 分析自有 UWP 应用包和合法诊断日志。
- 归档应用测试结果与兼容性证据。
- 生成 C0-C5 主机研究报告。

## 不能做什么

- 不绕过认证、许可、安全启动或平台保护。
- 不把零售 USB 接口当作开发接口。
- 不提供未公开接口的自动利用或任意代码执行。
- 不在未授权设备上执行操作。

## 官方资料

- [Microsoft Game Development Kit](https://learn.microsoft.com/en-us/gaming/gdk/)
- [Xbox One and Series X|S GDK tools](https://devdocs.xbox.com/tools/tools-console/tools-sdk)

## 建议流程

1. 建立档案并保存官方资料。
2. 确认合法 Developer Mode 或获批开发环境。
3. 分析自有 UWP 应用和诊断日志。
4. 在授权环境完成应用测试并保存证据。
5. 仅在自有实验设备完成独立兼容实现后，才可达到 C5。

未提供真实 Xbox 或开发环境时，相关能力保持 `BLOCKED` / `UNKNOWN`。
