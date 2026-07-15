#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

# Safe server update + stock-data health report.
# This wrapper deliberately delegates deployment to quantpilot-maintain and only
# performs read-only SQL after the services have restarted successfully.

APP_DIR="${QUANTPILOT_APP_DIR:-/opt/quantpilot}"
ENV_FILE="${QUANTPILOT_ENV_FILE:-${APP_DIR}/.env.production}"
MODE="${1:-update}"

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

die() {
  log "ERROR: $*"
  exit 1
}

usage() {
  cat <<'EOF'
Usage: quantpilot-update-health.sh [update|health]

  update  Safely pull/build/restart through quantpilot-maintain, then report
          stock-data health (default).
  health  Do not pull or restart; only check services and query data health.

Optional environment variables:
  QUANTPILOT_APP_DIR=/opt/quantpilot
  QUANTPILOT_ENV_FILE=/opt/quantpilot/.env.production
EOF
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "Missing command: $1"
}

require_layout() {
  [[ ${EUID} -ne 0 ]] || die 'Run as the normal deployment user (usually ubuntu), not root.'
  [[ -d "${APP_DIR}/.git" ]] || die "Git repository not found: ${APP_DIR}"
  [[ -f "${ENV_FILE}" ]] || die "Environment file not found: ${ENV_FILE}"
  [[ -f "${APP_DIR}/docker-compose.yml" ]] || die 'docker-compose.yml is missing.'
  [[ -f "${APP_DIR}/deploy/server/docker-compose.server.yml" ]] || die 'Server Compose override is missing.'
  require_command docker
  require_command curl
  require_command systemctl
  docker compose version >/dev/null
}

load_environment() {
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
  export NODE_ENV=production
  export QUANTPILOT_DEPLOYMENT=server
}

compose() {
  docker compose \
    --env-file "${ENV_FILE}" \
    -f "${APP_DIR}/docker-compose.yml" \
    -f "${APP_DIR}/deploy/server/docker-compose.server.yml" \
    "$@"
}

run_update() {
  log 'Running the repository maintenance workflow...'
  if command -v quantpilot-maintain >/dev/null 2>&1; then
    quantpilot-maintain update
    return
  fi

  local repository_script="${APP_DIR}/deploy/server/quantpilot-maintain.sh"
  [[ -f ${repository_script} ]] || die 'quantpilot-maintain is not installed and the repository script is missing.'
  bash "${repository_script}" update
}

wait_for_http() {
  local name=$1
  local url=$2
  local attempt
  for attempt in {1..30}; do
    if curl --noproxy '*' -fsS --max-time 8 -o /dev/null "${url}"; then
      log "${name}: OK (${url})"
      return 0
    fi
    sleep 2
  done
  die "${name} health check failed: ${url}"
}

psql_query() {
  local title=$1
  local query=$2
  printf '\n===== %s =====\n' "${title}"
  compose exec -T timescaledb \
    psql -X \
    -U "${POSTGRES_USER:-quantpilot}" \
    -d "${POSTGRES_DB:-quantpilot}" \
    -v ON_ERROR_STOP=1 \
    -P pager=off \
    -P 'null=[NULL]' \
    -c "${query}"
}

psql_value() {
  local query=$1
  compose exec -T timescaledb \
    psql -X -A -t \
    -U "${POSTGRES_USER:-quantpilot}" \
    -d "${POSTGRES_DB:-quantpilot}" \
    -v ON_ERROR_STOP=1 \
    -c "${query}" | tr -d '[:space:]'
}

run_service_checks() {
  log 'Checking Docker and systemd services...'
  compose ps timescaledb redis
  compose exec -T timescaledb \
    pg_isready \
    -U "${POSTGRES_USER:-quantpilot}" \
    -d "${POSTGRES_DB:-quantpilot}" >/dev/null
  compose exec -T redis redis-cli --raw ping | grep -qx 'PONG'
  systemctl is-active --quiet quantpilot-market-data
  systemctl is-active --quiet quantpilot-web

  local market_url="http://127.0.0.1:${QUANTPILOT_MARKET_PORT:-8000}"
  local web_url="http://127.0.0.1:${WEB_PORT:-3000}${NEXT_PUBLIC_BASE_PATH:-/smartstock}"
  wait_for_http 'market-data' "${market_url}/health"
  wait_for_http 'smart-strategy' "${web_url}/smart-strategy"
}

run_data_health() {
  local total_rows
  total_rows="$(psql_value "SELECT count(*) FROM quant.stock_bars;")"
  [[ ${total_rows} =~ ^[0-9]+$ ]] || die "Unexpected stock_bars count: ${total_rows}"
  (( total_rows > 0 )) || die 'quant.stock_bars is empty.'

  psql_query 'Database and stock-bar overview' "
SELECT
  current_database() AS database,
  pg_size_pretty(pg_database_size(current_database())) AS database_size,
  count(*) AS total_rows,
  count(DISTINCT symbol) AS symbols,
  min(ts) AS first_ts,
  max(ts) AS latest_ts,
  count(*) FILTER (WHERE timeframe = 'daily') AS daily_rows,
  count(*) FILTER (WHERE timeframe LIKE 'minute%') AS minute_rows
FROM quant.stock_bars;"

  psql_query 'Freshness by timeframe, adjustment, and provider' "
SELECT
  timeframe,
  adjustment,
  provider,
  count(*) AS rows,
  count(DISTINCT symbol) AS symbols,
  min(ts) AS first_ts,
  max(ts) AS latest_ts
FROM quant.stock_bars
GROUP BY timeframe, adjustment, provider
ORDER BY timeframe, adjustment, provider;"

  psql_query 'Daily qfq field completeness' "
SELECT
  count(*) AS rows,
  count(amount) AS amount_rows,
  round(100.0 * count(amount) / NULLIF(count(*), 0), 2) AS amount_pct,
  count(turnover) AS turnover_rows,
  round(100.0 * count(turnover) / NULLIF(count(*), 0), 2) AS turnover_pct,
  count(trade_status) AS trade_status_rows,
  count(is_st) AS is_st_rows
FROM quant.stock_bars
WHERE timeframe = 'daily' AND adjustment = 'qfq';"

  psql_query 'Market-data synchronization summary' "
SELECT
  count(*) AS tracked_streams,
  count(*) FILTER (WHERE last_error IS NOT NULL) AS error_streams,
  max(last_success_at) AS latest_success_at,
  max(last_ts) AS latest_bar_ts
FROM quant.market_data_sync_state;"

  psql_query 'Recent synchronization errors (up to 20)' "
SELECT
  symbol,
  timeframe,
  adjustment,
  provider,
  last_ts,
  updated_at,
  left(last_error, 160) AS last_error
FROM quant.market_data_sync_state
WHERE last_error IS NOT NULL
ORDER BY updated_at DESC
LIMIT 20;"

  psql_query 'Ingestion jobs by status' "
SELECT
  status,
  count(*) AS jobs,
  sum(total_symbols) AS total_symbols,
  sum(completed_symbols) AS completed_symbols,
  sum(failed_symbols) AS failed_symbols,
  sum(rows_upserted) AS rows_upserted,
  max(updated_at) AS latest_update
FROM quant.market_data_ingestion_jobs
GROUP BY status
ORDER BY status;"

  psql_query 'Recent incomplete or failed ingestion jobs (up to 20)' "
SELECT
  id,
  provider,
  timeframe,
  adjustment,
  status,
  completed_symbols,
  total_symbols,
  failed_symbols,
  rows_upserted,
  updated_at,
  left(error, 160) AS error
FROM quant.market_data_ingestion_jobs
WHERE status NOT IN ('completed', 'success')
ORDER BY updated_at DESC
LIMIT 20;"

  local latest_daily_age
  latest_daily_age="$(psql_value "
SELECT COALESCE(CURRENT_DATE - max(ts)::date, -1)
FROM quant.stock_bars
WHERE timeframe = 'daily' AND adjustment = 'qfq';")"
  if [[ ${latest_daily_age} =~ ^[0-9]+$ ]] && (( latest_daily_age > 10 )); then
    log "WARNING: latest daily qfq bar is ${latest_daily_age} calendar days old; inspect ingestion jobs and market-data logs."
  fi

  log "Data health report complete: ${total_rows} stock-bar rows found."
}

main() {
  case "${MODE}" in
    update)
      require_layout
      run_update
      ;;
    health)
      require_layout
      ;;
    -h|--help|help)
      usage
      return
      ;;
    *)
      usage
      die "Unknown mode: ${MODE}"
      ;;
  esac

  # The update command may have refreshed the environment or Compose override,
  # so load them only after it finishes.
  load_environment
  run_service_checks
  run_data_health
  log 'Safe completion: no volume removal, DROP, TRUNCATE, retention, or git reset command was used.'
}

main "$@"
