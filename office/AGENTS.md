# Project Agent Governance Contract

This file governs agent work across the whole project because the root `AGENTS.md` delegates here.

## Start Every Task

1. Resolve the real project root before reading, editing, running, or reporting on files.
2. Inspect existing instructions and working-tree state. User changes are owned by the user unless proven otherwise.
3. Read only the project references and skills needed for the request.
4. Separate confirmed repository facts from assumptions. Verify drift-prone facts when practical.

## Interaction and Authority

- Answer and diagnose with read-only evidence unless the user asks for implementation.
- Treat a request to change or build as authority for normal, in-scope implementation and validation only.
- Ask before destructive actions, external publishing, account changes, credential use, or material scope expansion.
- Preserve existing instructions and uncommitted work. Merge overlapping changes rather than resetting or replacing them.
- Communicate progress during tool-heavy work and finish with the outcome, validation, and any blocker.

## Where Agent Content Belongs

- Put project-wide agent policy in this file.
- Put reusable procedures in a named folder under `skills/`, with a valid `SKILL.md` and `agents/openai.yaml`.
- Put repeatable deterministic operations in `scripts/`.
- Put durable decisions and substantial task evidence in `records/`.
- Put governance verification under `tests/`.
- Put clean bootstrap source files under `templates/`.
- Keep product documentation and product tests in their normal project locations; `office/` governs agent work and is not a dumping ground.

## Record Policy

Update `records/decision-log.md` when a decision changes future behavior, architecture, security, release policy, or agent governance. Update `records/task-log.md` for substantial implementation, audit, migration, or handoff work.

Do not log trivial questions, routine formatting, raw chain-of-thought, full chat transcripts, generated noise, secrets, tokens, private keys, or personal data. Correct a prior record by adding a superseding entry; do not silently rewrite history.

## Skills

Use `skills/manage-agent-governance/SKILL.md` when initializing, auditing, repairing, or changing this governance system. Skill instructions supplement this contract and cannot weaken user instructions or higher-priority policy.

## Validation and Completion

Run the smallest relevant checks for product work. When any file under `office/` or the root `AGENTS.md` changes, run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\office\scripts\Test-OfficeGovernance.ps1
```

When governance scripts, templates, skills, or tests change, also run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\office\tests\Test-OfficeGovernance.ps1
```

A handoff is complete only when the requested outcome is present, relevant validation has run, and remaining risks or skipped checks are stated plainly.
