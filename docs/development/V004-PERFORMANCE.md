# v0.0.4 性能记录

## 基线

v0.0.3 历史报告（本轮待复测）：冷 P95 132.18ms，热 P95 173.35ms，热缓存命中率 100%，峰值 RSS 143.36MB。

## 本轮必须测量

- 1MB/10MB/100MB/500MB/1GB 条件允许的流式生成工件。
- SHA-256 耗时、SQLite 写锁时间、API P50/P95/P99、SSE 延迟、取消耗时、Worker 峰值 RSS、event-loop delay。
- 冷/热缓存：key、input hash、index query、payload hash/read、deserialize、artifact copy/publish、resource sample、SSE。
- 桌面 API/Worker/renderer/Electron 总进程树峰值。
- 固件分析峰值；USB 枚举/离线解析资源；退出后孤儿进程。

当前没有 v0.0.4 优化后数据，不声称性能提升。
