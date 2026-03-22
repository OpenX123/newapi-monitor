# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

NewAPI 令牌用量监控面板，直连 NewAPI 的 PostgreSQL 数据库 `logs` 表进行只读聚合，并通过 NewAPI REST API 管理 Token 状态（禁用/启用）。支持自动超限告警（邮件）和手动操作。

## 常用命令

```bash
npm run dev    # 开发模式（--watch 自动重启）
npm start      # 生产启动
```

无构建步骤、无 lint、无测试套件。Node.js >= 18，CommonJS 模块。

## 架构

**单进程 Express 应用**，所有后端逻辑在 `server.js` 一个文件中（~480 行），前端静态文件在 `public/` 目录。

### 数据流

1. **PostgreSQL 直连** — 通过 `pg.Pool` 连接 NewAPI 的数据库，只读查询 `logs` 表做聚合统计
2. **NewAPI REST API** — 通过 `apiRequest()` 封装调用 NewAPI 的 `/api/token/*` 端点来禁用/启用 Token
3. **定时轮询** — `pollAndCheck()` 按 `POLL_INTERVAL` 间隔执行，聚合当日数据、检查超限、发送邮件、尝试禁用 Token
4. **前端** — 原生 HTML/CSS/JS + Chart.js，通过 fetch 调用后端 API，SPA 风格的标签页切换（排行榜/趋势/日志/告警/设置）

### 自建数据库表（与 NewAPI 共用数据库）

- `monitor_actions` — 操作记录（禁用/启用/通知）
- `monitor_whitelist` — 白名单 Token（不受自动禁用影响）
- `monitor_kv` — 持久化配置（dailyLimit、pollInterval、notifyEmail）

### 关键 API 路由

| 路由 | 用途 |
|------|------|
| `GET /api/snapshot` | 最新轮询快照 |
| `POST /api/poll` | 手动触发轮询 |
| `GET /api/stats?range=&dim=` | 多维聚合（token/user/model/group/channel） |
| `GET /api/trend?range=` | 按小时趋势 |
| `GET /api/distribution?range=` | TOP 10 分布 |
| `GET /api/recent-logs?range=&p=` | 调用日志分页 |
| `POST /api/token/:id/disable\|enable` | 手动禁用/启用 |
| `GET\|POST\|DELETE /api/whitelist` | 白名单管理 |
| `GET\|PUT /api/config` | 运行时配置 |

### 部署

Docker 镜像通过 GitHub Actions 构建（`.github/workflows/docker.yml`），推送至 GHCR，支持 amd64/arm64。

## 注意事项

- `logs` 表由 NewAPI 维护，本项目只做只读查询，不写入该表
- `apiRequest()` 使用原生 `http/https` 模块而非 fetch/node-fetch，根据 `NEWAPI_BASE_URL` 协议自动选择
- `created_at` 时间戳为 Unix 秒级整数，前端格式化时需 `* 1000`
- 前端 `app.js` 中 `COLUMNS` 定义了各维度的表头配置，新增维度需同步修改
