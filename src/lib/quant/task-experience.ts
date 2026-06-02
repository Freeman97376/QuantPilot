import type { ProjectStatus } from '@/types/project';
import type { QuantCapabilityId } from '@/lib/quant/capabilities';

type TaskTemplate = {
  title: string;
  prompt: string;
};

type RoleExperience = {
  inputHint: string;
  outputHint: string;
  templates: TaskTemplate[];
};

type TaskVisualState = {
  label: string;
  description: string;
  className: string;
  dotClassName: string;
};

const ROLE_EXPERIENCE: Record<QuantCapabilityId, RoleExperience> = {
  portfolio_risk: {
    inputHint: '持仓截图、股票代码、成本、仓位、可用资金或调仓约束',
    outputHint: '仓位集中度、盈亏结构、回撤风险、调仓约束和风险建议',
    templates: [
      { title: '分析持仓风险', prompt: '我上传了一张持仓截图，请分析仓位集中度、盈亏结构、回撤风险和可调整空间。' },
      { title: '降低回撤', prompt: '请根据我的持仓，找出导致组合回撤扩大的主要标的，并给出降低波动的调仓思路。' },
      { title: '现金约束调仓', prompt: '在不追加资金的情况下，请分析当前持仓如何调整能降低集中度和单票风险。' },
    ],
  },
  asset_comparison: {
    inputHint: '候选股票、行业方向、筛选条件、估值或流动性偏好',
    outputHint: '趋势、估值、财务质量、流动性、风险点和候选排序',
    templates: [
      { title: '比较两只股票', prompt: '比较 600519 和 000858 的趋势、估值、财务质量和主要风险，给出更适合观察的标的。' },
      { title: '行业候选筛选', prompt: '从新能源方向中筛选 5 个流动性较好、估值相对合理的候选标的，并说明筛选依据。' },
      { title: '低估值对比', prompt: '帮我比较银行板块中估值较低的股票，重点看 PB、ROE、分红和风险暴露。' },
    ],
  },
  stock_diagnosis: {
    inputHint: '股票名称或代码，以及关注的行情、财务、公告或风险问题',
    outputHint: '行情诊断、K 线趋势、财务指标、公告事件、风险提示和看板',
    templates: [
      { title: '诊断个股', prompt: '诊断 300750 近期走势，结合行情、K 线、成交量、财务和公告事件说明主要风险。' },
      { title: '短线走势', prompt: '分析 600519 最近 60 个交易日的趋势、均线、量价和关键支撑压力位。' },
      { title: '事件影响', prompt: '结合最近公告和财务数据，分析某只股票近期波动背后的可能原因。' },
    ],
  },
  technical_analysis: {
    inputHint: '标的、时间范围、均线/成交量/波动率/触发条件',
    outputHint: '趋势结构、均线状态、量价信号、回撤和触发条件',
    templates: [
      { title: '技术择时', prompt: '分析 510300 最近一年的技术择时信号，包括均线结构、成交量、回撤和可能触发条件。' },
      { title: '均线信号', prompt: '对 600519 做 20 日和 60 日均线择时分析，说明信号有效性和风险限制。' },
      { title: '量价背离', prompt: '检查 300750 最近 120 个交易日是否存在量价背离、趋势衰减或异常放量。' },
    ],
  },
  fundamental_analysis: {
    inputHint: '公司、行业、财务年份、估值指标或经营质量问题',
    outputHint: '盈利质量、现金流、ROE、成长性、估值情景和公告事件',
    templates: [
      { title: '基本面研究', prompt: '研究 600519 的盈利质量、现金流、ROE、估值水平和未来主要风险。' },
      { title: '财务质量', prompt: '分析某公司的营收、利润、毛利率、现金流和负债变化，判断经营质量是否改善。' },
      { title: '估值情景', prompt: '基于近几年财务数据，为一家公司做乐观、中性、保守三种估值情景。' },
    ],
  },
  backtest_review: {
    inputHint: '策略规则、标的池、时间窗口、参数范围和交易成本假设',
    outputHint: '回测规则、样本说明、收益回撤、参数敏感性和风控限制',
    templates: [
      { title: '双均线回测', prompt: '用 510300 从 2021 到 2025 年回测 20/60 日双均线策略，包含收益、回撤和交易次数。' },
      { title: '参数扫描', prompt: '对沪深 300 ETF 做均线参数扫描，比较不同快慢线组合的收益和最大回撤。' },
      { title: '策略复盘', prompt: '拆解一个月度调仓策略的信号、样本、交易成本和可能过拟合风险。' },
    ],
  },
  sector_rotation: {
    inputHint: '行业、指数、ETF、轮动周期、宏观变量或资金流线索',
    outputHint: '行业强弱、轮动信号、资金变化、风险暴露和候选配置方向',
    templates: [
      { title: '行业轮动', prompt: '分析最近 6 个月主要行业的强弱变化、资金流和轮动迹象，给出值得继续观察的方向。' },
      { title: 'ETF 轮动', prompt: '比较主要宽基和行业 ETF 的趋势、成交额、回撤和相对强弱，做一个轮动观察清单。' },
      { title: '板块风险', prompt: '分析当前新能源、消费、金融和科技板块的趋势分化与主要风险。' },
    ],
  },
  strategy_research: {
    inputHint: '策略想法、因子假设、调仓频率、样本范围和验证目标',
    outputHint: '策略假设、数据需求、验证路径、风险点和可回测实现建议',
    templates: [
      { title: '研究策略想法', prompt: '我想研究一个低估值高分红策略，请拆解信号、数据需求、回测口径和主要风险。' },
      { title: '因子假设验证', prompt: '帮我设计一个验证动量因子有效性的研究方案，包含样本、调仓频率、指标和风险控制。' },
      { title: '策略改进', prompt: '分析一个已有策略可能过拟合的地方，并提出更稳健的验证和改进方案。' },
    ],
  },
};

const FALLBACK_EXPERIENCE = ROLE_EXPERIENCE.stock_diagnosis;

const getRoleExperience = (capabilityId?: QuantCapabilityId | null) =>
  (capabilityId && ROLE_EXPERIENCE[capabilityId]) || FALLBACK_EXPERIENCE;

const getTaskVisualState = ({
  status,
  hasPreview,
  validationState,
  isRunning,
}: {
  status?: ProjectStatus | string | null;
  hasPreview?: boolean;
  validationState?: 'unknown' | 'running' | 'passed' | 'failed';
  isRunning?: boolean;
}): TaskVisualState => {
  if (isRunning || status === 'running' || status === 'building') {
    return {
      label: '生成中',
      description: 'Agent 正在执行任务',
      className: 'border-blue-200 bg-blue-50 text-blue-700',
      dotClassName: 'bg-blue-500',
    };
  }

  if (validationState === 'running') {
    return {
      label: '验证中',
      description: '正在检查看板和数据产物',
      className: 'border-blue-200 bg-blue-50 text-blue-700',
      dotClassName: 'bg-blue-500',
    };
  }

  if (validationState === 'failed' || status === 'failed' || status === 'error') {
    return {
      label: '需处理',
      description: '任务或自动验证未通过',
      className: 'border-red-200 bg-red-50 text-red-700',
      dotClassName: 'bg-red-500',
    };
  }

  if (validationState === 'passed') {
    return {
      label: '验证通过',
      description: hasPreview ? '看板已就绪' : '可打开预览',
      className: 'border-emerald-200 bg-emerald-50 text-emerald-700',
      dotClassName: 'bg-emerald-500',
    };
  }

  if (hasPreview || status === 'preview_running') {
    return {
      label: '可查看',
      description: '已生成预览看板',
      className: 'border-emerald-200 bg-emerald-50 text-emerald-700',
      dotClassName: 'bg-emerald-500',
    };
  }

  if (status === 'initializing' || status === 'idle') {
    return {
      label: '准备中',
      description: '正在准备工作区',
      className: 'border-amber-200 bg-amber-50 text-amber-700',
      dotClassName: 'bg-amber-500',
    };
  }

  return {
    label: '进行中',
    description: '可继续对话推进任务',
    className: 'border-slate-200 bg-slate-50 text-slate-600',
    dotClassName: 'bg-slate-400',
  };
};

export { getRoleExperience, getTaskVisualState };
export type { RoleExperience, TaskTemplate, TaskVisualState };
