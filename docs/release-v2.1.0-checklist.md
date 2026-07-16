# QuantPilot v2.1.0 release checklist

`v2.1.0-alpha.2` is the first public signed desktop alpha. Do not create the
stable `v2.1.0` tag until every stable gate below has evidence attached to the
release issue or run log.

## One-time release setup

1. Create an Azure Artifact Signing Basic account, complete Public Trust
   identity validation, and create one certificate profile.
2. Create the protected GitHub Environment `desktop-release`.
3. Add environment secrets `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, and
   `AZURE_CLIENT_SECRET`.
4. Add environment variables `AZURE_CODE_SIGNING_ACCOUNT_NAME`,
   `AZURE_CERTIFICATE_PROFILE_NAME`, `AZURE_SIGNING_ENDPOINT`, and
   `AZURE_SIGNING_PUBLISHER_NAME`. The publisher value must exactly match the
   validated certificate subject.
5. If Azure signing is unavailable, add `WIN_CSC_LINK` and
   `WIN_CSC_KEY_PASSWORD` instead, while retaining the expected publisher
   variable. A release build without either complete signing path fails.

If the old Python test cache is inaccessible on a developer machine, open an
elevated PowerShell window and run:

```powershell
./scripts/release/repair-generated-cache.ps1
```

## Alpha release gate

- `npm ci` and `npm run release:check` pass.
- `npm run build:server` and `npm run build:desktop` pass from a clean checkout.
- Authenticode status is `Valid` for the installer, Electron executable, and
  Python sidecar; each signature has a timestamp and the expected publisher.
- Packaged standalone resources contain no `.env` file.
- Unpacked and silent-installer smoke tests create `app.db`, `market.duckdb`,
  and `installation-id`, return HTTP 200, and leave no process behind.
- On the server, run `quantpilot-maintain backup` as the deployment user, take a cloud disk
  snapshot, then run `quantpilot-maintain update` during the maintenance
  window. Never use `docker compose down -v`.
- The server smoke verifies Basic Auth isolation, 64 KB request limits, account
  lifecycle, session revocation, and diagnostic redaction, then deletes its
  test database rows.

To validate an upgrade on a disposable Windows VM:

```powershell
./scripts/release/test-windows-installer.ps1 `
  -PreviousInstaller './dist/QuantPilot Setup 2.1.0-alpha.1.exe' `
  -CurrentInstaller './dist/QuantPilot Setup 2.1.0-alpha.2.exe'
```

## Stable v2.1.0 gate

- The signed alpha has run for at least seven days.
- Two clean Windows x64 machines completed install and alpha.1-to-alpha.2
  upgrade tests without Docker, Node.js, or Python installed.
- Offline startup, unavailable server, disabled account, minute-policy deny,
  estimate cancellation, confirmed minute download, migration recovery, and
  diagnostics-consent-off scenarios passed.
- A server deployment failure was deliberately induced and automatic rollback
  restored the old Git revision, dependencies, web build, and services.
- No raw API key, token, local username/path, prompt, response, project,
  strategy, chat, or stock-list data appeared in retained diagnostics.
- Full and production `npm audit` gates have no high or critical findings.

## Server recovery commands

```bash
quantpilot-maintain backup
quantpilot-maintain check
quantpilot-maintain rollback <git-revision>
```

When no revision is supplied, rollback uses the newest verified backup
manifest. Database objects are additive and are deliberately not dropped by
application rollback.
