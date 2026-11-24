# v0.0.2 发布检查清单

状态：未开始。所有项必须有真实证据，未验证项阻断正式发布。

## 开发与合并

- [ ] Phase 0–11 完成并更新进度
- [ ] TypeScript、Lint、单元、集成、E2E 通过
- [ ] 六入口一致性报告通过
- [ ] v0.0.1 迁移、缓存、熔断测试通过
- [ ] PR 目标 main、来源分支正确、必需检查通过
- [ ] 按保护规则正常合并，无 force push、无管理员绕过
- [ ] 记录合并后 main SHA

## 产物

- [ ] Reverse-Everything-Setup-0.0.2-win-x64.exe
- [ ] Reverse-Everything-Portable-0.0.2-win-x64.zip（若实际产出）
- [ ] reverse-everything-cli-0.0.2.tgz
- [ ] reverse-everything-server-0.0.2.tar.gz
- [ ] reverse-everything-skill-0.0.2.zip
- [ ] openapi-v0.0.2.json
- [ ] SBOM-v0.0.2.json
- [ ] SHA256SUMS.txt
- [ ] 每项版本、平台、构建环境、安装/启动测试记录

## 门禁

- [ ] Windows EXE 安装与启动冒烟
- [ ] TGZ 干净环境安装/启动
- [ ] MCP stdio + Streamable HTTP 真实客户端
- [ ] Skill 规范校验与安全演示
- [ ] Docker Compose 验收
- [ ] 秘密扫描、audit、许可证检查
- [ ] 最终产物 SHA-256 下载复核

## 发布

- [ ] 确认 v0.0.2 Tag 不存在
- [ ] 创建不可移动 Tag
- [ ] Release `draft=false`、`prerelease=false`、最新版
- [ ] 下载地址、Release 页面、哈希复核
- [ ] 更新最终发布记录
