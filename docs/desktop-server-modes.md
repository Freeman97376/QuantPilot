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
- Data lives below `%LOCALAPPDATA%\QuantPilot` in `app.db`, `market.duckdb`,
  `cache`, `workspaces`, `backups`, and `logs`.
- Electron starts both loopback services on private random ports, authenticates
  the sidecar health check with a per-launch token, monitors both processes, and
  stops them on exit.
- SQLite migrations run before the UI opens. The database is backed up first;
  a failed migration restores the backup and blocks startup.
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

## Release and update

Set `package.json` to the release version and push the matching public tag, for
example `v2.1.0-alpha.1`. `release-desktop.yml` builds the Windows x64 installer
and publishes electron-builder update metadata to the public GitHub Release.
The desktop updater reads that public release without distributing a GitHub
access token. Application databases and user-data directories are outside the
installation directory and are not overwritten by upgrades.

Before a stable release, sign the Windows artifacts and run install, upgrade,
backup/restore, offline, revoked-account, and insufficient-disk tests on a clean
Windows x64 machine. Alpha builds intentionally set `signAndEditExecutable` to
`false`; enable signing only after the release workflow has a protected signing
certificate and timestamp configuration.
