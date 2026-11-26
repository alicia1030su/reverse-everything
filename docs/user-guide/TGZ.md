# 安装包与候选产物（v0.0.5）

最终发行资产由 `Release v005` 工作流从冻结 Commit 构建，文件名如下。是否可交付以候选验收、provenance、SHA-256 与公开发布结果为准。

## CLI

```bash
npm install -g ./dist/release/reverse-everything-cli-0.0.5.tgz
reverse-everything --version
```

## Server

```bash
tar -xzf ./dist/release/reverse-everything-server-0.0.5.tar.gz
cd server
npm ci --omit=dev
npm start
```

## Skill

```bash
npm run package:skill
```

输出为 `dist/release/reverse-everything-skill-0.0.5.zip`。将包内 `reverse-everything` 目录整体放入客户端技能目录。

## Windows

- `Reverse-Everything-Setup-0.0.5-win-x64.exe`
- `Reverse-Everything-Portable-0.0.5-win-x64.zip`

详见 [Windows 指南](WINDOWS.md)。安装包未代码签名时，Windows SmartScreen 可能提示未知发布者；请核对来源与哈希，不要关闭系统安全功能。

## 校验

```bash
sha256sum -c SHA256SUMS.txt
```

同时核对 `RELEASE-MANIFEST.json`、`BUILD-INFO.json`、`ACCEPTANCE.json` 与 `SBOM-v0.0.5.json`。
