import type {
  StrategyMarketDataReadiness,
  StrategyMarketProviderState,
} from './strategy-types';
import { marketApiFetch } from './market-api-client';

const DEFAULT_UNIVERSE_ID = 'a-share-sample-research-pool';

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function mapProvider(value: unknown): StrategyMarketProviderState {
  const record = asRecord(value);
  const status = record.status === 'ready' || record.status === 'error'
    ? record.status
    : 'unknown';
  return {
    provider: asString(record.provider, 'unknown'),
    capability: asString(record.capability, 'unknown'),
    status,
    successCount: asNumber(record.success_count),
    failureCount: asNumber(record.failure_count),
    rowCount: asNumber(record.row_count),
    symbolCount: asNumber(record.symbol_count),
    firstTs: typeof record.first_ts === 'string' ? record.first_ts : null,
    lastTs: typeof record.last_ts === 'string' ? record.last_ts : null,
    lastSuccessAt: typeof record.last_success_at === 'string' ? record.last_success_at : null,
    lastFailureAt: typeof record.last_failure_at === 'string' ? record.last_failure_at : null,
    lastError: typeof record.last_error === 'string' ? record.last_error : null,
    metadata: asRecord(record.metadata),
  };
}

function fallbackReadiness(universeId: string, error: unknown): StrategyMarketDataReadiness {
  return {
    runtimeMode: 'unknown',
    engine: 'unknown',
    universeId,
    sourcePolicy: {
      catalog: 'eastmoney',
      historyPrimary: 'baostock',
      historyFallback: 'akshare',
      realtime: 'eastmoney',
      realtimeScope: 'candidate-detail-only',
    },
    storage: {
      status: 'unknown',
      engine: 'unknown',
      databaseFile: null,
      databaseSizeBytes: 0,
      freeDiskBytes: 0,
      writable: false,
      schemaVersion: 0,
    },
    providers: [],
    coverage: {
      total: 0,
      missing: 0,
      partial: 0,
      stale: 0,
      ready: 0,
      rowCount: 0,
      lookbackYears: 5,
      latestTs: null,
    },
    fetchedAt: new Date().toISOString(),
    error: error instanceof Error ? error.message : String(error),
  };
}

export function mapStrategyMarketDataReadiness(value: unknown): StrategyMarketDataReadiness {
  const record = asRecord(value);
  const policy = asRecord(record.source_policy);
  const storage = asRecord(record.storage);
  const coverage = asRecord(record.coverage);
  const runtimeMode = record.runtime_mode === 'desktop' || record.runtime_mode === 'server'
    ? record.runtime_mode
    : 'unknown';
  return {
    runtimeMode,
    engine: asString(record.engine, 'unknown'),
    universeId: asString(record.universe_id, DEFAULT_UNIVERSE_ID),
    sourcePolicy: {
      catalog: asString(policy.catalog, 'eastmoney'),
      historyPrimary: asString(policy.history_primary, 'baostock'),
      historyFallback: asString(policy.history_fallback, 'akshare'),
      realtime: asString(policy.realtime, 'eastmoney'),
      realtimeScope: asString(policy.realtime_scope, 'candidate-detail-only'),
    },
    storage: {
      status: asString(storage.status, 'unknown'),
      engine: asString(storage.engine, asString(record.engine, 'unknown')),
      databaseFile: typeof storage.database_file === 'string' ? storage.database_file : null,
      databaseSizeBytes: asNumber(storage.database_size_bytes),
      freeDiskBytes: asNumber(storage.free_disk_bytes),
      writable: storage.writable === true,
      schemaVersion: asNumber(storage.schema_version),
    },
    providers: Array.isArray(record.providers) ? record.providers.map(mapProvider) : [],
    coverage: {
      total: asNumber(coverage.total),
      missing: asNumber(coverage.missing),
      partial: asNumber(coverage.partial),
      stale: asNumber(coverage.stale),
      ready: asNumber(coverage.ready),
      rowCount: asNumber(coverage.row_count),
      lookbackYears: asNumber(coverage.lookback_years) || 5,
      latestTs: typeof coverage.latest_ts === 'string' ? coverage.latest_ts : null,
    },
    fetchedAt: asString(record.fetched_at, new Date().toISOString()),
    error: null,
  };
}

export async function getStrategyMarketDataReadiness(
  universeId = DEFAULT_UNIVERSE_ID,
  timeoutMs = 4_000
): Promise<StrategyMarketDataReadiness> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException('market readiness timeout', 'TimeoutError')),
    timeoutMs
  );
  try {
    const response = await marketApiFetch(
      `/api/v1/market-data/readiness?universe_id=${encodeURIComponent(universeId)}`,
      { cache: 'no-store', signal: controller.signal }
    );
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`market API ${response.status}: ${detail.slice(0, 240)}`);
    }
    return mapStrategyMarketDataReadiness(await response.json());
  } catch (error) {
    return fallbackReadiness(universeId, error);
  } finally {
    clearTimeout(timer);
  }
}
