#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

# QuantPilot single-server maintenance helper.
# Run as the normal deployment user (ubuntu), not as root.

APP_DIR="${QUANTPILOT_APP_DIR:-/opt/quantpilot}"
BRANCH="${QUANTPILOT_DEPLOY_BRANCH:-main}"
MODE="${1:-update}"
ENV_FILE="${QUANTPILOT_ENV_FILE:-${APP_DIR}/.env.production}"
LOCK_FILE="${QUANTPILOT_DEPLOY_LOCK_FILE:-/tmp/quantpilot-maintain.lock}"

WEB_SERVICE="quantpilot-web"
MARKET_SERVICE="quantpilot-market-data"
TIMER_UNITS=(
  quantpilot-market-active.timer
  quantpilot-market-eod.timer
  quantpilot-market-repair.timer
  quantpilot-market-audit.timer
)

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

die() {
  log "ERROR: $*"
  exit 1
}

usage() {
  cat <<'EOF'
Usage: quantpilot-maintain [update|check|restart]

  update   Pull main, install dependencies, migrate/build, install units,
           restart services, reload Nginx, and run health checks (default).
  check    Read-only status and health checks.
  restart  Restart QuantPilot services, reload Nginx, then run checks.

Optional environment variables:
  QUANTPILOT_APP_DIR=/opt/quantpilot
  QUANTPILOT_DEPLOY_BRANCH=main
  QUANTPILOT_ENV_FILE=/opt/quantpilot/.env.production
EOF
}

on_error() {
  local exit_code=$?
  local line_number=${1:-unknown}
  trap - ERR
  log "FAILED at line ${line_number}, exit code ${exit_code}."
  systemctl --no-pager --full status "${MARKET_SERVICE}" "${WEB_SERVICE}" 2>/dev/null || true
  journalctl -u "${MARKET_SERVICE}" -u "${WEB_SERVICE}" -n 40 --no-pager 2>/dev/null || true
  exit "${exit_code}"
}
trap 'on_error $LINENO' ERR

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "Missing command: $1"
}

require_layout() {
  [[ ${EUID} -ne 0 ]] || die "Run this script as ubuntu; do not sudo the whole script."
  [[ -d "${APP_DIR}/.git" ]] || die "Git repository not found: ${APP_DIR}"
  [[ -f "${ENV_FILE}" ]] || die "Environment file not found: ${ENV_FILE}"
  [[ -f "${APP_DIR}/docker-compose.yml" ]] || die "docker-compose.yml is missing."
  [[ -f "${APP_DIR}/deploy/server/docker-compose.server.yml" ]] || die "server Compose override is missing."

  local command
  for command in git docker node npm npx uv curl systemctl sudo flock; do
    require_command "${command}"
  done
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

wait_for_compose_service_health() {
  local service=$1
  local state=""
  local attempt
  for attempt in {1..45}; do
    case "${service}" in
      timescaledb)
        if compose exec -T timescaledb \
          pg_isready \
          -U "${POSTGRES_USER:-quantpilot}" \
          -d "${POSTGRES_DB:-quantpilot}" >/dev/null 2>&1; then
          log "timescaledb: accepting connections"
          return 0
        fi
        state="not accepting connections"
        ;;
      redis)
        state="$(compose exec -T redis redis-cli --raw ping 2>/dev/null || true)"
        state="${state//$'\r'/}"
        if [[ ${state} == PONG ]]; then
          log "redis: PONG"
          return 0
        fi
        ;;
      *)
        die "Unknown Compose health-check service: ${service}"
        ;;
    esac
    sleep 2
  done
  compose ps "${service}" || true
  die "${service} did not become ready; last result: ${state:-no response}"
}

wait_for_http() {
  local name=$1
  local url=$2
  local attempt
  for attempt in {1..30}; do
    if curl --noproxy '*' -fsS --max-time 5 -o /dev/null "${url}"; then
      log "${name}: OK (${url})"
      return 0
    fi
    sleep 2
  done
  die "${name} health check failed: ${url}"
}

check_worktree() {
  local dirty
  dirty="$(git -C "${APP_DIR}" status --porcelain)"
  [[ -z ${dirty} ]] || {
    printf '%s\n' "${dirty}"
    die "Server worktree is not clean. Commit, move, or remove these files before updating."
  }
}

reexec_updated_library_script() {
  local source_script="${APP_DIR}/deploy/server/quantpilot-maintain.sh"
  local target_script="/usr/local/sbin/quantpilot-maintain"
  local temporary_target="/usr/local/sbin/.quantpilot-maintain.new"
  local current_script
  current_script="$(readlink -f "$0")"
  [[ ${current_script} == "${target_script}" ]] || return 0
  cmp -s "${source_script}" "${target_script}" && return 0

  log "A newer maintenance script was pulled; installing it before continuing..."
  sudo install -m 0755 "${source_script}" "${temporary_target}"
  sudo mv -f "${temporary_target}" "${target_script}"
  flock -u 9
  exec 9>&-
  exec "${target_script}" update
}

install_runtime_units() {
  log "Installing systemd units and timers..."
  sudo install -m 0644 \
    "${APP_DIR}/deploy/server/systemd/quantpilot-market-data.service" \
    /etc/systemd/system/quantpilot-market-data.service
  sudo install -m 0644 \
    "${APP_DIR}/deploy/server/systemd/quantpilot-web.service" \
    /etc/systemd/system/quantpilot-web.service
  sudo install -m 0644 \
    "${APP_DIR}/deploy/server/systemd/quantpilot-market-refresh@.service" \
    /etc/systemd/system/quantpilot-market-refresh@.service

  local timer
  for timer in "${TIMER_UNITS[@]}"; do
    sudo install -m 0644 \
      "${APP_DIR}/deploy/server/systemd/${timer}" \
      "/etc/systemd/system/${timer}"
  done
  sudo systemctl daemon-reload
  sudo systemctl enable "${MARKET_SERVICE}" "${WEB_SERVICE}" >/dev/null
  sudo systemctl enable --now "${TIMER_UNITS[@]}" >/dev/null
}

install_nginx_snippets() {
  [[ -d /etc/nginx ]] || return 0
  log "Updating QuantPilot Nginx snippets..."
  sudo install -d -m 0755 /etc/nginx/conf.d /etc/nginx/snippets
  sudo install -m 0644 \
    "${APP_DIR}/deploy/server/nginx/quantpilot-websocket-map.conf" \
    /etc/nginx/conf.d/quantpilot-websocket-map.conf
  sudo install -m 0644 \
    "${APP_DIR}/deploy/server/nginx/smartstock-proxy.conf" \
    /etc/nginx/snippets/quantpilot-smartstock-proxy.conf
  sudo install -m 0644 \
    "${APP_DIR}/deploy/server/nginx/smartstock-location.conf" \
    /etc/nginx/snippets/quantpilot-smartstock.conf
  sudo nginx -t
}

pull_build_and_migrate() {
  check_worktree
  log "Fetching origin/${BRANCH} through the configured SSH remote..."
  git -C "${APP_DIR}" fetch --prune origin "${BRANCH}"
  git -C "${APP_DIR}" pull --ff-only origin "${BRANCH}"
  log "Checked out $(git -C "${APP_DIR}" log -1 --oneline --decorate)"
  reexec_updated_library_script

  load_environment

  log "Starting/updating TimescaleDB and Redis..."
  compose up -d timescaledb redis
  wait_for_compose_service_health timescaledb
  wait_for_compose_service_health redis

  log "Installing Node dependencies and generating Prisma client..."
  cd "${APP_DIR}"
  # Production builds still require the repository's build-time devDependencies
  # (PostCSS, Tailwind, TypeScript and Prisma), even though NODE_ENV is production.
  QUANTPILOT_DEPLOYMENT=server npm ci --include=dev
  npx --no-install prisma generate

  log "Installing market-data dependencies..."
  local uv_args=(sync --frozen --extra baostock --extra akshare)
  if [[ -n ${TUSHARE_TOKEN:-} ]]; then
    uv_args+=(--extra tushare)
  fi
  cd "${APP_DIR}/services/market-data"
  uv "${uv_args[@]}"

  log "Applying database initialization/migrations..."
  cd "${APP_DIR}"
  npm run db:init

  log "Building the production /smartstock application..."
  npm run build:server

  install_runtime_units
  install_nginx_snippets
}

restart_services() {
  load_environment
  log "Restarting ${MARKET_SERVICE}..."
  sudo systemctl restart "${MARKET_SERVICE}"
  wait_for_http "market-data" "http://127.0.0.1:${QUANTPILOT_MARKET_PORT:-8000}/health"

  log "Restarting ${WEB_SERVICE}..."
  sudo systemctl restart "${WEB_SERVICE}"
  wait_for_http "web" "http://127.0.0.1:${WEB_PORT:-3000}${NEXT_PUBLIC_BASE_PATH:-/smartstock}"

  if [[ -d /etc/nginx ]]; then
    sudo nginx -t
    sudo systemctl reload nginx
  fi
}

run_checks() {
  load_environment
  log "Git revision: $(git -C "${APP_DIR}" log -1 --oneline --decorate)"
  log "Checking Docker infrastructure..."
  compose ps
  wait_for_compose_service_health timescaledb
  wait_for_compose_service_health redis

  log "Checking systemd services..."
  systemctl is-active --quiet "${MARKET_SERVICE}" || die "${MARKET_SERVICE} is not active."
  systemctl is-active --quiet "${WEB_SERVICE}" || die "${WEB_SERVICE} is not active."
  systemctl --no-pager --full status "${MARKET_SERVICE}" "${WEB_SERVICE}" | sed -n '1,28p'

  wait_for_http "market-data" "http://127.0.0.1:${QUANTPILOT_MARKET_PORT:-8000}/health"
  wait_for_http "strategy profiles" "http://127.0.0.1:${QUANTPILOT_MARKET_PORT:-8000}/api/v1/ingestion/strategy-profiles"
  wait_for_http "web" "http://127.0.0.1:${WEB_PORT:-3000}${NEXT_PUBLIC_BASE_PATH:-/smartstock}"

  log "Enabled market-data timers:"
  systemctl list-timers 'quantpilot-market-*' --all --no-pager
  log "Disk and memory summary:"
  df -h "${APP_DIR}"
  free -h
  log "All QuantPilot checks passed."
}

sync_script_library() {
  local source_script="${APP_DIR}/deploy/server/quantpilot-maintain.sh"
  local target_script="/usr/local/sbin/quantpilot-maintain"
  local temporary_target="/usr/local/sbin/.quantpilot-maintain.new"
  [[ -f ${source_script} ]] || return 0
  sudo install -m 0755 "${source_script}" "${temporary_target}"
  sudo mv -f "${temporary_target}" "${target_script}"
  log "Script library updated: ${target_script}"
}

case "${MODE}" in
  update|deploy)
    require_layout
    exec 9>"${LOCK_FILE}"
    flock -n 9 || die "Another QuantPilot maintenance run is active: ${LOCK_FILE}"
    sudo -v
    pull_build_and_migrate
    restart_services
    run_checks
    sync_script_library
    ;;
  check)
    require_layout
    run_checks
    ;;
  restart)
    require_layout
    exec 9>"${LOCK_FILE}"
    flock -n 9 || die "Another QuantPilot maintenance run is active: ${LOCK_FILE}"
    sudo -v
    restart_services
    run_checks
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    usage
    die "Unknown mode: ${MODE}"
    ;;
esac
