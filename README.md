<p align="center">
  <img src="https://github.githubassets.com/images/modules/logos_page/GitHub-Mark.png" width="80" alt="ghcr" />
</p>

<h1 align="center">ghcrimg</h1>
<p align="center">
  <strong>ghcr.io 镜像拉取代理 —— 跑在 Cloudflare Workers 上</strong>
</p>

<p align="center">
  <a href="#协议"><img src="https://img.shields.io/badge/license-GPL--3.0--only-blue.svg" alt="License: GPL-3.0-only" /></a>
  <a href="https://workers.cloudflare.com"><img src="https://img.shields.io/badge/platform-Cloudflare%20Workers-f38020" alt="Cloudflare Workers" /></a>
</p>

---

## 这是什么？

**ghcrimg** 是一个单文件的 Cloudflare Worker，作为 **ghcr.io**（GitHub Container Registry）的 pull-through 代理。

部署后，你就能通过**你自己的域名** `docker pull` 任何 ghcr.io 上的公开镜像，客户端无需直连 ghcr.io。

## 为什么用？

- **绕过速率限制** — ghcr.io 对匿名拉取有次数限制。通过认证转发，你的代理就是唯一的认证客户端。
- **CORS 就绪** — 所有响应都带了 CORS 头，浏览器工具也能直接调。
- **Token realm 重写** — Docker 的认证质询会被透明改写，`docker login` 指向你的代理域名，而不是 ghcr.io。
- **零依赖** — 一个 JS 文件，没有框架，没有构建，没有 package.json。
- **免费跑** — Cloudflare Workers 免费额度完全够用。

---

## 快速开始

### 1. 部署

打开 [Cloudflare Workers 控制台](https://dash.cloudflare.com/)，创建一个新的 Worker，把 [worker.js](worker.js) 的内容复制进去，保存并部署。

Worker 会运行在：

```
https://<your-worker>.<subdomain>.workers.dev
```

建议绑定一个自定义域名（如 `registry.yourdomain.com`），在 Worker 的 **触发器** → **自定义域** 中添加即可。

### 2. 拉取

```bash
docker pull <你的域名>/owner/image:tag
```

就这样。不需要数据库，不需要环境变量，不需要配置文件。

---

## 使用

### 拉取公开镜像

```bash
docker pull <你的代理域名>/library/alpine:latest
docker pull <你的代理域名>/owner/image:tag
```

### 带认证拉取

如果是私有镜像，把 ghcr.io 的凭据通过代理传过去：

```bash
echo "$GITHUB_TOKEN" | docker login <你的代理域名> -u <用户名> --password-stdin
```

Worker 会把 `Authorization` 头原样转发给 ghcr.io。Token 认证域名会被自动重写，`docker login` 直接就能用。

### 接口

| 路径          | 说明                     |
|---------------|--------------------------|
| `/v2/`        | Docker Registry API 入口 |
| `/v2/*`       | Blob 和 Manifest 操作    |
| `/token`      | 认证 Token 交换（已重写）|
| `/debug`      | ghcr.io 连通性测试       |
| `/debug-proxy`| 代理端到端诊断           |

---

## 架构

```
Docker 客户端              你的 Worker                  ghcr.io
     │                         │                           │
     ├── GET /v2/ ────────────►│                           │
     │                         ├── GET /v2/ ──────────────►│
     │                         │◄── 401 + Www-Auth ───────┤
     │◄── 401 + Www-Auth ─────┤   (realm 已重写)          │
     │                         │                           │
     ├── GET /token ──────────►│                           │
     │                         ├── GET /token ────────────►│
     │                         │◄── Bearer token ──────────┤
     │◄── Bearer token ───────┤                           │
     │                         │                           │
     ├── GET /v2/.../manifests►│                           │
     │   (带 Bearer)           ├── GET /v2/.../manifests ──►│
     │                         │◄── 200 + Manifest ────────┤
     │◄── 200 + Manifest ─────┤                           │
```

- **不做缓存** — Worker 是无状态代理，镜像不落盘，每次拉取都会到达 ghcr.io。
- **自动重试** — 上游请求最多重试 3 次，指数退避。
- **头部清洗** — Cloudflare 专有头（`cf-*`、`server`、`set-cookie` 等）在返回 Docker 客户端前会被剥离。

---

## 局限性

- **默认只支持公开镜像** — 私有镜像需要通过代理传递认证 Token。
- **不支持 push** — 仅做 pull-through 代理，`docker push` 不代理。
- **不做缓存** — 每次拉取都走 ghcr.io，这是刻意设计，保证 Worker 无状态、免费额度友好。

---

## 协议

本项目采用 **GNU General Public License v3.0 only (GPL-3.0-only)** 协议。

你可以自由使用、修改、分发本软件，但必须遵守 GPL v3 的条款。**不适用**任何后续版本的 GPL。完整协议文本见 [LICENSE](LICENSE)。

**简述：**

- ✅ 可以自由使用本软件用于任何目的
- ✅ 可以自由修改和分发
- ⚠️ 分发时（无论是否修改）必须以同样的 GPL-3.0-only 条款开源并提供完整源码
- ❌ 不得以非 GPL-3.0-only 的协议重新许可

---

<p align="center">
  <sub>与 GitHub, Inc. 无任何关联</sub>
</p>
