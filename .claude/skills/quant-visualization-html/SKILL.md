---
name: quant-visualization-html
description: Use this skill to generate a QuantPilot quantitative dashboard view by producing dashboard-data.json and view-config.json only. The page itself is rendered by the platform fixed safe renderer.
---

# QuantPilot 配置驱动金融看板能力

本 skill 不再让 Agent 编写 React/Next.js 页面。QuantPilot 页面由平台固定安全 renderer 渲染，Agent 只负责生成或修复：

```text
data_file/final/dashboard-data.json
data_file/final/view-config.json
```

核心原则：

```text
Agent 可以自由编排 dashboard，但不能自由编程 dashboard。
```

## 硬性边界

1. 禁止新增依赖，禁止修改 `package.json`、`package-lock.json`、`pnpm-lock.yaml`、`yarn.lock`。
2. 禁止运行 `npm install`、`pnpm add`、`yarn add` 或任何安装依赖命令。
3. 禁止修改 `app/page.tsx`、`app/globals.css`、`app/layout.tsx`、`components/**`、`next.config.*`、`tsconfig.json`。
4. 禁止写 React、CSS、HTML 页面代码作为交付物。
5. 只允许生成或修复 `data_file/final/dashboard-data.json` 和 `data_file/final/view-config.json`。
6. 数据必须来自 QuantPilot 已预取的真实行情、财务、公告、回测、截图识别或本地计算结果；不得编造行情、财报、K 线或回测结果。
7. 不得写入 token、api key、cookie、authorization 或任何密钥。
8. 不得留下 mock、sample、demo、placeholder、示例数据、模拟数据、假数据标记。

## view-config 协议

`view-config.json` 负责页面编排。模型可以自由决定：

- 页面标题和副标题。
- 使用哪些安全组件。
- 组件顺序。
- 组件宽度 `span`。
- 组件高度 `height`。
- 组件标题。
- 组件绑定的 `dataKey`。
- 图表字段映射 `encoding`。
- 表格列 `columns`。

但必须遵守：

```text
layout.columns 固定为 12
section.type 只能来自白名单
span 只能是 3、4、6、8、9、12
height 只能是 small、medium、large、xlarge
section 数量最多 12 个
dataKey 必须能在 dashboard-data.json 中找到
不能写 style/className/customCss/componentCode
```

允许的 `section.type`：

```text
kpi-grid
line-chart
bar-chart
area-chart
candlestick-chart
data-table
signal-table
markdown-analysis
risk-panel
drawdown-chart
correlation-heatmap
portfolio-allocation
alert-list
market-pulse-hero
trend-volume-combo
decision-brief
risk-ribbon
valuation-temperature
financial-quality-matrix
backtest-diagnostics
asset-ranking-matrix
risk-return-quadrant
equity-drawdown-combo
signal-timeline
```

内置高级组件优先用于“惊艳但稳定”的第一屏和关键分析区：

| 组件 | 适合场景 | 推荐 dataKey 数据形态 |
| --- | --- | --- |
| `market-pulse-hero` | 单标的首屏、指数/ETF 状态、组合概览 | 对象，含 `name`、`symbol`、`price`、`change_percent`、`summary`、`metrics[]` |
| `trend-volume-combo` | 技术趋势主图、K 线/均线/成交量组合展示 | 数组或 `{ "rows": [] }`，行内含 `date`、`close`/`price`、`ma5`、`ma10`、`ma20`、`volume`/`amount` |
| `decision-brief` | 结论、依据、风险、下一步观察 | 对象，含 `summary`/`conclusion`、`evidence[]`、`risks[]`、`next_steps[]` |
| `risk-ribbon` | 趋势、量能、估值、波动、回撤、数据质量色带 | 对象或数组，含 `label`、`value`、`status`、`note` |
| `valuation-temperature` | PE/PB/ROE/分位数/增长率等估值温度 | 对象或数组，含 `label`、`value`、`unit`、`percentile` |
| `financial-quality-matrix` | 财务质量、基本面对比、指标热力矩阵 | 数组或 `{ "rows": [] }`，含 `name`/`symbol`、`roe`、`gross_margin`、`net_margin`、`revenue_growth`、`profit_growth` |
| `backtest-diagnostics` | 回测收益、回撤、胜率、夏普和交易质量 | 对象，含 `metrics`、`summary`，或直接含 `total_return`、`max_drawdown`、`win_rate`、`sharpe` |
| `asset-ranking-matrix` | 多标的对比、选股排行、组合持仓强弱 | 数组或 `{ "rows": [] }`，行内含 `symbol`、`name`、`period_return`、`max_drawdown`、`volatility20d`、`composite_score` |
| `risk-return-quadrant` | 多标的风险收益分布、策略池筛选 | 数组，行内含 `symbol`/`name`，以及 `volatility20d` 或 `max_drawdown`，`period_return` 或 `score` |
| `equity-drawdown-combo` | 回测复盘、策略表现、组合净值 | 数组或 `{ "equityCurve": [] }`，行内含 `date`、`equity`、`benchmark`、`drawdown` |
| `signal-timeline` | 交易信号、风控事件、公告/财报事件 | 数组或 `{ "signals": [] }`，行内含 `date`、`title`、`summary`、`severity` |
 
这些高级组件只是固定 renderer 的安全组件。不要写 CSS、React、SVG 或 Canvas 代码；只通过 `view-config.json` 选择组件、大小、顺序和字段映射。

推荐结构：

```json
{
  "version": "1.0",
  "page": {
    "title": "贵州茅台趋势分析",
    "subtitle": "基于近一年行情和技术指标生成",
    "density": "compact",
    "theme": "default"
  },
  "layout": {
    "type": "grid",
    "columns": 12,
    "gap": 16
  },
  "sections": [
    {
      "id": "core_metrics",
      "type": "kpi-grid",
      "title": "核心指标",
      "span": 12,
      "height": "small",
      "dataKey": "summary.metrics"
    },
    {
      "id": "price_trend",
      "type": "line-chart",
      "title": "价格走势与均线",
      "span": 8,
      "height": "large",
      "dataKey": "market.priceSeries",
      "encoding": {
        "x": "date",
        "y": ["close", "ma20", "ma60"]
      }
    },
    {
      "id": "analysis",
      "type": "markdown-analysis",
      "title": "分析结论",
      "span": 4,
      "height": "large",
      "dataKey": "analysis.summary"
    }
  ]
}
```

## dashboard-data 建议字段

`dashboard-data.json` 放数据和分析结果，不放 UI 代码。

推荐字段：

```json
{
  "meta": {
    "generatedAt": "2026-06-02T10:00:00Z",
    "symbols": ["600519"],
    "dataQuality": "ok"
  },
  "summary": {
    "metrics": [
      { "label": "最新价", "value": 1688.5, "unit": "CNY" },
      { "label": "近一年收益", "value": 12.4, "unit": "%" }
    ]
  },
  "market": {
    "priceSeries": [
      { "date": "2026-01-01", "close": 1688.5, "ma20": 1660.2, "ma60": 1602.8 }
    ],
    "volumeSeries": []
  },
  "analysis": {
    "summary": "该标的近期处于震荡上行阶段，成交量温和放大。"
  }
}
```

如果是多标的任务，必须包含：

```text
requestedSymbols
assets[]
comparison.rows[]
summary.metrics
analysis.summary
```

如果是回测任务，必须包含：

```text
backtest.equityCurve
backtest.drawdown
backtest.metrics
backtest.trades
analysis.summary
```

如果是持仓/组合任务，必须包含：

```text
portfolio
holdings[]
assets[]
comparison.rows[]
risk.metrics
analysis.summary
```

## 场景编排建议

单标的趋势：

```text
market-pulse-hero span 12
line-chart/candlestick-chart span 8
markdown-analysis span 4
bar-chart span 6
signal-timeline span 6
data-table span 12
```

多标的对比：

```text
asset-ranking-matrix span 12
risk-return-quadrant span 8
risk-panel span 4
data-table span 12
markdown-analysis span 12
```

回测复盘：

```text
kpi-grid span 12
equity-drawdown-combo span 8
risk-panel span 4
drawdown-chart span 6
data-table trades span 6
markdown-analysis span 12
```

组合风控：

```text
kpi-grid span 12
portfolio-allocation span 6
risk-panel span 6
correlation-heatmap span 8
markdown-analysis span 4
data-table holdings span 12
```

## 自动修复模式

当验证失败时，读取：

```text
.quantpilot/validation.json
.quantpilot/validation-repair-plan.json
.quantpilot/run_plan.json
data_file/final/dashboard-data.json
data_file/final/view-config.json
evidence/sources.json
evidence/data_quality.json
```

按失败类别修复：

- `MODEL_OUTPUT_INVALID`：修复 JSON 语法，确保两个文件是合法 JSON。
- `SCHEMA_VALIDATION_FAILED`：补齐 version/page/layout/sections/id/type/title/dataKey/span/height。
- `DATA_KEY_MISSING`：修复 `dataKey`，或在 `dashboard-data.json` 中补齐真实数据路径。
- `UNSUPPORTED_WIDGET`：把组件类型改成白名单内类型。
- `DATA_INSUFFICIENT`：读取已有 raw/final/evidence 数据，补齐真实可用字段。
- `AGENT_POLICY_VIOLATION`：撤销对页面、CSS、package 或构建配置的修改，只保留两个 JSON。
- `COMPILE_FAILED`：优先检查是否误改页面源码或 package；正常情况下固定 renderer 不应因 JSON 内容导致编译失败。

修复后必须确保：

```text
dashboard-data.json 可解析
view-config.json 可解析
view-config.sections[].dataKey 都能找到
section.type 全部在白名单
span/height 全部合法
没有新增依赖
没有修改页面源码作为交付
```

## 最终回复要求

完成后只需简短说明：

- `dashboard-data.json` 包含哪些数据。
- `view-config.json` 编排了哪些组件。
- 是否还有数据缺口或验证失败项。

不要声称修改了页面源码；页面由 QuantPilot 固定 renderer 自动渲染。
