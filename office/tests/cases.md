# Office Governance Test Cases

The automated test script covers these cases:

1. **Current seed is valid**: the canonical project passes all required-file, managed-block, skill-frontmatter, and PowerShell parse checks.
2. **Existing instructions are preserved**: initialization adds the managed office block to a pre-existing root `AGENTS.md` without removing its original content.
3. **Initialization is idempotent**: running the initializer twice leaves exactly one managed office block.
4. **Missing governance content fails**: deleting a required record in an isolated temporary project makes the validator return a non-zero exit code.

The test owns and removes only its GUID-named directory beneath the operating-system temporary directory.
