# 下一步

## 发布前

1. 运行 `npm run build && npm run typecheck && npm run lint && npm test && npm run test:e2e`。
2. 运行 `npm run check:secrets` 与生产依赖许可证检查。
3. 审查 `npm audit --omit=dev` 高危结果；修复或明确阻塞。
4. 记录空闲/峰值内存、启动耗时、网页与游戏任务耗时。
5. 初始化 Git，设置本地身份，创建 `alicia1030su/reverse-everything` Public 仓库。
6. 推送 main，确认 Windows/Ubuntu/Docker CI 全绿。
7. 创建不可覆盖的 `v0.0.1` Tag，由 release workflow 发布正式 Release。
8. 核对源码归档、SHA256SUMS、Release 下载地址与 main SHA。

## 发布后

- 上线后 48 小时核对 Actions、下载与健康检查。
- 上线后一周回看 issue、用户反馈和性能数据。
- v0.0.2 优先跨任务缓存、保留策略、资源指标与内存熔断。
- v0.0.3 再扩展多页面网页重建，不提前宣称支持。
