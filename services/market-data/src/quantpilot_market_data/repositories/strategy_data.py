from __future__ import annotations

import shutil
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from psycopg.rows import dict_row

from quantpilot_market_data.database_core import ROOT_DIR, connect

ACTIVE_UNIVERSE_ID = "a-share-active-300"
DEFAULT_SOURCE_UNIVERSE_ID = "a-share-sample-research-pool"


async def refresh_active_universe(
    *,
    source_universe_id: str = DEFAULT_SOURCE_UNIVERSE_ID,
    active_universe_id: str = ACTIVE_UNIVERSE_ID,
    limit: int = 300,
) -> dict[str, Any]:
    normalized_limit = max(1, min(limit, 500))
    async with await connect() as connection, connection.cursor(row_factory=dict_row) as cursor:
        await cursor.execute(
            """
            INSERT INTO quant.security_universes (
              id, name, description, status, source, tags, metadata, created_at, updated_at
            )
            VALUES (
              %s,
              'A股活跃300',
              '由全市场日线的流动性、强弱和趋势评分生成；人工置顶标的始终保留。',
              'active',
              'quantpilot-tiered-refresh',
              '["A股","活跃池","盘中快照"]'::jsonb,
              jsonb_build_object(
                'default_timeframe', 'daily',
                'default_adjustment', 'qfq',
                'source_universe_id', %s,
                'target_size', %s,
                'refreshed_at', now()
              ),
              now(),
              now()
            )
            ON CONFLICT (id) DO UPDATE SET
              description = EXCLUDED.description,
              source = EXCLUDED.source,
              tags = EXCLUDED.tags,
              metadata = quant.security_universes.metadata || EXCLUDED.metadata,
              updated_at = now()
            """,
            (active_universe_id, source_universe_id, normalized_limit),
        )
        await cursor.execute(
            """
            DELETE FROM quant.security_universe_members
            WHERE universe_id = %s
              AND COALESCE(role, 'member') <> 'pinned'
            """,
            (active_universe_id,),
        )
        await cursor.execute(
            """
            WITH source_symbols AS (
              SELECT members.symbol
              FROM quant.security_universe_members members
              JOIN quant.securities securities ON securities.symbol = members.symbol
              WHERE members.universe_id = %s
                AND COALESCE(members.role, 'member') <> 'inactive'
                AND COALESCE(securities.status, 'active') = 'active'
                AND securities.asset_type = 'stock'
            ),
            ranked_bars AS (
              SELECT
                bars.symbol,
                bars.ts,
                bars.close,
                bars.amount,
                bars.turnover,
                row_number() OVER (PARTITION BY bars.symbol ORDER BY bars.ts DESC) AS recency
              FROM quant.stock_bars bars
              JOIN source_symbols source ON source.symbol = bars.symbol
              WHERE bars.timeframe = 'daily'
                AND bars.adjustment = 'qfq'
            ),
            metrics AS (
              SELECT
                symbol,
                (array_agg(close ORDER BY ts DESC) FILTER (WHERE recency = 1))[1] AS latest_close,
                (array_agg(amount ORDER BY ts DESC) FILTER (WHERE recency = 1))[1] AS latest_amount,
                (
                  array_agg(turnover ORDER BY ts DESC) FILTER (WHERE recency = 1)
                )[1] AS latest_turnover,
                avg(amount) FILTER (WHERE recency <= 20 AND amount IS NOT NULL) AS avg_amount_20d,
                avg(close) FILTER (WHERE recency <= 20) AS ma20,
                (array_agg(close ORDER BY ts ASC) FILTER (WHERE recency <= 20))[1] AS close_20d,
                max(ts) AS latest_ts,
                count(*) FILTER (WHERE recency <= 60) AS sample_count
              FROM ranked_bars
              WHERE recency <= 60
              GROUP BY symbol
            ),
            scored AS (
              SELECT
                metrics.*,
                (
                  ln(GREATEST(COALESCE(metrics.avg_amount_20d, 0), 0) + 1)
                  + LEAST(GREATEST(COALESCE(metrics.latest_turnover, 0), 0), 30) * 0.08
                  + CASE
                      WHEN metrics.close_20d > 0
                      THEN LEAST(GREATEST(
                        ((metrics.latest_close / metrics.close_20d) - 1) * 100,
                        -30
                      ), 60) * 0.04
                      ELSE 0
                    END
                  + CASE WHEN metrics.latest_close >= metrics.ma20 THEN 1.5 ELSE 0 END
                ) AS activity_score
              FROM metrics
              WHERE metrics.sample_count >= 20
                AND metrics.latest_amount IS NOT NULL
            ),
            pinned AS (
              SELECT count(*)::INT AS pinned_count
              FROM quant.security_universe_members
              WHERE universe_id = %s AND role = 'pinned'
            ),
            candidates AS (
              SELECT
                scored.*,
                row_number() OVER (
                  ORDER BY activity_score DESC, avg_amount_20d DESC NULLS LAST, symbol
                ) AS candidate_rank
              FROM scored
              WHERE NOT EXISTS (
                SELECT 1
                FROM quant.security_universe_members active_members
                WHERE active_members.universe_id = %s
                  AND active_members.symbol = scored.symbol
                  AND active_members.role = 'pinned'
              )
            )
            INSERT INTO quant.security_universe_members (
              universe_id, symbol, role, weight, metadata, added_at
            )
            SELECT
              %s,
              candidates.symbol,
              'member',
              NULL,
              jsonb_build_object(
                'order', candidates.candidate_rank + pinned.pinned_count,
                'activity_score', round(candidates.activity_score::numeric, 6),
                'avg_amount_20d', candidates.avg_amount_20d,
                'latest_turnover', candidates.latest_turnover,
                'latest_ts', candidates.latest_ts,
                'added_source', 'daily-liquidity-strategy-score'
              ),
              now()
            FROM candidates
            CROSS JOIN pinned
            WHERE candidates.candidate_rank <= GREATEST(%s - pinned.pinned_count, 0)
            ON CONFLICT (universe_id, symbol) DO UPDATE SET
              role = CASE
                WHEN quant.security_universe_members.role = 'pinned' THEN 'pinned'
                ELSE EXCLUDED.role
              END,
              metadata = quant.security_universe_members.metadata || EXCLUDED.metadata
            """,
            (
                source_universe_id,
                active_universe_id,
                active_universe_id,
                active_universe_id,
                normalized_limit,
            ),
        )
        await cursor.execute(
            """
            SELECT
              count(*)::INT AS member_count,
              count(*) FILTER (WHERE role = 'pinned')::INT AS pinned_count
            FROM quant.security_universe_members
            WHERE universe_id = %s
              AND COALESCE(role, 'member') <> 'inactive'
            """,
            (active_universe_id,),
        )
        row = await cursor.fetchone()

    return {
        "universe_id": active_universe_id,
        "source_universe_id": source_universe_id,
        "member_count": int(row["member_count"] or 0) if row else 0,
        "pinned_count": int(row["pinned_count"] or 0) if row else 0,
        "limit": normalized_limit,
        "refreshed_at": datetime.now(UTC),
    }


async def apply_strategy_data_retention() -> dict[str, int]:
    async with await connect() as connection, connection.cursor() as cursor:
        await cursor.execute(
            """
            DELETE FROM quant.stock_bars bars
            WHERE bars.timeframe LIKE 'minute%%'
              AND bars.ts < now() - interval '90 days'
            """
        )
        minute_deleted = cursor.rowcount
        await cursor.execute(
            """
            DELETE FROM quant.stock_bars bars
            WHERE bars.timeframe = 'daily'
              AND bars.ts < now() - interval '3 years'
              AND NOT EXISTS (
                SELECT 1
                FROM quant.security_universe_members members
                WHERE members.symbol = bars.symbol
                  AND members.universe_id = %s
                  AND COALESCE(members.role, 'member') <> 'inactive'
              )
            """,
            (ACTIVE_UNIVERSE_ID,),
        )
        daily_deleted = cursor.rowcount
        await cursor.execute(
            """
            DELETE FROM quant.stock_bars bars
            WHERE bars.timeframe = 'daily'
              AND bars.ts < now() - interval '5 years'
            """
        )
        extended_deleted = cursor.rowcount
    return {
        "minute_rows_deleted": max(0, minute_deleted),
        "daily_rows_deleted": max(0, daily_deleted + extended_deleted),
    }


async def get_strategy_data_audit(*, run_retention: bool = False) -> dict[str, Any]:
    retention = await apply_strategy_data_retention() if run_retention else {}
    async with await connect() as connection, connection.cursor(row_factory=dict_row) as cursor:
        await cursor.execute(
            """
            SELECT
              timeframe,
              count(*)::BIGINT AS row_count,
              count(DISTINCT symbol)::INT AS symbol_count,
              min(ts) AS first_ts,
              max(ts) AS last_ts,
              count(*) FILTER (WHERE amount IS NULL)::BIGINT AS missing_amount_rows,
              count(*) FILTER (WHERE turnover IS NULL)::BIGINT AS missing_turnover_rows
            FROM quant.stock_bars
            GROUP BY timeframe
            ORDER BY timeframe
            """
        )
        coverage = [dict(row) for row in await cursor.fetchall()]
        await cursor.execute(
            """
            SELECT
              count(*)::INT AS member_count,
              count(*) FILTER (WHERE role = 'pinned')::INT AS pinned_count
            FROM quant.security_universe_members
            WHERE universe_id = %s
              AND COALESCE(role, 'member') <> 'inactive'
            """,
            (ACTIVE_UNIVERSE_ID,),
        )
        active_pool = dict(await cursor.fetchone() or {})

    disk = shutil.disk_usage(Path(ROOT_DIR))
    used_percent = round((disk.used / disk.total) * 100, 2) if disk.total else 0.0
    return {
        "status": "paused" if used_percent >= 80 else "warning" if used_percent >= 70 else "ok",
        "disk": {
            "total_bytes": disk.total,
            "used_bytes": disk.used,
            "free_bytes": disk.free,
            "used_percent": used_percent,
            "warn_at_percent": 70,
            "pause_minute_persistence_at_percent": 80,
        },
        "active_pool": active_pool,
        "coverage": coverage,
        "retention": retention,
        "checked_at": datetime.now(UTC),
    }
