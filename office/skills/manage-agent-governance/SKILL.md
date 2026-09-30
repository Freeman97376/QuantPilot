---
name: manage-agent-governance
description: Initialize, audit, repair, or evolve a project's agent-governance system. Use when creating or adopting a project, changing AGENTS.md, or working with office/ skills, scripts, records, handoffs, governance tests, or agent interaction rules.
---

# Manage Agent Governance

Keep the project's agent-facing rules discoverable, minimal, auditable, and safe to reuse.

## Workflow

1. Resolve the actual project root. Prefer `git rev-parse --show-toplevel` for a Git checkout; otherwise use the user-selected workspace root.
2. Read the root `AGENTS.md`, `office/README.md`, and `office/AGENTS.md`. Preserve stricter or project-specific rules already in force.
3. Run `../../scripts/Test-OfficeGovernance.ps1` before editing when the structure already exists. Record failures without deleting or replacing user content.
4. For a new project, run the trusted `../../scripts/Initialize-Office.ps1` with the new root. Merge into an existing `AGENTS.md`; never overwrite it wholesale.
5. Put detailed agent governance in `office/`. Keep the root `AGENTS.md` as a short discovery pointer unless project-specific constraints must apply before `office/` is read.
6. Update only the records that matter:
   - Log durable architectural or governance decisions in `office/records/decision-log.md`.
   - Log substantial agent work and validation in `office/records/task-log.md`.
   - Never record credentials, tokens, private keys, or unnecessary verbatim user data.
7. Run the validator and `../../tests/Test-OfficeGovernance.ps1` after changing the governance contract, bootstrap script, validator, skill, templates, or tests.
8. Report what changed, the validation result, and any remaining governance gap.

## Change Rules

- Merge existing instructions; do not weaken or silently discard them.
- Use exact `AGENTS.md` casing for Codex discovery. Treat `Agent.md` or `agent.md` as a migration input, not a second source of truth.
- Keep skill frontmatter limited to `name` and `description`.
- Prefer deterministic scripts for repeatable checks and concise Markdown for policy.
- Keep generated outputs, temporary test projects, and secrets out of `office/records/`.
- Require explicit user authorization before external writes, destructive operations, publishing, or credential use.
