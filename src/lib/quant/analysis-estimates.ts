import crypto from 'node:crypto';
import { prisma } from '@/lib/db/client';
import { Prisma } from '@/lib/db/types';
import { loadDesktopPreferences } from '@/lib/desktop/preferences';
import { isDesktopRuntime } from '@/lib/runtime/mode';
import type { StrategyDataProfileId } from '@/lib/quant/strategy-types';

const MARKET_API_BASE_URL =
  process.env.QUANTPILOT_MARKET_API_URL ||
  process.env.QUANTPILOT_MARKET_API_BASE_URL ||
  'http://127.0.0.1:8000';

type CoverageItem = {
  symbol: string;
  coveredBars: number;
  requiredBars: number;
  ready: boolean;
};

export interface MinuteAnalysisEstimate {
  estimateId: string;
  expiresAt: string;
  symbolCount: number;
  symbols: string[];
  profile: StrategyDataProfileId;
  period: string;
  historicalRange: string;
  provider: string[];
  paidPermissionRequired: boolean;
  coverage: CoverageItem[];
  requiresDownload: boolean;
  requiresConfirmation: boolean;
  estimatedTimeSeconds: number;
  estimatedDownloadBytes: number;
  estimatedDiskBytes: number;
  estimatedPeakMemoryBytes: number;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function minuteEstimateFingerprint(input: unknown): string {
  return crypto.createHash('sha256').update(stableJson(input)).digest('hex');
}

async function assertMinutePolicy(): Promise<void> {
  if (!isDesktopRuntime) return;
  const preferences = await loadDesktopPreferences();
  if (preferences.minuteDataPolicy === 'disabled') {
    throw new Error('分钟数据已在设置中禁用；QuantPilot 不会发起分钟请求。');
  }
  if (preferences.minuteDataPolicy === 'unset') {
    throw new Error('请先完成首次使用的分钟数据设置。');
  }
}

async function inspectCoverage(profile: StrategyDataProfileId, symbols: string[]) {
  const response = await fetch(`${MARKET_API_BASE_URL}/api/v1/ingestion/strategy-estimate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profile, symbols }),
    cache: 'no-store',
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`market API ${response.status}: ${body.slice(0, 260)}`);
  }
  return response.json() as Promise<{
    profile: {
      period: string;
      window_bars: number;
      provider_order: string[];
      paid_only: boolean;
    };
    items: Array<{
      symbol: string;
      covered_bars: number;
      required_bars: number;
      ready: boolean;
    }>;
    all_ready: boolean;
  }>;
}

export async function createMinuteAnalysisEstimate(params: {
  fingerprintInput: unknown;
  profile: StrategyDataProfileId;
  symbols: string[];
}): Promise<MinuteAnalysisEstimate> {
  await assertMinutePolicy();
  const symbols = [...new Set(params.symbols.map((symbol) => symbol.trim().toUpperCase()))].slice(0, 20);
  const inspected = await inspectCoverage(params.profile, symbols);
  const coverage = inspected.items.map((item) => ({
    symbol: item.symbol,
    coveredBars: item.covered_bars,
    requiredBars: item.required_bars,
    ready: item.ready,
  }));
  const missingRows = coverage.reduce(
    (total, item) => total + Math.max(0, item.requiredBars - item.coveredBars),
    0
  );
  const missingSymbols = coverage.filter((item) => !item.ready).length;
  const estimatedDownloadBytes = missingRows * 160;
  const estimatedDiskBytes = Math.ceil(missingRows * 96 * 1.25);
  const estimatedPeakMemoryBytes = Math.max(64 * 1024 * 1024, missingRows * 320);
  const estimatedTimeSeconds = missingRows === 0
    ? 0
    : Math.max(3, Math.ceil(missingSymbols * 1.5 + missingRows / 8_000));
  const estimateId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
  const estimate: MinuteAnalysisEstimate = {
    estimateId,
    expiresAt: expiresAt.toISOString(),
    symbolCount: symbols.length,
    symbols,
    profile: params.profile,
    period: inspected.profile.period,
    historicalRange: `up to ${inspected.profile.window_bars} bars per symbol`,
    provider: inspected.profile.provider_order,
    paidPermissionRequired: inspected.profile.paid_only,
    coverage,
    requiresDownload: !inspected.all_ready,
    requiresConfirmation: !inspected.all_ready,
    estimatedTimeSeconds,
    estimatedDownloadBytes,
    estimatedDiskBytes,
    estimatedPeakMemoryBytes,
  };
  await prisma.analysisEstimate.create({
    data: {
      id: estimateId,
      kind: 'minute-analysis',
      fingerprint: minuteEstimateFingerprint(params.fingerprintInput),
      payload: estimate as unknown as Prisma.InputJsonValue,
      expiresAt,
    },
  });
  return estimate;
}

export async function consumeMinuteAnalysisEstimate(params: {
  estimateId: string;
  confirmed: boolean;
  fingerprintInput: unknown;
}): Promise<void> {
  if (!params.confirmed) throw new Error('Actual minute downloads require explicit confirmation.');
  const estimate = await prisma.analysisEstimate.findUnique({ where: { id: params.estimateId } });
  if (
    !estimate || estimate.kind !== 'minute-analysis' || estimate.consumedAt ||
    estimate.expiresAt.getTime() <= Date.now() ||
    estimate.fingerprint !== minuteEstimateFingerprint(params.fingerprintInput)
  ) {
    throw new Error('The minute-data estimate is invalid or expired. Please estimate again.');
  }
  await assertMinutePolicy();
  const consumed = await prisma.analysisEstimate.updateMany({
    where: { id: estimate.id, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  if (consumed.count !== 1) {
    throw new Error('The minute-data estimate has already been used. Please estimate again.');
  }
}
