# NewAPI Monitor

NewAPI 令牌用量监控面板 — 实时监控用户调用量、额度消耗、Token 使用情况，支持自动禁用超限 Token 和邮件告警。

## 功能

- **排行榜** — 按 Token / 用户 / 模型 / 分组 / 渠道维度查看调用统计，支持排序、搜索、分页
- **趋势分析** — 每小时调用量、活跃 Token/用户趋势、用户/Token 排名、模型分布等 6 种图表
- **调用记录** — 实时查看最近的 API 调用日志，支持分页浏览
- **自动告警** — 超过日调用限制时自动禁用 Token 并发送邮件通知
- **白名单** — 指定 Token 不受自动禁用影响
- **时间范围** — 支持 1天 / 3天 / 7天 / 30天 切换

## 技术栈

- **后端**: Node.js + Express + PostgreSQL (`pg`)
- **前端**: 原生 HTML/CSS/JS + Chart.js
- **通知**: Nodemailer (SMTP)

## 前置要求

- Node.js >= 18
- 一个正在运行的 [NewAPI](https://github.com/Calcium-Ion/new-api) 实例及其 PostgreSQL 数据库

> 本项目直连 NewAPI 的 PostgreSQL 数据库 `logs` 表，不会写入或修改任何 NewAPI 数据。

## 快速开始

```bash
# 克隆项目
git clone https://github.com/your-username/newapi-monitor.git
cd newapi-monitor

# 安装依赖
npm install

# 配置环境变量
cp .env.example .env
# 编辑 .env 填入你的配置

# 启动
npm start
```

浏览器打开 `http://localhost:3456` 即可。

### Docker 部署（推荐）

```bash
# 使用 docker-compose（推荐）
wget https://raw.githubusercontent.com/your-username/newapi-monitor/master/docker-compose.yml
# 编辑 docker-compose.yml 中的环境变量
docker compose up -d

# 或直接 docker run
docker run -d --name newapi-monitor \
  -p 3456:3456 \
  -e NEWAPI_BASE_URL=https://your-newapi-domain.com \
  -e NEWAPI_ACCESS_TOKEN=your_token \
  -e DATABASE_URL=postgres://user:pass@host:5432/newapi \
  ghcr.io/your-username/newapi-monitor:latest
```

> 镜像支持 `linux/amd64` 和 `linux/arm64` 架构。

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `NEWAPI_BASE_URL` | NewAPI 地址 | — |
| `NEWAPI_ACCESS_TOKEN` | NewAPI 管理员 Access Token | — |
| `NEWAPI_USER_ID` | 管理员用户 ID | `1` |
| `DATABASE_URL` | PostgreSQL 连接字符串 | — |
| `DAILY_LIMIT` | 日调用量限制 (超限自动禁用) | `2000` |
| `POLL_INTERVAL` | 轮询间隔 (毫秒) | `300000` |
| `PORT` | 服务端口 | `3456` |
| `SMTP_HOST` | 邮件服务器 | `smtp.qq.com` |
| `SMTP_PORT` | 邮件端口 | `587` |
| `SMTP_USER` | 发件邮箱 | — |
| `SMTP_PASS` | 邮箱授权码 | — |

## License

[MIT](LICENSE)
