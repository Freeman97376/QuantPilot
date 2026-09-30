# Agent Governance Decision Log

Record only decisions that should influence future agent behavior. Add a new entry when a decision is superseded; keep the earlier entry intact.

## GOV-001 - Centralize agent governance in office

- Date: bootstrap date
- Status: accepted
- Decision: Keep detailed agent governance in `office/` and use the root `AGENTS.md` as the discovery entry point.
- Reason: One indexed, testable location reduces instruction drift while preserving Codex discovery.
- Consequences: Governance changes must update the relevant record and pass the office validator.
