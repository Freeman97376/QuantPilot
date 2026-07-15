-- Tiered market-data universe used by the 5-minute dynamic daily snapshot job.
-- Membership is rebuilt by POST /api/v1/ingestion/active-pool/rebuild.

CREATE SCHEMA IF NOT EXISTS quant;

INSERT INTO quant.security_universes (
  id, name, description, status, source, tags, metadata
)
VALUES (
  'a-share-active-300',
  'A股活跃300',
  '由全市场日线流动性、强弱和趋势评分生成；人工置顶成员始终保留。',
  'active',
  'quantpilot-tiered-refresh',
  '["A股","活跃池","盘中快照"]'::jsonb,
  '{"default_timeframe":"daily","default_adjustment":"qfq","source_universe_id":"a-share-sample-research-pool","target_size":300,"retention_years":5}'::jsonb
)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  status = EXCLUDED.status,
  source = EXCLUDED.source,
  tags = EXCLUDED.tags,
  metadata = quant.security_universes.metadata || EXCLUDED.metadata,
  updated_at = now();
