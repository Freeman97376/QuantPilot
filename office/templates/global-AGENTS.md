# Global Agent Instructions

## Mandatory Governance Bootstrap for New Projects

Whenever creating a new project or adopting an existing directory as a project, establish agent governance before substantive feature work:

1. Resolve the real project root. Use `git rev-parse --show-toplevel` for a Git checkout; otherwise use the user-selected project directory.
2. Ensure the root contains a Codex-discoverable `AGENTS.md` that delegates detailed governance to `office/README.md` and `office/AGENTS.md`.
3. Ensure `office/` contains, at minimum, `README.md`, `AGENTS.md`, `skills/`, `scripts/`, `records/`, `templates/`, and `tests/`.
4. Prefer the trusted seed initializer when it exists:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File 'C:\Users\Zheng\Desktop\work project\office\scripts\Initialize-Office.ps1' -ProjectRoot '<absolute-project-root>'
   ```

5. If the seed is unavailable, create the same structure manually. Merge existing `AGENTS.md`, skills, records, and policies; never overwrite or weaken them.
6. Run the generated `office/scripts/Test-OfficeGovernance.ps1` before feature work. Apply stricter project-specific rules when needed.

Use exact `AGENTS.md` casing. Keep detailed agent interaction governance in `office/`, log only durable decisions and substantial task evidence, and never store credentials or unnecessary private user content in governance records.
