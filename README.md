# NewAPI Monitor

NewAPI 令牌用量监控面板 — 实时监控用户调用量、额度消耗、Token 使用情况，支持自动禁用超限 Token 和邮件告警。

## 功能

- **排行榜** — 按 Token / 用户 / 模型 / 分组 / 渠道维度查看调用统计，支持排序、搜索、分页
- **趋势分析** — 每小时调用量、活跃 Token/用户趋势、用户/Token 排名、模型分布等 6 种图表
- **用户行为分析** — 一键分析单个用户是否为脚本/自动化，提供脚本评分、调用间隔分析、并发检测等证据
- **调用记录** — 实时查看最近的 API 调用日志，支持分页浏览
- **自动告警** — 超过日调用限制时自动禁用 Token 并发送邮件通知
- **白名单** — 指定 Token 不受自动禁用影响
- **时间范围** — 支持 1天 / 3天 / 7天 / 30天 切换

## 快速开始

```bash
docker pull ghcr.io/openx123/newapi-monitor:latest

docker run -d --name newapi-monitor \
  -p 3456:3456 \
  -e NEWAPI_BASE_URL=https://your-newapi-domain.com \
  -e NEWAPI_ACCESS_TOKEN=your_token \
  -e DATABASE_URL=postgres://user:pass@host:5432/newapi \
  ghcr.io/openx123/newapi-monitor:latest
```

浏览器打开 `http://localhost:3456` 即可。

> 镜像支持 `linux/amd64` 和 `linux/arm64` 架构。

### Docker Compose

```bash
wget https://raw.githubusercontent.com/OpenX123/newapi-monitor/master/docker-compose.yml
# 编辑 docker-compose.yml 中的环境变量
docker compose up -d
```

### 手动部署

```bash
git clone https://github.com/OpenX123/newapi-monitor.git
cd newapi-monitor
npm install
cp .env.example .env
# 编辑 .env 填入你的配置
npm start
```

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

> 本项目直连 NewAPI 的 PostgreSQL 数据库 `logs` 表，不会写入或修改任何 NewAPI 数据。

## 预览
<img width="2176" height="1378" alt="image" src="https://github.com/user-attachments/assets/ffed3141-eb3d-4be0-a660-d41358d6f917" />
<img width="2187" height="1392" alt="image" src="https://github.com/user-attachments/assets/900718b7-3ffa-4d97-9d61-a5697dc8b6f8" />
<img width="2215" height="1412" alt="image" src="https://github.com/user-attachments/assets/cd10df56-500b-4108-bebc-59fec3653491" />
<img width="2203" height="1374" alt="image" src="https://github.com/user-attachments/assets/5022b4be-e379-4a50-9aca-186d189dc8a4" />
<img width="1659" height="935" alt="image" src="https://github.com/user-attachments/assets/78de8bce-c90d-46cb-b74c-785e29a94c43" />


## License

[MIT](LICENSE)
