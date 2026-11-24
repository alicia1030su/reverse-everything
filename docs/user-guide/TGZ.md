# TGZ 安装

## CLI

```bash
npm install -g ./reverse-everything-cli-0.0.2.tgz
reverse-everything --version
reverse-everything health
```

CLI 包包含 dist 和公开依赖，不依赖 monorepo 私有 workspace。需要 Node.js 22.13+。

## 服务端

```bash
tar -xzf reverse-everything-server-0.0.2.tar.gz
cd server
npm ci --omit=dev
npm start
```

服务端包需要 Node.js 22.13+，不是自带运行时便携包。网页分析另需 `npx playwright install chromium`。默认仅监听 127.0.0.1:4173。
