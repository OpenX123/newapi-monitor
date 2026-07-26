# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

NewAPI 令牌用量监控面板，直连 NewAPI 的 PostgreSQL 数据库 `logs` 表进行只读聚合，并通过 NewAPI REST API 管理 Token 状态（禁用/启用）。支持自动超限告警（邮件）、**单用户行为分析（脚本/自动化检测）**、**报错分析**、以及 **Redis 缓存加速**。

## 常用命令

```bash
npm run dev     # 开发模式（--watch 自动重启）
npm start       # 生产启动
npm test        # 单元测试，无需数据库
npm run test:db # 集成测试，需 DATABASE_URL（只读查询真实库）
```

无构建步骤、无 lint。Node.js >= 18，CommonJS 模块。

测试不使用任何测试框架，`test/lib.js` 提供极简断言，并通过 `extract()` / `constant()` **从 server.js 抽取真实代码片段和 SQL 常量来跑**，避免测试与实现脱节。改动聚合 SQL、通知渠道、配置字段后，跑一遍 `npm test` 能立刻发现接线断裂。

## 架构

**单进程 Express 应用**，所有后端逻辑在 `server.js` 一个文件中（~1450 行），前端静态文件在 `public/` 目录。

### 数据流

1. **PostgreSQL 直连** — 通过 `pg.Pool` 连接 NewAPI 的数据库，只读查询 `logs` 表做聚合统计
2. **NewAPI REST API** — 通过 `apiRequest()` 封装调用 NewAPI 的 `/api/token/*` 端点来禁用/启用 Token
3. **定时轮询** — `pollAndCheck()` 按 `POLL_INTERVAL` 间隔执行，聚合当日数据、检查超限、发送邮件、尝试禁用 Token
4. **Redis 缓存层**（可选）— 通过 `redis` 客户端缓存查询结果，带缓存失效锁 `withCacheLock`，基于日志 cursor 的增量缓存策略
5. **前端** — 原生 HTML/CSS/JS + Chart.js，通过 fetch 调用后端 API，SPA 风格的标签页切换（排行榜/趋势/报错分析/调用记录/通知记录/白名单/设置）

### 自建数据库表（与 NewAPI 共用数据库）

- `monitor_actions` — 操作记录（禁用/启用/通知），含 `action_meta JSONB` 扩展字段
- `monitor_whitelist` — 白名单 Token（不受自动禁用影响）
- `monitor_kv` — 持久化配置（dailyLimit、pollInterval、notifyEmail）

### 关键 API 路由

| 路由 | 用途 |
|------|------|
| `GET /api/snapshot` | 最新轮询快照（带 Redis 缓存） |
| `GET /api/dashboard?range=&dim=` | 聚合仪表板（快照+统计+状态+操作记录+白名单） |
| `POST /api/poll` | 手动触发轮询 |
| `GET /api/stats?range=&dim=` | 多维聚合（token/user/model/group/channel） |
| `GET /api/trend?range=` | 按小时趋势 |
| `GET /api/distribution?range=` | TOP 10 分布 |
| `GET /api/error-analysis?range=` | 报错分析（状态码/流式中断/渠道排行/报错分类/最近错误） |
| `GET /api/user-analysis?username=&token_id=&range=` | 单用户行为分析（脚本信号检测、昼夜分离评分） |
| `GET /api/recent-logs?range=&p=` | 调用日志分页 |
| `POST /api/token/:id/disable\|enable` | 手动禁用/启用 |
| `GET\|POST\|DELETE /api/whitelist` | 白名单管理 |
| `GET\|PUT /api/config` | 运行时配置（含 SMTP / 飞书渠道，密钥字段只回掩码） |
| `POST /api/notify/test` | 通知渠道连通性测试（`channel: email\|feishu\|all`） |
| `GET /api/events` | SSE 实时事件流（新日志 / 告警推送） |
| `GET /api/subscriptions?hours=` | 订阅余量（每用户当前套餐剩余） |
| `GET /healthz` | 健康检查（免鉴权，供容器编排使用） |

### 处置策略与订阅余量

- **`maybeDisableToken()`** 是唯一真正调用 `setTokenStatus()` 关停 Token 的自动路径。受 `disablePolicy` 控制：`notify_only`（默认，只告警）/ `auto`（真禁用）。**默认值刻意保守**——历史版本里这条路径根本没实现，升级不应该突然开始断客户服务
- 禁用前会检查白名单与当天是否已禁用过；禁用成功/失败都会落 `auto_disable` / `auto_disable_script` 记录
- **订阅余量**（`getSubscriptions`）：NewAPI 把套餐信息写在 `logs.other` 的 `subscription_remain` / `subscription_total` / `subscription_plan_title` 里。取每个用户**最近一条消费日志**的快照，即他当前正在消耗的套餐；按 `username` 做 `DISTINCT ON` 时不要把 jsonb 表达式放进排序键，否则慢一个数量级（实测 6.3s → 0.4s）
- 余量告警按「用户 + 档位」去重（`sub:<user>:<tier>`），从 20% 掉到 5% 会再提醒一次

### 报错分析的性能红线

`getErrorAnalysis()` 的第三条查询**必须在 SQL 里完成字段解析和「是否失败」的过滤**，绝不能把 `other` 整列 SELECT 回 Node。历史实现把范围内所有带 JSON 的消费日志全查回来再在 JS 里过滤，30 天 = 26 万行、**238MB 文本进内存**；下推后只剩真实失败行（约 4.5 万行、2.7MB），1 天范围实测 9.1s → 0.67s。改这块时务必保持过滤下推。

### 实时风控规则（`runRealtimeRules`）

与 `pollAndCheck` 的「日累计超阈值」互补：规则看的是**最近 N 分钟**发生了什么，脚本刚开始刷就能告警，不用等日累计撞线。独立定时器（`RULE_INTERVAL_MS`，默认 60s），**与面板是否打开无关**。

| 规则 | action | 判据 |
|------|--------|------|
| 用量异常 | `alert_usage` | 窗口调用数 ≥ `surgeCalls`，或较上一窗口放大 ≥ `surgeRatio`×（需 ≥ `surgeMinCalls`），或窗口费用 ≥ `surgeCostUsd` |
| 疑似共享 | `alert_token_ips` | 单 Token 窗口内来源 IP 数 ≥ `shareIpPerToken` |
| 同 IP 多账号 | `alert_ip_users` | 单 IP 窗口内账号数 ≥ `shareUsersPerIp` |

- 突增与费用**共用一条告警和一个冷却**（`alert_usage`），否则同一次事件会推两条消息；标题按主因在「费用飙升 / 用量异常」间切换，触发条件全部列在正文
- 主查询一条 SQL 同时算出：本窗口/上一窗口调用数、本窗口费用与 token 用量、本窗口 IP 数
- `alertOnce()` 按 `action_meta->>'subject'`（`token:<id>` / `ip:<addr>`）+ `alertCooldownMin` 去重；**即使没配任何通知渠道也会落库**，面板「通知记录」就是告警日志
- 白名单 Token 跳过所有规则

### 通知与实时推送

- **配置来源**：`KV_CONFIG_KEYS` 列出的键都可以在面板保存到 `monitor_kv`，启动时由 `loadSavedConfig()` 覆盖同名环境变量默认值。改配置后 `getTransporter()` 会按新参数重建 SMTP 连接，不需要重启
- **渠道出口统一走 `notifyAlert({title, level, lines})`**，内部并行尝试 email + 飞书，单个渠道失败不影响其他渠道，返回每个渠道的结果
- **飞书签名**：`feishuSign()` 以 `"{timestamp}\n{secret}"` 为 HMAC key 对空串签名再 base64（飞书自定义机器人规范）
- **密钥不回传**：`publicConfig()` 里 `smtpPass`/`feishuSecret` 只返回「是否已设置」，`feishuWebhook` 只返回掩码；PUT 时留空表示不修改，显式传 `null` 才清空
- **告警去重**：超限告警和脚本告警都按 `monitor_actions` 里当天是否已有对应 action 记录（`notify` / `notify_script`）去重
- **SSE**：`/api/events` 维护 `sseClients`，`watchRealtime()` 每 `REALTIME_INTERVAL_MS` 检查一次 `logs` 游标——**没有订阅者时直接返回，不查库**

### 缓存策略

- `getOrBuildCached(key, range, builder)` — 基于 `logs` 表最新 `max(id)` 和 `max(created_at)` 作为 cursor，当 cursor 未变化时直接返回缓存
- `withCacheLock` — Redis 分布式锁，防止缓存穿透
- 缓存前缀可通过 `REDIS_KEY_PREFIX` 配置，默认 `newapi-monitor`

### 部署

Docker 镜像通过 GitHub Actions 构建（`.github/workflows/docker.yml`），推送至 GHCR，支持 amd64/arm64。

## 注意事项

- `logs` 表由 NewAPI 维护，本项目只做只读查询，不写入该表
- **用量统计口径**（`REQUEST_LOGS` / `USAGE_AGG` 常量）：`logs.type` 中 1=充值 2=消费 3=管理 4=系统 5=错误 7=登录事件。只有 `type = 2` 携带真实用量，其余类型（尤其是登录日志，数量不小）不是 API 调用。因此 **调用次数统计 `type IN (2,5)`，费用与 token 只对 `type = 2` 求和**（`SUM(...) FILTER (WHERE type = 2)`）
- `logs.quota` 是 NewAPI 内部计费单位，换算由 `QUOTA_PER_UNIT` 决定（默认 500000 = $1）。**面板统一按美元 + token 两个口径展示，不出现「额度」这一概念**，前端 `formatUSD()` 负责换算
- **`prompt_tokens` 已包含缓存读取 token**（已用真实计费公式核对：`quota = ((prompt - cache) * model_ratio + cache * model_ratio * cache_ratio + completion * model_ratio * completion_ratio) * group_ratio`）。所以「实际使用 token」= `prompt_tokens + completion_tokens`，缓存部分通过 `CACHE_TOKENS_EXPR` 从 `other` 里单独拆出来展示，**不能再加一遍**
- `CACHE_TOKENS_EXPR` 用正则而非 `other::jsonb` 提取，避免个别行 `other` 非法 JSON / 非整数值导致整条聚合查询报错
- 聚合结果结构变更时需递增 `CACHE_SCHEMA_VERSION`，否则升级后会读到旧口径的 Redis 缓存
- `apiRequest()` 使用原生 `http/https` 模块而非 fetch/node-fetch，根据 `NEWAPI_BASE_URL` 协议自动选择
- `created_at` 时间戳为 Unix 秒级整数，前端格式化时需 `* 1000`
- 前端 `app.js` 中 `COLUMNS` 定义了各维度的表头配置，新增维度需同步修改
- **脚本检测**通过解析 `logs.other` 字段中的 `admin_info.channel_affinity` 信息，识别 `claude cli trace`、`codex cli trace`、`metadata.user_id`、`prompt_cache_key` 等信号
- Redis 为可选依赖，未配置时自动降级为直连数据库
