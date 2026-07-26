# NewAPI Monitor

NewAPI 令牌用量监控面板 — 实时监控用户调用量、Token 用量、美元费用，支持自动禁用超限 Token 和邮件告警。

## 功能

- **排行榜** — 按 Token / 用户 / 模型 / 分组 / 渠道维度查看调用统计，支持排序、搜索、分页
- **趋势分析** — 每小时调用量、活跃 Token/用户趋势、用户/Token 排名、模型分布等 6 种图表
- **用户行为分析** — 一键分析单个用户是否为脚本/自动化，提供脚本评分、调用间隔分析、并发检测等证据
- **调用记录** — 实时查看最近的 API 调用日志，支持分页浏览
- **实时监控** — SSE 推送，有新调用即自动刷新当前面板，新记录高亮
- **实时风控** — 滑动窗口检测调用突增、费用飙升（$/小时）、账号共享（单 Token 多 IP / 单 IP 多账号），阈值面板可调
- **多渠道告警** — SMTP 邮件 + 飞书机器人，面板内直接配置和测试
- **订阅余量** — 追踪每个用户当前套餐的剩余额度，余量告急时推送续费提醒
- **处置策略** — 超限可选「仅告警」或「自动禁用 Token」，白名单永久豁免
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

## 测试

```bash
npm test        # 单元测试，无需数据库（通知渠道、格式化、密钥安全、前后端接线、统计口径）
npm run test:db # 集成测试，把面板会发出的每条 SQL 在真实库上跑一遍（只读，需 DATABASE_URL）
```

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `NEWAPI_BASE_URL` | NewAPI 地址 | — |
| `NEWAPI_ACCESS_TOKEN` | NewAPI 管理员 Access Token | — |
| `NEWAPI_USER_ID` | 管理员用户 ID | `1` |
| `DATABASE_URL` | PostgreSQL 连接字符串 | — |
| `DAILY_LIMIT` | 日调用量限制 (超限自动禁用) | `2000` |
| `QUOTA_PER_UNIT` | 计费单位换算 (多少 quota = $1，对应 NewAPI 的 QuotaPerUnit) | `500000` |
| `POLL_INTERVAL` | 轮询间隔 (毫秒) | `300000` |
| `PORT` | 服务端口 | `3456` |
| `DASHBOARD_ACCESS_KEY` | 面板访问密钥；设置后必须登录才能访问页面和 API | 不启用鉴权 |
| `REALTIME_INTERVAL_MS` | 实时推送检查新日志的间隔（毫秒） | `5000` |
| `RULE_ENABLED` | 是否启用实时风控规则 | `true` |
| `RULE_INTERVAL_MS` | 规则检查间隔（毫秒） | `60000` |
| `SURGE_WINDOW_MIN` | 风控滑动窗口（分钟） | `5` |
| `SURGE_CALLS` | 窗口内调用数阈值 | `300` |
| `SURGE_RATIO` | 相对上一窗口的突增倍数 | `5` |
| `SURGE_MIN_CALLS` | 倍数规则的最低调用数 | `30` |
| `SURGE_COST_USD` | 窗口内费用阈值（美元） | `5` |
| `SHARE_IP_PER_TOKEN` | 单 Token 窗口内 IP 数阈值 | `2` |
| `SHARE_USERS_PER_IP` | 单 IP 窗口内账号数阈值 | `2` |
| `ALERT_COOLDOWN_MIN` | 同类告警冷却（分钟） | `30` |
| `DISABLE_POLICY` | 超限处置：`notify_only`（仅告警）/ `auto`（自动禁用） | `notify_only` |
| `DISABLE_ON_SCRIPT` | 脚本行为是否也自动禁用（需 `DISABLE_POLICY=auto`） | `false` |
| `SUBSCRIPTION_ALERT_PCT` | 订阅余量低于此百分比时提醒续费，`0` 关闭 | `20` |
| `ERROR_ROWS_LIMIT` | 报错分析明细的行数上限（兜底） | `200000` |
| `SMTP_HOST` | 邮件服务器 | `smtp.qq.com` |
| `SMTP_PORT` | 邮件端口 | `587` |
| `SMTP_SECURE` | 是否使用 SSL/TLS（465 端口自动启用） | `false` |
| `SMTP_USER` | 发件邮箱 | — |
| `SMTP_PASS` | 邮箱授权码 | — |
| `SMTP_FROM` | 发件人显示名 | 同 `SMTP_USER` |
| `FEISHU_WEBHOOK` | 飞书自定义机器人 Webhook 地址 | — |
| `FEISHU_SECRET` | 飞书机器人签名密钥（勾选签名校验时填） | — |
| `NOTIFY_SCRIPT` | 检测到脚本行为时是否告警 | `true` |
| `ALERT_DAILY_LIMIT` | 是否启用每日调用超限告警 | `false` |
| `ALERT_USAGE_ANOMALY` | 是否启用调用突增/费用异常告警 | `false` |
| `ALERT_IP_USERS` | 是否启用同 IP 多账号告警 | `false` |
| `ALERT_SUBSCRIPTION` | 是否启用订阅余量告警 | `false` |
| `SCRIPT_CLAUDE_ALERT_CALLS` | Claude trace 的日调用告警阈值 | `1500` |
| `SCRIPT_GPT_ALERT_CALLS` | Codex（GPT）trace 的日调用告警阈值 | `800` |

> SMTP 与飞书的所有配置都可以直接在面板「设置」里填写并测试，保存后立即生效、无需重启；环境变量只作为首次启动的默认值。

> 本项目直连 NewAPI 的 PostgreSQL 数据库 `logs` 表，不会写入或修改任何 NewAPI 数据。

### 面板访问鉴权

设置 `DASHBOARD_ACCESS_KEY` 后，打开面板会先要求输入访问密钥。登录状态通过仅 HTTP 的 Cookie 保存 24 小时；服务重启后需要重新登录。请使用足够长的随机字符串，并在公网部署时通过 HTTPS 访问。

## 预览
<img width="2176" height="1378" alt="image" src="https://github.com/user-attachments/assets/ffed3141-eb3d-4be0-a660-d41358d6f917" />
<img width="2187" height="1392" alt="image" src="https://github.com/user-attachments/assets/900718b7-3ffa-4d97-9d61-a5697dc8b6f8" />
<img width="2215" height="1412" alt="image" src="https://github.com/user-attachments/assets/cd10df56-500b-4108-bebc-59fec3653491" />
<img width="2203" height="1374" alt="image" src="https://github.com/user-attachments/assets/5022b4be-e379-4a50-9aca-186d189dc8a4" />
<img width="1659" height="935" alt="image" src="https://github.com/user-attachments/assets/78de8bce-c90d-46cb-b74c-785e29a94c43" />

## 社区支持
https://linux.do

## License

[MIT](LICENSE)
