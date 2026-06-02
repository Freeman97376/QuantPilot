# QuantPilot 视图组件目录

QuantPilot 生成页面采用配置驱动模式：Agent 只生成 `data_file/final/dashboard-data.json` 和 `data_file/final/view-config.json`，页面源码由平台固定 renderer 管理。这样模型可以自由组合组件、调整大小和顺序，但不能新增依赖、写 React、写 CSS 或执行不受控前端代码。

## 设计原则

1. 视觉效果由平台内置组件负责，Agent 只做数据和编排。
2. 组件数据读取必须来自 `dashboard-data.json` 的 `dataKey`。
3. `section.type` 必须在白名单内，`span` 只能是 `3`、`4`、`6`、`8`、`9`、`12`，`height` 只能是 `small`、`medium`、`large`、`xlarge`。
4. 高级组件借鉴 shadcn、TradingView 和动效面板的设计语言，但实现只使用 React、CSS 和 SVG，不引入新依赖。
5. 数据形态尽量宽容，字段名允许同义变体，避免模型因为字段命名小差异导致页面崩溃。

## 基础组件

| type | 用途 | 常用 dataKey |
| --- | --- | --- |
| `kpi-grid` | 核心指标卡片 | `summary.metrics`、`backtest.metrics`、`risk.metrics` |
| `line-chart` | 折线趋势 | `market.priceSeries`、`backtest.equityCurve` |
| `bar-chart` | 柱状对比 | `market.volumeSeries`、`comparison.rows` |
| `area-chart` | 面积趋势 | `market.priceSeries` |
| `candlestick-chart` | K 线形态，当前由安全 SVG 趋势降级渲染 | `kline.bars`、`history.bars` |
| `data-table` | 通用数据表 | `comparison.rows`、`backtest.trades`、`holdings` |
| `signal-table` | 信号表 | `signals`、`strategy.signals` |
| `markdown-analysis` | 分析结论 | `analysis.summary` |
| `risk-panel` | 风险指标 | `risk.metrics`、`portfolio.risk` |
| `drawdown-chart` | 回撤图 | `backtest.drawdown` |
| `correlation-heatmap` | 相关性矩阵，当前由安全 SVG 趋势降级渲染 | `correlation.rows` |
| `portfolio-allocation` | 组合配置指标 | `portfolio.allocation`、`holdings` |
| `alert-list` | 提醒和风险列表 | `alerts`、`risk.alerts` |

## 高级组件

### market-pulse-hero

用途：首屏行情脉冲面板，适合单标的、指数、ETF、组合概览。

推荐数据：

```json
{
  "name": "贵州茅台",
  "symbol": "600519",
  "price": 1688.5,
  "change_percent": 1.24,
  "summary": "放量上行，短期趋势偏强。",
  "metrics": [
    { "label": "成交额", "value": 32.4, "unit": "亿元" },
    { "label": "20日波动率", "value": 18.6, "unit": "%" }
  ]
}
```

建议布局：`span: 12`，`height: medium` 或 `large`。

### trend-volume-combo

用途：价格走势、均线与成交量组合主图，适合替代普通 `line-chart` 作为技术分析首屏核心图。

推荐数据：数组或 `{ "rows": [] }`，行内含 `date`、`close`/`price`、`ma5`、`ma10`、`ma20`、`volume`/`amount`。

建议布局：`span: 8` 或 `12`，`height: large`。

### decision-brief

用途：结构化展示结论、依据、风险和观察点，适合单标的诊断、组合调仓、回测复盘的解释区。

推荐数据：对象，含 `summary`/`conclusion`、`evidence[]`、`risks[]`、`next_steps[]`。

建议布局：`span: 4`、`6` 或 `12`，`height: medium`。

### risk-ribbon

用途：用风险色带展示趋势、量能、估值、波动、回撤、数据质量等状态。

推荐数据：对象或数组，含 `label`、`value`、`status`、`note`。

建议布局：`span: 4` 或 `6`，`height: medium`。

### valuation-temperature

用途：估值温度计，适合 PE/PB/ROE/分位数/股息率/增长率等基本面指标。

推荐数据：对象或数组，含 `label`、`value`、`unit`、`percentile`。

建议布局：`span: 4` 或 `6`，`height: medium`。

### financial-quality-matrix

用途：财务质量热力矩阵，适合多标的或多期财务指标对比。

推荐数据：数组或 `{ "rows": [] }`，行内含 `name`/`symbol`、`roe`、`gross_margin`、`net_margin`、`revenue_growth`、`profit_growth`、`debt_ratio`。

建议布局：`span: 6` 或 `12`，`height: medium`。

### backtest-diagnostics

用途：回测诊断卡片，展示收益、回撤、胜率、夏普、交易次数和策略状态。

推荐数据：对象，含 `metrics`、`summary`，或直接含 `total_return`、`max_drawdown`、`win_rate`、`sharpe`、`trade_count`。

建议布局：`span: 4` 或 `6`，`height: large`。

### asset-ranking-matrix

用途：多标的对比、选股排行、组合持仓强弱矩阵。

推荐数据：

```json
{
  "rows": [
    {
      "symbol": "600519",
      "name": "贵州茅台",
      "period_return": 12.4,
      "max_drawdown": -8.2,
      "volatility20d": 17.5,
      "composite_score": 86
    }
  ]
}
```

建议布局：`span: 12`，`height: medium`。多标的任务优先使用它替代普通表格作为第一层对比。

### risk-return-quadrant

用途：风险收益象限，适合比较股票池、ETF 池、策略池或持仓资产。

推荐数据：

```json
[
  { "symbol": "600519", "name": "贵州茅台", "volatility20d": 17.5, "period_return": 12.4 },
  { "symbol": "000858", "name": "五粮液", "volatility20d": 22.1, "period_return": 8.6 }
]
```

可选字段映射：

```json
{
  "encoding": {
    "x": "volatility20d",
    "y": "period_return"
  }
}
```

建议布局：`span: 8` 或 `12`，`height: large`。

### equity-drawdown-combo

用途：收益曲线和回撤组合图，适合回测复盘、策略收益、组合净值。

推荐数据：

```json
{
  "equityCurve": [
    { "date": "2026-01-02", "equity": 1.0, "benchmark": 1.0, "drawdown": 0 },
    { "date": "2026-01-03", "equity": 1.02, "benchmark": 1.01, "drawdown": -0.5 }
  ]
}
```

可选字段映射：

```json
{
  "encoding": {
    "x": "date",
    "equity": "equity",
    "benchmark": "benchmark",
    "drawdown": "drawdown"
  }
}
```

建议布局：`span: 8` 或 `12`，`height: large`。

### signal-timeline

用途：交易信号、公告事件、风控事件、策略执行复盘。

推荐数据：

```json
{
  "signals": [
    {
      "date": "2026-06-02",
      "title": "突破 20 日均线",
      "summary": "收盘价站上 MA20，成交额同步放大。",
      "severity": "positive"
    }
  ]
}
```

建议布局：`span: 4`、`6` 或 `12`，`height: medium`。

## 推荐组合

单标的趋势分析：

```text
market-pulse-hero span 12
trend-volume-combo span 8
risk-ribbon 或 decision-brief span 4
signal-timeline span 6
data-table span 6
```

多标的对比：

```text
asset-ranking-matrix span 12
risk-return-quadrant span 8
risk-ribbon span 4
financial-quality-matrix 或 data-table span 12
decision-brief span 12
```

回测复盘：

```text
kpi-grid span 12
equity-drawdown-combo span 8
backtest-diagnostics span 4
signal-timeline span 6
data-table span 6
decision-brief span 12
```

## 失败处理

如果页面失败，优先检查：

1. `view-config.sections[].type` 是否在白名单。
2. 每个 `dataKey` 是否能在 `dashboard-data.json` 找到。
3. 高级组件绑定的数据是否至少有一条可展示记录。
4. 多标的任务是否包含 `assets[]` 或 `comparison.rows[]`，并使用 `asset-ranking-matrix`、`risk-return-quadrant` 或 `data-table` 展示全部标的。
5. 回测任务是否包含 `backtest.equityCurve` 或类似收益序列，并使用 `equity-drawdown-combo`。
