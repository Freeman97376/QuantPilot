import { getRuntimeDegradationConfig } from '@/lib/config/degradation';
import type {
  StrategyDataProfileId,
  StrategyDataProfileInfo,
  StrategyRefreshItem,
  StrategyRefreshResponse,
} from '@/lib/quant/strategy-types';

const MARKET_API_BASE_URL =
  process.env.QUANTPILOT_MARKET_API_URL ||
  process.env.QUANTPILOT_MARKET_API_BASE_URL ||
  'http://127.0.0.1:8000';

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  return null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function mapStrategyDataProfile(value: unknown): StrategyDataProfileInfo {
  const record = asRecord(value);
  const storage = asString(record.storage, 'redis');
  return {
    id: asString(record.id, 'daily_eod') as StrategyDataProfileId,
    label: asString(record.label),
    description: asString(record.description),
    period: asString(record.period, 'daily'),
    windowBars: asNumber(record.window_bars) ?? 0,
    maxStalenessSeconds: asNumber(record.max_staleness_seconds) ?? 0,
    maxSymbols: asNumber(record.max_symbols) ?? 0,
    providerOrder: asStringArray(record.provider_order),
    storage: storage === 'timescaledb' || storage === 'timescaledb-daily' || storage === 'timescaledb-minute'
      ? storage
      : 'redis',
    paidOnly: asBoolean(record.paid_only) ?? false,
    retentionDays: asNumber(record.retention_days),
  };
}

function mapStrategyRefreshItem(value: unknown): StrategyRefreshItem {
  const record = asRecord(value);
  const status = asString(record.status, 'unavailable');
  const indicators = Object.fromEntries(
    Object.entries(asRecord(record.indicators)).filter(
      (entry): entry is [string, number | string | boolean | null] => {
        const scalar = entry[1];
        return scalar === null || ['number', 'string', 'boolean'].includes(typeof scalar);
      }
    )
  );
  return {
    symbol: asString(record.symbol),
    name: typeof record.name === 'string' ? record.name : null,
    status: status === 'ready' || status === 'refreshed' || status === 'degraded'
      ? status
      : 'unavailable',
    period: asString(record.period),
    requestedBars: asNumber(record.requested_bars) ?? 0,
    returnedBars: asNumber(record.returned_bars) ?? 0,
    source: typeof record.source === 'string' ? record.source : null,
    storage: asString(record.storage),
    asOf: typeof record.as_of === 'string' ? record.as_of : null,
    fetchedAt: typeof record.fetched_at === 'string' ? record.fetched_at : null,
    cacheStatus: asString(record.cache_status, 'disabled'),
    stale: asBoolean(record.stale) ?? false,
    ageSeconds: asNumber(record.age_seconds),
    missingFields: asStringArray(record.missing_fields),
    warnings: asStringArray(record.warnings),
    error: typeof record.error === 'string' ? record.error : null,
    indicators,
  };
}

function mapStrategyRefreshResponse(value: unknown): StrategyRefreshResponse {
  const record = asRecord(value);
  const status = asString(record.status, 'unavailable');
  return {
    status: status === 'ready' || status === 'refreshed' || status === 'partial'
      ? status
      : 'unavailable',
    profile: mapStrategyDataProfile(record.profile),
    jobId: asString(record.job_id),
    universeId: typeof record.universe_id === 'string' ? record.universe_id : null,
    items: Array.isArray(record.items) ? record.items.map(mapStrategyRefreshItem) : [],
    fetchedAt: asString(record.fetched_at, new Date().toISOString()),
    warnings: asStringArray(record.warnings),
  };
}

export async function refreshStrategyData(params: {
  profile: StrategyDataProfileId;
  symbols: string[];
  universeId?: string;
  force?: boolean;
  timeoutMs?: number;
}): Promise<StrategyRefreshResponse> {
  if (!getRuntimeDegradationConfig().components.marketApi.enabled) {
    throw new Error('market API 已按降级配置停用');
  }
  const controller = new AbortController();
  const timeoutMs = params.timeoutMs ?? 65_000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${MARKET_API_BASE_URL}/api/v1/ingestion/strategy-refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        profile: params.profile,
        symbols: params.symbols.map((symbol) => symbol.trim()).filter(Boolean).slice(0, 20),
        universe_id: params.universeId?.trim() || null,
        force: params.force ?? false,
      }),
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`market API ${response.status}: ${body.slice(0, 260)}`);
    }
    return mapStrategyRefreshResponse(await response.json());
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`market API timeout after ${timeoutMs}ms: strategy refresh`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
