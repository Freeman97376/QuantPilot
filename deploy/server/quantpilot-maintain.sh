#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

# QuantPilot single-server maintenance helper.
# Run as the normal deployment user (ubuntu), not as root.

APP_DIR="${QUANTPILOT_APP_DIR:-/opt/quantpilot}"
BRANCH="${QUANTPILOT_DEPLOY_BRANCH:-main}"
MODE="${1:-update}"
TARGET_REVISION="${2:-}"
ENV_FILE="${QUANTPILOT_ENV_FILE:-${APP_DIR}/.env.production}"
DEPLOY_USER="$(id -un)"
DEPLOY_GROUP="$(id -gn)"
DEPLOY_USER_HOME="${QUANTPILOT_DEPLOY_USER_HOME:-${HOME}}"
LOCK_FILE="${QUANTPILOT_DEPLOY_LOCK_FILE:-/tmp/quantpilot-maintain.lock}"
MIN_FREE_DISK_MB="${QUANTPILOT_MIN_FREE_DISK_MB:-4096}"
BACKUP_DIR="${QUANTPILOT_BACKUP_DIR:-/var/backups/quantpilot}"
BACKUP_KEEP="${QUANTPILOT_BACKUP_KEEP:-7}"
CANDIDATE_BUILD_DIR="${APP_DIR}/.next-candidate"
ROLLBACK_BUILD_DIR="${APP_DIR}/.next-rollback"
PREVIOUS_REVISION="${QUANTPILOT_PREVIOUS_REVISION:-}"
ACTIVE_BACKUP_DIR=""
WEB_BUILD_SWAPPED=0

WEB_SERVICE="quantpilot-web"
MARKET_SERVICE="quantpilot-market-data"
TIMER_UNITS=(
  quantpilot-market-active.timer
  quantpilot-market-eod.timer
  quantpilot-market-repair.timer
  quantpilot-market-audit.timer
  quantpilot-diagnostics-cleanup.timer
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
Usage: quantpilot-maintain [update|check|restart|backup|rollback [revision]]

  update   Pull main, install dependencies, migrate/build, install units,
           restart services, reload Nginx, and run health checks (default).
  check    Read-only status and health checks.
  restart  Restart QuantPilot services, reload Nginx, then run checks.
  backup   Create and verify a PostgreSQL backup without deploying.
  rollback Restore the supplied revision (or the newest backup revision),
           dependencies, previous web build, and services.

Optional environment variables:
  QUANTPILOT_APP_DIR=/opt/quantpilot
  QUANTPILOT_DEPLOY_BRANCH=main
  QUANTPILOT_ENV_FILE=/opt/quantpilot/.env.production
  QUANTPILOT_DEPLOY_USER_HOME=/home/ubuntu
  QUANTPILOT_BACKUP_DIR=/var/backups/quantpilot
  QUANTPILOT_BACKUP_KEEP=7
EOF
}

on_error() {
  local exit_code=$?
  local line_number=${1:-unknown}
  trap - ERR
  log "FAILED at line ${line_number}, exit code ${exit_code}."
  if [[ -n ${PREVIOUS_REVISION} ]]; then
    rollback_failed_deployment || true
  fi
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
  [[ ${APP_DIR} =~ ^/[A-Za-z0-9._/@:+-]+$ && ${APP_DIR} != / ]] || die "QUANTPILOT_APP_DIR must be an absolute non-root path without whitespace."
  [[ ${ENV_FILE} =~ ^/[A-Za-z0-9._/@:+-]+$ && ${ENV_FILE} != / ]] || die "QUANTPILOT_ENV_FILE must be an absolute non-root path without whitespace."
  [[ ${DEPLOY_USER_HOME} =~ ^/[A-Za-z0-9._/@:+-]+$ && ${DEPLOY_USER_HOME} != / ]] || die "QUANTPILOT_DEPLOY_USER_HOME must be an absolute non-root path without whitespace."
  [[ ${DEPLOY_USER} =~ ^[A-Za-z0-9_.-]+$ ]] || die "Deployment user contains unsupported characters."
  [[ ${DEPLOY_GROUP} =~ ^[A-Za-z0-9_.-]+$ ]] || die "Deployment group contains unsupported characters."

  local command
  for command in git docker node npm npx uv curl systemctl sudo flock df awk find sort sha256sum sed; do
    require_command "${command}"
  done
  docker compose version >/dev/null
  [[ ${BACKUP_DIR} == /* && ${BACKUP_DIR} != / ]] || die "QUANTPILOT_BACKUP_DIR must be an absolute non-root path."
  [[ ${BACKUP_KEEP} =~ ^[1-9][0-9]*$ ]] || die "QUANTPILOT_BACKUP_KEEP must be a positive integer."
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

safe_remove_build_dir() {
  local target=$1
  case "${target}" in
    "${CANDIDATE_BUILD_DIR}"|"${ROLLBACK_BUILD_DIR}")
      rm -rf -- "${target}"
      ;;
    *)
      die "Refusing to remove unexpected build directory: ${target}"
      ;;
  esac
}

sync_market_dependencies() {
  local uv_args=(sync --frozen --extra baostock --extra akshare)
  if [[ -n ${TUSHARE_TOKEN:-} ]]; then
    uv_args+=(--extra tushare)
  fi
  cd "${APP_DIR}/services/market-data"
  uv "${uv_args[@]}"
}

prune_server_backups() {
  local -a backups=()
  local old_backup
  local index
  mapfile -t backups < <(
    find "${BACKUP_DIR}" -mindepth 1 -maxdepth 1 -type d -name 'quantpilot-*' -printf '%p\n' |
      sort -r
  )
  for ((index = BACKUP_KEEP; index < ${#backups[@]}; index += 1)); do
    old_backup="${backups[${index}]}"
    case "${old_backup}" in
      "${BACKUP_DIR}"/quantpilot-*) rm -rf -- "${old_backup}" ;;
      *) die "Refusing to prune unexpected backup path: ${old_backup}" ;;
    esac
  done
}

create_server_backup() {
  local timestamp
  local revision
  local dump_file
  timestamp="$(date -u '+%Y%m%dT%H%M%SZ')"
  revision="${PREVIOUS_REVISION:-$(git -C "${APP_DIR}" rev-parse HEAD)}"
  ACTIVE_BACKUP_DIR="${BACKUP_DIR}/quantpilot-${timestamp}-${revision:0:12}"
  sudo install -d -m 0750 -o "$(id -un)" -g "$(id -gn)" "${BACKUP_DIR}"
  install -d -m 0750 "${ACTIVE_BACKUP_DIR}"
  dump_file="${ACTIVE_BACKUP_DIR}/postgres.dump"

  log "Creating PostgreSQL backup: ${dump_file}"
  compose exec -T timescaledb pg_dump \
    -U "${POSTGRES_USER:-quantpilot}" \
    -d "${POSTGRES_DB:-quantpilot}" \
    --format=custom >"${dump_file}"
  [[ -s ${dump_file} ]] || die "PostgreSQL backup is empty: ${dump_file}"
  compose exec -T timescaledb pg_restore --list <"${dump_file}" >/dev/null

  printf '%s\n' "${revision}" >"${ACTIVE_BACKUP_DIR}/revision.txt"
  sha256sum "${ENV_FILE}" >"${ACTIVE_BACKUP_DIR}/environment.sha256"
  compose images >"${ACTIVE_BACKUP_DIR}/compose-images.txt"
  systemctl cat "${MARKET_SERVICE}" "${WEB_SERVICE}" \
    >"${ACTIVE_BACKUP_DIR}/systemd-units.txt" 2>&1 || true
  if [[ -d /etc/nginx ]]; then
    sudo nginx -T >"${ACTIVE_BACKUP_DIR}/nginx-config.txt" 2>&1 || true
  fi
  {
    printf 'created_at=%s\n' "${timestamp}"
    printf 'revision=%s\n' "${revision}"
    printf 'database=%s\n' "${POSTGRES_DB:-quantpilot}"
    printf 'compose_project=quantpilot\n'
  } >"${ACTIVE_BACKUP_DIR}/manifest.txt"
  prune_server_backups
  log "Backup verified and retained: ${ACTIVE_BACKUP_DIR}"
}

build_server_candidate() {
  safe_remove_build_dir "${CANDIDATE_BUILD_DIR}"
  cd "${APP_DIR}"
  log "Building candidate web artifact while the current service remains online..."
  QUANTPILOT_NEXT_DIST_DIR=.next-candidate \
    QUANTPILOT_PRESERVE_RUNNING_WEB=1 \
    npm run build:server
  [[ -s "${CANDIDATE_BUILD_DIR}/BUILD_ID" ]] || \
    die "Candidate build completed without ${CANDIDATE_BUILD_DIR}/BUILD_ID."
}

activate_candidate_build() {
  [[ -s "${CANDIDATE_BUILD_DIR}/BUILD_ID" ]] || return 0
  log "Activating candidate web build..."
  sudo systemctl stop "${WEB_SERVICE}"
  safe_remove_build_dir "${ROLLBACK_BUILD_DIR}"
  if [[ -d "${APP_DIR}/.next" ]]; then
    mv "${APP_DIR}/.next" "${ROLLBACK_BUILD_DIR}"
  fi
  mv "${CANDIDATE_BUILD_DIR}" "${APP_DIR}/.next"
  WEB_BUILD_SWAPPED=1
}

rollback_web_build() {
  (( WEB_BUILD_SWAPPED == 1 )) || return 0
  [[ -s "${ROLLBACK_BUILD_DIR}/BUILD_ID" ]] || return 0
  log "Restoring the previous web build..."
  set +e
  sudo systemctl stop "${WEB_SERVICE}"
  safe_remove_build_dir "${CANDIDATE_BUILD_DIR}"
  if [[ -d "${APP_DIR}/.next" ]]; then
    mv "${APP_DIR}/.next" "${CANDIDATE_BUILD_DIR}"
  fi
  mv "${ROLLBACK_BUILD_DIR}" "${APP_DIR}/.next"
  sudo systemctl restart "${WEB_SERVICE}"
  WEB_BUILD_SWAPPED=0
  set -e
  return 0
}

restore_revision_dependencies() {
  local revision=$1
  log "Restoring source and dependencies for revision ${revision}..."
  git -C "${APP_DIR}" switch --detach "${revision}"
  cd "${APP_DIR}"
  QUANTPILOT_DEPLOYMENT=server npm ci --include=dev
  sync_market_dependencies
}

rollback_failed_deployment() {
  local revision=${PREVIOUS_REVISION}
  trap - ERR
  set +e
  rollback_web_build
  safe_remove_build_dir "${CANDIDATE_BUILD_DIR}"
  restore_revision_dependencies "${revision}"
  sudo systemctl restart "${MARKET_SERVICE}" "${WEB_SERVICE}"
  log "Automatic application rollback restored revision ${revision}. Database changes were additive and were not removed."
  set -e
  return 0
}

latest_backup_revision() {
  local latest
  latest="$(
    find "${BACKUP_DIR}" -mindepth 2 -maxdepth 2 -type f -name revision.txt -printf '%T@ %p\n' |
      sort -nr |
      awk 'NR == 1 { sub(/^[^ ]+ /, ""); print; exit }'
  )"
  [[ -n ${latest} && -s ${latest} ]] || die "No verified backup revision was found in ${BACKUP_DIR}."
  tr -d '[:space:]' <"${latest}"
}

require_free_disk_space() {
  local stage=$1
  local available_kb
  local available_mb
  local required_kb
  available_kb="$(df -Pk "${APP_DIR}" | awk 'NR == 2 { print $4 }')"
  [[ ${available_kb} =~ ^[0-9]+$ ]] || die "Unable to determine free disk space before ${stage}."
  [[ ${MIN_FREE_DISK_MB} =~ ^[0-9]+$ ]] || die "QUANTPILOT_MIN_FREE_DISK_MB must be a positive integer."
  (( MIN_FREE_DISK_MB > 0 )) || die "QUANTPILOT_MIN_FREE_DISK_MB must be greater than zero."
  required_kb=$((MIN_FREE_DISK_MB * 1024))
  available_mb=$((available_kb / 1024))
  (( available_kb >= required_kb )) || die \
    "Only ${available_mb} MiB is free before ${stage}; at least ${MIN_FREE_DISK_MB} MiB is required. Free cache/log/build artifacts without deleting Docker volumes, then retry."
  log "Disk preflight before ${stage}: ${available_mb} MiB free."
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
  exec env QUANTPILOT_PREVIOUS_REVISION="${PREVIOUS_REVISION}" "${target_script}" update
}

escape_sed_replacement() {
  local value=$1
  value=${value//\\/\\\\}
  value=${value//&/\\&}
  value=${value//|/\\|}
  printf '%s' "${value}"
}

install_runtime_unit() {
  local unit_name=$1
  local source="${APP_DIR}/deploy/server/systemd/${unit_name}"
  local target="/etc/systemd/system/${unit_name}"
  local app_dir
  local env_file
  local deploy_user_home
  local web_port="${WEB_PORT:-3000}"
  [[ ${web_port} =~ ^[0-9]+$ ]] && (( web_port >= 1 && web_port <= 65535 )) || \
    die "WEB_PORT must be an integer between 1 and 65535."
  app_dir="$(escape_sed_replacement "${APP_DIR}")"
  env_file="$(escape_sed_replacement "${ENV_FILE}")"
  deploy_user_home="$(escape_sed_replacement "${DEPLOY_USER_HOME}")"
  sed \
    -e "s|^User=ubuntu$|User=${DEPLOY_USER}|" \
    -e "s|^Group=ubuntu$|Group=${DEPLOY_GROUP}|" \
    -e "s|/opt/quantpilot|${app_dir}|g" \
    -e "s|^EnvironmentFile=.*$|EnvironmentFile=${env_file}|" \
    -e "s|/home/ubuntu|${deploy_user_home}|g" \
    -e "s|^Environment=WEB_PORT=3000$|Environment=WEB_PORT=${web_port}|" \
    "${source}" | sudo install -m 0644 /dev/stdin "${target}"
}

install_runtime_units() {
  log "Installing systemd units and timers for ${DEPLOY_USER} at ${APP_DIR}..."
  install_runtime_unit quantpilot-market-data.service
  install_runtime_unit quantpilot-web.service
  install_runtime_unit quantpilot-market-refresh@.service
  install_runtime_unit quantpilot-diagnostics-cleanup.service

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
  sudo install -m 0644 \
    "${APP_DIR}/deploy/server/nginx/smartstock-desktop-connection-proxy.conf" \
    /etc/nginx/snippets/quantpilot-smartstock-desktop-connection-proxy.conf
  sudo nginx -t
}

pull_build_and_migrate() {
  check_worktree
  if [[ -z ${PREVIOUS_REVISION} ]]; then
    PREVIOUS_REVISION="$(git -C "${APP_DIR}" rev-parse HEAD)"
  fi
  log "Fetching origin/${BRANCH} through the configured SSH remote..."
  git -C "${APP_DIR}" fetch --prune origin "${BRANCH}"
  git -C "${APP_DIR}" switch "${BRANCH}"
  git -C "${APP_DIR}" pull --ff-only origin "${BRANCH}"
  log "Checked out $(git -C "${APP_DIR}" log -1 --oneline --decorate)"
  reexec_updated_library_script

  load_environment

  log "Starting/updating TimescaleDB and Redis..."
  compose up -d timescaledb redis
  wait_for_compose_service_health timescaledb
  wait_for_compose_service_health redis

  require_free_disk_space "dependency installation"
  log "Installing Node dependencies and generating Prisma client..."
  cd "${APP_DIR}"
  # Production builds still require the repository's build-time devDependencies
  # (PostCSS, Tailwind, TypeScript and Prisma), even though NODE_ENV is production.
  QUANTPILOT_DEPLOYMENT=server npm ci --include=dev
  npx --no-install prisma generate

  log "Installing market-data dependencies..."
  sync_market_dependencies
  require_free_disk_space "production build"
  build_server_candidate

  create_server_backup
  log "Applying additive database initialization/migrations after backup verification..."
  cd "${APP_DIR}"
  npm run db:init

  install_runtime_units
  install_nginx_snippets
}

restart_services() {
  load_environment
  log "Restarting ${MARKET_SERVICE}..."
  sudo systemctl restart "${MARKET_SERVICE}"
  wait_for_http "market-data" "http://127.0.0.1:${QUANTPILOT_MARKET_PORT:-8000}/health"

  activate_candidate_build
  log "Restarting ${WEB_SERVICE}..."
  sudo systemctl restart "${WEB_SERVICE}"
  wait_for_http "web" "http://127.0.0.1:${WEB_PORT:-3000}${NEXT_PUBLIC_BASE_PATH:-/smartstock}"
  wait_for_http \
    "desktop connection capabilities" \
    "http://127.0.0.1:${WEB_PORT:-3000}${NEXT_PUBLIC_BASE_PATH:-/smartstock}/api/desktop-connection/capabilities"
  if [[ ${QUANTPILOT_RUN_CONNECTION_SMOKE:-1} == 1 ]]; then
    cd "${APP_DIR}"
    node scripts/admin/desktop-connection-smoke.js
  fi

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
  systemctl is-active --quiet quantpilot-diagnostics-cleanup.timer || \
    die "quantpilot-diagnostics-cleanup.timer is not active."
  systemctl --no-pager --full status "${MARKET_SERVICE}" "${WEB_SERVICE}" | sed -n '1,28p'

  wait_for_http "market-data" "http://127.0.0.1:${QUANTPILOT_MARKET_PORT:-8000}/health"
  wait_for_http "strategy profiles" "http://127.0.0.1:${QUANTPILOT_MARKET_PORT:-8000}/api/v1/ingestion/strategy-profiles"
  wait_for_http "web" "http://127.0.0.1:${WEB_PORT:-3000}${NEXT_PUBLIC_BASE_PATH:-/smartstock}"
  wait_for_http \
    "desktop connection capabilities" \
    "http://127.0.0.1:${WEB_PORT:-3000}${NEXT_PUBLIC_BASE_PATH:-/smartstock}/api/desktop-connection/capabilities"

  log "Enabled market-data timers:"
  systemctl list-timers 'quantpilot-market-*' --all --no-pager
  systemctl list-timers 'quantpilot-diagnostics-cleanup.timer' --all --no-pager
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

rollback_to_revision() {
  local revision=${1:-}
  check_worktree
  PREVIOUS_REVISION="$(git -C "${APP_DIR}" rev-parse HEAD)"
  load_environment
  if [[ -z ${revision} ]]; then
    revision="$(latest_backup_revision)"
  fi
  git -C "${APP_DIR}" cat-file -e "${revision}^{commit}" || \
    die "Rollback revision is not available locally: ${revision}"
  log "Rolling back application runtime from ${PREVIOUS_REVISION} to ${revision}..."
  restore_revision_dependencies "${revision}"
  build_server_candidate
  restart_services
  run_checks
  PREVIOUS_REVISION=""
  log "Application rollback completed at revision ${revision}. Additive database objects were preserved."
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
  backup)
    require_layout
    exec 9>"${LOCK_FILE}"
    flock -n 9 || die "Another QuantPilot maintenance run is active: ${LOCK_FILE}"
    sudo -v
    load_environment
    wait_for_compose_service_health timescaledb
    create_server_backup
    ;;
  rollback)
    require_layout
    exec 9>"${LOCK_FILE}"
    flock -n 9 || die "Another QuantPilot maintenance run is active: ${LOCK_FILE}"
    sudo -v
    rollback_to_revision "${TARGET_REVISION}"
    sync_script_library
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    usage
    die "Unknown mode: ${MODE}"
    ;;
esac
