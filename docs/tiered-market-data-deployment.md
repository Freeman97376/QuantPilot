# QuantPilot 分层、按需行情部署

本方案把行情分成三个默认层级，智能策略的“执行筛选”仍然只读取本地 TimescaleDB：

| 层级 | 范围 | 刷新方式 | 存储 |
|---|---:|---|---|
| `daily_eod` | 全A股 | 收盘后全市场一次；18:00只修缺失 | TimescaleDB，默认3年 |
| `daily_live_5m` | 活跃300 + 人工置顶 | 交易时段每5分钟动态日K | TimescaleDB，活跃池保留5年 |
| `minute1_*` / `minute5_confirm` | 用户点击的候选股，最多20只 | 缺失或超过90秒才拉取 | Redis，次日开盘前过期 |
| `minute_backtest` | 用户明确启动的少量股票 | 付费历史分钟任务 | TimescaleDB，90天 |

`daily_live_5m` 只表示“每5分钟更新一次当日动态日K”，不是5分钟K。分钟接口失败时返回 `degraded` 或 `unavailable`，不会拿动态日K冒充分钟K。

## 日常一键更新脚本

仓库包含 `deploy/server/quantpilot-maintain.sh`。首次安装到服务器脚本库：

```bash
sudo install -m 0755 \
  /opt/quantpilot/deploy/server/quantpilot-maintain.sh \
  /usr/local/sbin/quantpilot-maintain
```

以后使用普通 `ubuntu` 用户执行，不要对整个脚本使用 `sudo`：

```bash
# 拉取、安装依赖、迁移、构建、重启并检查；默认命令
quantpilot-maintain update

# 只检查，不修改服务
quantpilot-maintain check

# 只重启并检查
quantpilot-maintain restart
```

脚本会通过现有 SSH remote 拉取 `origin/main`，并在服务器工作区不干净、数据库容器不健康、构建失败或本机健康检查失败时立即停止。它不会运行 `docker compose down -v`，也不会覆盖 `.env.production`。

## 首次升级服务器

在 `/opt/quantpilot` 执行：

```bash
cd /opt/quantpilot
git pull --ff-only
QUANTPILOT_DEPLOYMENT=server npm ci
npx prisma generate

cd /opt/quantpilot/services/market-data
uv sync --frozen --extra baostock --extra akshare
cd /opt/quantpilot

set -a
. ./.env.production
set +a
npm run db:init
npm run build:server
```

在 `.env.production` 增加：

```dotenv
QUANTPILOT_DAILY_UNIVERSE_ID=a-share-sample-research-pool
QUANTPILOT_ACTIVE_UNIVERSE_ID=a-share-active-300
QUANTPILOT_MINUTE_BACKTEST_ENABLED=0
QUANTPILOT_TUSHARE_REALTIME_MINUTE_ENABLED=0

# 可选付费数据；仅服务器保存，不能使用 NEXT_PUBLIC_ 前缀。
TUSHARE_TOKEN=
```

`npm run db:init` 会执行 `sqls/008-tiered-strategy-data.sql`，创建 `a-share-active-300` 股票池。随后安装定时任务：

```bash
cd /opt/quantpilot

sudo install -m 0644 deploy/server/systemd/quantpilot-market-refresh@.service \
  /etc/systemd/system/quantpilot-market-refresh@.service
sudo install -m 0644 deploy/server/systemd/quantpilot-market-active.timer \
  /etc/systemd/system/quantpilot-market-active.timer
sudo install -m 0644 deploy/server/systemd/quantpilot-market-eod.timer \
  /etc/systemd/system/quantpilot-market-eod.timer
sudo install -m 0644 deploy/server/systemd/quantpilot-market-repair.timer \
  /etc/systemd/system/quantpilot-market-repair.timer
sudo install -m 0644 deploy/server/systemd/quantpilot-market-audit.timer \
  /etc/systemd/system/quantpilot-market-audit.timer

sudo systemctl daemon-reload
sudo systemctl restart quantpilot-market-data quantpilot-web
```

首次上线先导入全A股证券列表，并启动三年日线预检补数：

```bash
cd /opt/quantpilot/services/market-data
uv run --frozen --no-sync quantpilot-market-scheduler bootstrap

sudo journalctl -u quantpilot-market-data -f
```

`bootstrap` 分页导入全A股后启动 Baostock 自动补数任务；它会为已有完整覆盖的标的做预检跳过，不会重复下载完整历史。可通过应用的数据平台或 `/api/v1/ingestion/jobs` 观察任务进度。日线补数完成后再手工执行一次 `eod --force`，即可生成活跃300：

```bash
uv run --frozen --no-sync quantpilot-market-scheduler eod --force

sudo systemctl enable --now \
  quantpilot-market-active.timer \
  quantpilot-market-eod.timer \
  quantpilot-market-repair.timer \
  quantpilot-market-audit.timer
```

定时安排：

- `active`：工作日每5分钟唤醒；执行器自行跳过开盘前、午休和收盘后。
- `eod`：交易所时区15:20，全市场分页写入当日快照并重建活跃300。
- `repair`：18:00启动 Baostock 预检补数；本地覆盖完整的标的直接跳过。
- `audit`：每周日检查股票池、字段覆盖、保留期和磁盘；70%告警，80%暂停新分钟持久化。
- 模板服务使用 `flock`；同一类任务未结束时不会重叠运行。

## 上线验证

```bash
sudo systemctl is-active quantpilot-market-data quantpilot-web
sudo systemctl list-timers 'quantpilot-market-*' --all

curl -fsS http://127.0.0.1:8000/api/v1/ingestion/strategy-profiles |
  python3 -m json.tool

curl -fsS -X POST \
  'http://127.0.0.1:8000/api/v1/ingestion/active-pool/rebuild?limit=300' |
  python3 -m json.tool

curl -fsS -X POST \
  http://127.0.0.1:8000/api/v1/ingestion/strategy-refresh \
  -H 'Content-Type: application/json' \
  -d '{
    "profile": "minute1_entry",
    "symbols": ["600519.SH"],
    "universe_id": "a-share-sample-research-pool"
  }' |
  python3 -m json.tool
```

第二次在90秒内重复最后一个请求，应该返回 `items[0].status=ready`、`cache_status=redis-hit`，且不产生外部分钟请求。免费分钟源失败时，顶层状态应为 `unavailable` 或 `partial`，页面继续保留日线候选。

查看定时任务日志：

```bash
sudo journalctl -u 'quantpilot-market-refresh@*' -n 200 --no-pager
sudo systemctl start quantpilot-market-refresh@active.service
sudo systemctl start quantpilot-market-refresh@audit.service
```

手工启动 `active` 时，如果当前不在A股交易时段，日志显示 `outside-cn-a-session` 属于正常跳过。需要在非交易时段验证外部链路时，可在项目目录执行 `uv run --frozen --no-sync quantpilot-market-scheduler active --force`。

## 可选 Tushare

默认免费方案不需要 Tushare。启用任何 Tushare 档位前：

```bash
cd /opt/quantpilot/services/market-data
uv sync --frozen --extra baostock --extra akshare --extra tushare
```

然后只在服务器 `.env.production` 设置 `TUSHARE_TOKEN`。购买实时分钟权限后，可开启免费源失败时的 `rt_min` 兜底：

```dotenv
QUANTPILOT_TUSHARE_REALTIME_MINUTE_ENABLED=1
```

购买历史分钟权限并明确启用分钟回测后，再设置：

```dotenv
QUANTPILOT_MINUTE_BACKTEST_ENABLED=1
```

实时分钟适配器使用 Tushare 官方 `rt_min`，且只有免费分钟源失败或只返回过期缓存时才调用；历史分钟回测使用 `pro_bar`。两个付费开关默认均为 `0`，仅配置 Token 不会产生付费分钟请求。Tushare 的接口权限和价格以[官方实时分钟文档](https://tushare.pro/document/2?doc_id=374)及[官方权限表](https://tushare.pro/document/1?doc_id=290)为准。免费公开接口属于尽力而为，商业使用前应阅读 [AKShare 官方说明](https://akshare.akfamily.xyz/introduction.html)。
