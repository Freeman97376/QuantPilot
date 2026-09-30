# Agent Governance Decision Log

Record only decisions that should influence future agent behavior. Add a new entry when a decision is superseded; keep the earlier entry intact.

## GOV-001 - Centralize agent governance in office

- Date: 2026-08-12
- Status: accepted
- Decision: Keep detailed agent governance in `office/` and use the root `AGENTS.md` as the discovery entry point.
- Reason: One indexed, testable location reduces instruction drift while preserving Codex discovery.
- Consequences: Governance changes must update the relevant record and pass the office validator.

## SEC-001 - Keep service credentials outside browser payloads and process arguments

- Date: 2026-08-12
- Status: accepted
- Decision: Browser token APIs return metadata only; server service tokens use authenticated encryption with a stable deployment key and lazy migration of legacy plaintext records; Git bearer credentials are supplied outside command arguments and redacted from errors.
- Reason: Raw credential responses, plaintext persistence, and credential-bearing command lines expose high-impact secrets to browsers, logs, and process inspection.
- Consequences: Server deployments must retain a stable 64-character hexadecimal `ENCRYPTION_KEY`; callers may not depend on the removed raw-token route; credential regression checks are mandatory in release readiness.

## DATA-001 - Preserve durable operator control and atomic market-data state

- Date: 2026-08-12
- Status: accepted
- Decision: Long-running catalog and autofill jobs persist explicit resume cursors and never overwrite a concurrent stop request; related DuckDB writes are transactional; service health requires the configured primary data store to be reachable.
- Reason: Crash recovery, partial batches, and in-flight stop races previously caused duplicate work, stalled jobs, or false-positive health.
- Consequences: New ingestion workflows must define resumable progress, operator-control ownership, atomic write boundaries, and failure-path regression tests.

## REL-001 - Make release inputs reproducible and verify all runtime shapes

- Date: 2026-08-12
- Status: accepted
- Decision: Core skill archives normalize content and tar metadata across operating systems; release readiness enforces skill and security contracts; CI compiles the server candidate with the checked-in example environment while real deployments continue to use an untracked production environment.
- Reason: Platform-specific archive metadata and an unavailable production env file made Ubuntu checks drift and the release workflow fail deterministically.
- Consequences: Skill package and lock hashes must be reproducible on Windows and Ubuntu; Web, server, and Windows desktop candidates remain separate required validation targets.
