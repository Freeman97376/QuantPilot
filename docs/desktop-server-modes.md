# Desktop and server runtime modes

QuantPilot is released from one public repository as two independent products.
The runtime mode is fixed at build time with `QUANTPILOT_RUNTIME_MODE=server` or
`QUANTPILOT_RUNTIME_MODE=desktop`; it is not a user-selectable database switch.

## Server

- Build with `npm run build:server`.
- Next.js and the Python market-data service run under systemd.
- TimescaleDB and Redis are the default Docker services.
- ClickHouse uses the `analytics` Compose profile. Loki, Grafana, and Alloy use
  the `observability` profile.
- `npm run db:init` retains the existing PostgreSQL bootstrap and Prisma sync
  path.
- Desktop accounts are managed with `npm run desktop:accounts -- <command>`.
  Supported commands are `create`, `list`, `disable`, `enable`,
  `reset-password`, `revoke-sessions`, and `cleanup-diagnostics`.

The Nginx server block includes `smartstock-location.conf`. Only
`/smartstock/api/desktop-connection/` uses the bearer-session proxy snippet;
all other `/smartstock` routes keep the existing Basic Auth policy. The login
location is IP-rate-limited and all desktop request bodies are capped at 64 KB.

## Windows desktop

- Build on Windows x64 with `npm run build:desktop`.
- The installer contains Electron, the Next.js standalone server, a PyInstaller
  `onedir` Python sidecar, SQLite migrations, and the DuckDB runtime.
- Packaged Next.js files live in `resources/standalone`. A staging step copies
  only `server.js`, `.next`, public assets, and approved runtime configuration;
  it rejects `.env` files and does not ship the repository or deployment files.
  The Electron Node child resolves production dependencies from
  `resources/app.asar/node_modules`.
- Node, Python, PostgreSQL, Redis, and Docker are not required on an installed
  machine.
- A packaged desktop always starts its bundled loopback FastAPI sidecar and
  DuckDB repository. Ambient `QUANTPILOT_MARKET_API_URL` values are ignored in
  packaged builds, so a stale server or developer environment cannot silently
  replace the desktop data source.
- Data lives below `%LOCALAPPDATA%\QuantPilot` in `app.db`, `market.duckdb`,
  `cache`, `workspaces`, `backups`, and `logs`.
- Electron starts both loopback services on private random ports, authenticates
  the sidecar health check with a per-launch token, monitors both processes, and
  stops them on exit.
- SQLite migrations run before the UI opens. The database is backed up first;
  a failed migration restores the backup and blocks startup.
- Before the first packaged start of each application version, an existing
  `market.duckdb` is copied to `backups` without resetting or deleting the live
  database. Electron rotates `electron.log`, `next.log`, and `market-data.log`
  at 10 MB with five retained backups.
- Secrets are encrypted with Electron `safeStorage` (Windows DPAPI). SQLite
  stores only opaque secret references.

The first-run minute-data policy is mandatory. Enabling it permits later
on-demand use but does not start a download. An actual minute-data request must
first create an estimate, display provider/access, coverage, duration, download,
disk, and peak-memory estimates, and then consume that estimate after explicit
confirmation. Disabling the policy prevents minute requests until it is changed
in Settings.

The official server connection is optional and fixed to
`https://mantleofintelligence.com/smartstock`. It currently authorizes only
consented diagnostic/version metadata. Local projects, strategies, chat, market
data, API keys, and LLM traffic remain local and continue working offline.

The `/smart-strategy` page is the normal desktop entry point for first-use data
preparation. One action imports the complete EastMoney A-share catalog and
starts a resumable five-year `daily/qfq` history job. Baostock is the history
primary and AKShare is the automatic fallback; EastMoney realtime is requested
only for selected candidate details. The page exposes provider success/failure,
DuckDB size and free disk, job progress, and `missing`, `partial`, `stale`, and
`ready` coverage. Full-market readiness is the default execution gate; using a
ready subset requires an explicit switch.

## Release and update

Set `package.json` to the release version and push the matching public tag, for
example `v2.1.0-alpha.3`. `release-desktop.yml` builds the Windows x64 installer
and publishes electron-builder update metadata to the public GitHub Release.
The desktop updater reads that public release without distributing a GitHub
access token. Application databases and user-data directories are outside the
installation directory and are not overwritten by upgrades.

The `v2.1.0-alpha.2` public workflow requires Azure Artifact Signing or an OV
certificate, verifies the publisher and timestamp, and refuses unsigned release
artifacts. Local development builds may remain unsigned. Before a stable
release, run install, upgrade, backup/restore, offline, revoked-account, and
insufficient-disk tests on two clean Windows x64 machines.

`npm run build:desktop` deletes only repository-owned `dist` and
`.desktop-build` directories before packaging, then requires exactly one
installer named for the current `package.json` version. It never deletes
`%LOCALAPPDATA%\QuantPilot`. Public GitHub release assets from older versions
remain available for upgrade and rollback testing; stale local installers are
not carried into a new build.

Server maintenance creates and verifies a PostgreSQL backup before additive
migrations, builds into `.next-candidate` while the current web process remains
online, and retains `.next-rollback`. `quantpilot-maintain rollback [revision]`
restores the selected Git revision, dependencies, web build, and services while
leaving additive database objects intact.
