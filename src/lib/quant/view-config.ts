export const QUANT_ALLOWED_WIDGET_TYPES = [
  'kpi-grid',
  'line-chart',
  'bar-chart',
  'area-chart',
  'candlestick-chart',
  'data-table',
  'signal-table',
  'markdown-analysis',
  'risk-panel',
  'drawdown-chart',
  'correlation-heatmap',
  'portfolio-allocation',
  'alert-list',
  'market-pulse-hero',
  'trend-volume-combo',
  'decision-brief',
  'risk-ribbon',
  'valuation-temperature',
  'financial-quality-matrix',
  'backtest-diagnostics',
  'asset-ranking-matrix',
  'risk-return-quadrant',
  'equity-drawdown-combo',
  'signal-timeline',
] as const;

export const QUANT_ALLOWED_SECTION_SPANS = [3, 4, 6, 8, 9, 12] as const;
export const QUANT_ALLOWED_SECTION_HEIGHTS = ['small', 'medium', 'large', 'xlarge'] as const;

export type QuantWidgetType = (typeof QUANT_ALLOWED_WIDGET_TYPES)[number];
export type QuantSectionSpan = (typeof QUANT_ALLOWED_SECTION_SPANS)[number];
export type QuantSectionHeight = (typeof QUANT_ALLOWED_SECTION_HEIGHTS)[number];

export type JsonRecord = Record<string, unknown>;

export interface QuantViewSection {
  id: string;
  type: QuantWidgetType;
  title: string;
  dataKey: string;
  span: QuantSectionSpan;
  height: QuantSectionHeight;
  subtitle?: string;
  description?: string;
  encoding?: JsonRecord;
  columns?: Array<{ key: string; label: string }>;
  options?: JsonRecord;
}

export interface QuantViewConfig {
  version: '1.0';
  page: {
    title: string;
    subtitle?: string;
    density?: 'compact' | 'comfortable';
    theme?: 'default';
  };
  layout: {
    type: 'grid';
    columns: 12;
    gap?: number;
  };
  sections: QuantViewSection[];
}

export type QuantViewConfigValidationIssue = {
  code:
    | 'VIEW_CONFIG_MISSING'
    | 'MODEL_OUTPUT_INVALID'
    | 'SCHEMA_VALIDATION_FAILED'
    | 'UNSUPPORTED_WIDGET'
    | 'DATA_KEY_MISSING';
  message: string;
};

export function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function getByPath(root: unknown, dataKey: string): unknown {
  if (!dataKey.trim()) {
    return undefined;
  }
  return dataKey
    .split('.')
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce<unknown>((current, part) => {
      if (current === undefined || current === null) {
        return undefined;
      }
      if (Array.isArray(current) && /^\d+$/.test(part)) {
        return current[Number(part)];
      }
      if (isRecord(current)) {
        return current[part];
      }
      return undefined;
    }, root);
}

export function normalizeSectionSpan(value: unknown): QuantSectionSpan {
  return QUANT_ALLOWED_SECTION_SPANS.includes(value as QuantSectionSpan)
    ? (value as QuantSectionSpan)
    : 12;
}

export function normalizeSectionHeight(value: unknown): QuantSectionHeight {
  return QUANT_ALLOWED_SECTION_HEIGHTS.includes(value as QuantSectionHeight)
    ? (value as QuantSectionHeight)
    : 'medium';
}

export function buildDefaultViewConfig(data: unknown): QuantViewConfig {
  const record = isRecord(data) ? data : {};
  const visualization = isRecord(record.visualization) ? record.visualization : {};
  const title = String(
    visualization.title ??
      visualization.name ??
      record.name ??
      record.symbol ??
      'QuantPilot 量化分析看板'
  );
  const sections: QuantViewSection[] = [];

  const hasUsableValue = (dataKey: string) => {
    const value = getByPath(record, dataKey);
    if (value === undefined || value === null) return false;
    if (Array.isArray(value)) return value.length > 0;
    if (isRecord(value)) return Object.keys(value).length > 0;
    return true;
  };

  if (getByPath(record, 'quote') !== undefined) {
    sections.push({
      id: 'market_pulse',
      type: 'market-pulse-hero',
      title: '行情脉冲',
      dataKey: 'quote',
      span: 12,
      height: 'medium',
    });
  } else if (getByPath(record, 'summary.metrics') !== undefined) {
    sections.push({
      id: 'summary_metrics',
      type: 'kpi-grid',
      title: '核心指标',
      dataKey: 'summary.metrics',
      span: 12,
      height: 'small',
    });
  }

  if (hasUsableValue('technicalIndicators.points')) {
    sections.push({
      id: 'technical_trend',
      type: 'trend-volume-combo',
      title: '价格走势与指标',
      dataKey: 'technicalIndicators.points',
      span: 8,
      height: 'large',
      encoding: { x: 'date', y: ['close', 'ma5', 'ma10', 'ma20'] },
    });
  } else if (hasUsableValue('kline.bars')) {
    sections.push({
      id: 'price_trend',
      type: 'trend-volume-combo',
      title: 'K 线价格走势',
      dataKey: 'kline.bars',
      span: 8,
      height: 'large',
      encoding: { x: 'date', y: ['close'] },
    });
  } else if (hasUsableValue('market.priceSeries')) {
    sections.push({
      id: 'price_trend',
      type: 'trend-volume-combo',
      title: 'K 线价格走势',
      dataKey: 'market.priceSeries',
      span: 8,
      height: 'large',
      encoding: { x: 'date', y: ['close'] },
    });
  }

  if (hasUsableValue('technicalIndicators.summary')) {
    sections.push({
      id: 'technical_summary',
      type: 'risk-ribbon',
      title: '技术指标摘要',
      dataKey: 'technicalIndicators.summary',
      span: 4,
      height: 'large',
    });
  } else if (getByPath(record, 'analysis.summary') !== undefined) {
    sections.push({
      id: 'analysis_summary',
      type: 'decision-brief',
      title: '分析结论',
      dataKey: 'analysis.summary',
      span: sections.some((section) => section.span === 8) ? 4 : 12,
      height: sections.some((section) => section.span === 8) ? 'large' : 'medium',
    });
  }

  if (hasUsableValue('fundamentalIndicators.summary')) {
    sections.push({
      id: 'fundamental_summary',
      type: 'valuation-temperature',
      title: '基本面指标',
      dataKey: 'fundamentalIndicators.summary',
      span: sections.some((section) => section.span === 8) ? 4 : 12,
      height: sections.some((section) => section.span === 8) ? 'large' : 'medium',
    });
  }

  if (Array.isArray(record.assets) || isRecord(record.comparison)) {
    sections.push({
      id: 'comparison_table',
      type: Array.isArray(record.assets) ? 'asset-ranking-matrix' : 'data-table',
      title: '多标的对比',
      dataKey: getByPath(record, 'comparison.rows') !== undefined ? 'comparison.rows' : 'assets',
      span: 12,
      height: 'medium',
    });
  }
  if (hasUsableValue('selectionRanking.rows')) {
    sections.push({
      id: 'selection_ranking',
      type: 'asset-ranking-matrix',
      title: '选股排名矩阵',
      dataKey: 'selectionRanking.rows',
      span: 6,
      height: 'medium',
      options: { scoreKey: 'composite_score' },
    });
  }
  if (hasUsableValue('financialQuality.rows')) {
    sections.push({
      id: 'financial_quality',
      type: 'financial-quality-matrix',
      title: '财务质量对比',
      dataKey: 'financialQuality.rows',
      span: 6,
      height: 'medium',
    });
  }
  if (hasUsableValue('portfolio')) {
    sections.push({
      id: 'portfolio_risk',
      type: 'risk-ribbon',
      title: '组合风险与仓位',
      dataKey: 'portfolio',
      span: 6,
      height: 'medium',
    });
  }
  if (hasUsableValue('holdings')) {
    sections.push({
      id: 'holdings_table',
      type: 'data-table',
      title: '持仓明细',
      dataKey: 'holdings',
      span: 6,
      height: 'medium',
    });
  }
  if (isRecord(record.backtest)) {
    const hasEquityCurve = hasUsableValue('backtest.equityCurve') || hasUsableValue('backtest.equity_curve');
    sections.push({
      id: 'backtest_equity_drawdown',
      type: hasEquityCurve ? 'equity-drawdown-combo' : 'drawdown-chart',
      title: '收益回撤',
      dataKey: hasEquityCurve ? 'backtest' : 'backtest.drawdown',
      span: 8,
      height: 'large',
    });
    sections.push({
      id: 'backtest_diagnostics',
      type: 'backtest-diagnostics',
      title: '回测诊断',
      dataKey: 'backtest',
      span: 4,
      height: 'large',
    });
  }
  if (getByPath(record, 'financials.reports') !== undefined) {
    sections.push({
      id: 'financial_reports',
      type: 'data-table',
      title: '财务报告趋势',
      dataKey: 'financials.reports',
      span: 12,
      height: 'medium',
    });
  }
  if (getByPath(record, 'liquidity.rows') !== undefined) {
    sections.push({
      id: 'liquidity_profile',
      type: 'asset-ranking-matrix',
      title: '流动性画像',
      dataKey: 'liquidity.rows',
      span: 4,
      height: 'medium',
      options: { scoreKey: 'liquidity_score' },
    });
  }
  if (getByPath(record, 'kline.bars') !== undefined && !sections.some((section) => section.dataKey === 'kline.bars')) {
    sections.push({
      id: 'kline_table',
      type: 'data-table',
      title: '近期 K 线明细',
      dataKey: 'kline.bars',
      span: 8,
      height: 'medium',
    });
  }
  if (getByPath(record, 'signals') !== undefined) {
    sections.push({
      id: 'signal_timeline',
      type: 'signal-timeline',
      title: '信号时间线',
      dataKey: 'signals',
      span: 6,
      height: 'medium',
    });
  }
  if (getByPath(record, 'analysis.summary') !== undefined && !sections.some((section) => section.dataKey === 'analysis.summary')) {
    sections.push({
      id: 'analysis_summary',
      type: 'decision-brief',
      title: '分析结论',
      dataKey: 'analysis.summary',
      span: 12,
      height: 'medium',
    });
  }
  if (!sections.length) {
    const fallbackKey = [
      'quote',
      'financials.reports',
      'fundamentalIndicators.summary',
      'kline.bars',
      'technicalIndicators.summary',
      'selectionRanking.rows',
      'comparison.rows',
      'assets',
      'portfolio',
      'holdings',
      'conclusion',
      'analysis',
      'summary',
    ].find((dataKey) => getByPath(record, dataKey) !== undefined);
    sections.push({
      id: 'raw_data',
      type: 'data-table',
      title: '数据摘要',
      dataKey: fallbackKey ?? 'summary',
      span: 12,
      height: 'medium',
    });
  }

  return {
    version: '1.0',
    page: {
      title,
      subtitle: String(visualization.subtitle ?? '由 QuantPilot 根据最终数据和视图配置安全渲染'),
      density: 'compact',
      theme: 'default',
    },
    layout: {
      type: 'grid',
      columns: 12,
      gap: 16,
    },
    sections,
  };
}

export function validateQuantViewConfig(
  config: unknown,
  dashboardData: unknown
): QuantViewConfigValidationIssue[] {
  const issues: QuantViewConfigValidationIssue[] = [];
  if (!isRecord(config)) {
    return [{ code: 'MODEL_OUTPUT_INVALID', message: 'view-config.json 必须是 JSON 对象。' }];
  }

  if (config.version !== '1.0') {
    issues.push({ code: 'SCHEMA_VALIDATION_FAILED', message: 'view-config.version 必须为 "1.0"。' });
  }

  const page = isRecord(config.page) ? config.page : null;
  if (!page || typeof page.title !== 'string' || !page.title.trim()) {
    issues.push({ code: 'SCHEMA_VALIDATION_FAILED', message: 'view-config.page.title 必须是非空字符串。' });
  }

  const layout = isRecord(config.layout) ? config.layout : null;
  if (!layout || layout.type !== 'grid' || layout.columns !== 12) {
    issues.push({ code: 'SCHEMA_VALIDATION_FAILED', message: 'view-config.layout 必须声明 type=grid 且 columns=12。' });
  }

  const sections = Array.isArray(config.sections) ? config.sections : null;
  if (!sections || sections.length === 0) {
    issues.push({ code: 'SCHEMA_VALIDATION_FAILED', message: 'view-config.sections 必须是非空数组。' });
    return issues;
  }
  if (sections.length > 12) {
    issues.push({ code: 'SCHEMA_VALIDATION_FAILED', message: 'view-config.sections 最多允许 12 个区块。' });
  }

  const ids = new Set<string>();
  sections.forEach((section, index) => {
    if (!isRecord(section)) {
      issues.push({ code: 'SCHEMA_VALIDATION_FAILED', message: `sections[${index}] 必须是对象。` });
      return;
    }

    const id = typeof section.id === 'string' ? section.id.trim() : '';
    if (!id) {
      issues.push({ code: 'SCHEMA_VALIDATION_FAILED', message: `sections[${index}].id 必须是非空字符串。` });
    } else if (ids.has(id)) {
      issues.push({ code: 'SCHEMA_VALIDATION_FAILED', message: `sections[${index}].id 重复：${id}。` });
    } else {
      ids.add(id);
    }

    if (!QUANT_ALLOWED_WIDGET_TYPES.includes(section.type as QuantWidgetType)) {
      issues.push({ code: 'UNSUPPORTED_WIDGET', message: `sections[${index}].type 不支持：${String(section.type)}。` });
    }

    if (!QUANT_ALLOWED_SECTION_SPANS.includes(section.span as QuantSectionSpan)) {
      issues.push({ code: 'SCHEMA_VALIDATION_FAILED', message: `sections[${index}].span 只能是 3、4、6、8、9、12。` });
    }

    if (!QUANT_ALLOWED_SECTION_HEIGHTS.includes(section.height as QuantSectionHeight)) {
      issues.push({ code: 'SCHEMA_VALIDATION_FAILED', message: `sections[${index}].height 只能是 small、medium、large、xlarge。` });
    }

    if (typeof section.title !== 'string' || !section.title.trim()) {
      issues.push({ code: 'SCHEMA_VALIDATION_FAILED', message: `sections[${index}].title 必须是非空字符串。` });
    }

    const dataKey = typeof section.dataKey === 'string' ? section.dataKey.trim() : '';
    if (!dataKey) {
      issues.push({ code: 'SCHEMA_VALIDATION_FAILED', message: `sections[${index}].dataKey 必须是非空字符串。` });
    } else if (getByPath(dashboardData, dataKey) === undefined) {
      issues.push({ code: 'DATA_KEY_MISSING', message: `sections[${index}].dataKey 找不到数据：${dataKey}。` });
    }
  });

  return issues;
}
