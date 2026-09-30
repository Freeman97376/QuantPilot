# Office: Agent Governance Center

`office/` is the canonical home for project governance that affects agents: instructions, reusable skills, deterministic scripts, durable records, templates, and governance test cases. The root `AGENTS.md` remains intentionally small so Codex can discover this directory.

## Authority Map

| Path | Purpose | Update rule |
| --- | --- | --- |
| `../AGENTS.md` | Codex-discoverable project entry point | Keep short; merge, never overwrite existing rules |
| `AGENTS.md` | Full project agent contract | Change deliberately and log durable decisions |
| `skills/` | Reusable agent workflows | Validate each skill after edits |
| `scripts/` | Bootstrap and structural validation | Keep deterministic and fail loudly |
| `records/decision-log.md` | Durable governance decisions | Append or supersede; do not rewrite history |
| `records/task-log.md` | Substantial agent work and validation | Append concise, evidence-based entries |
| `tests/` | Automated and documented governance cases | Run after governance changes |
| `templates/` | Clean files used by project bootstrap | Keep generic; never put project secrets here |

## Agent Startup Sequence

1. Confirm the actual project root and inspect the current working state.
2. Read the root `AGENTS.md`, this index, and `office/AGENTS.md`.
3. Load only the relevant skill under `office/skills/`.
4. Perform the requested work within the user's authorization.
5. Record a task or decision only when it will help a future agent understand durable state.
6. Validate in proportion to risk and report concrete evidence.

## New Project Bootstrap

From this governance seed, initialize another existing project directory without overwriting its files:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\office\scripts\Initialize-Office.ps1 -ProjectRoot 'C:\path\to\project'
```

Then run the generated validator in the target project. The global `C:\Users\Zheng\.codex\AGENTS.md` requires this bootstrap for every newly created or newly adopted project.

## Naming and Record Safety

- Use `AGENTS.md` exactly. Do not maintain parallel `Agent.md` or `agent.md` instruction files.
- Do not copy credentials, tokens, personal data, private prompts, or large chat transcripts into records.
- Prefer links to repository evidence over copied logs. Redact sensitive values when a short excerpt is necessary.
- Keep temporary outputs outside `office/` and remove only temporary paths created by the relevant test or script.
