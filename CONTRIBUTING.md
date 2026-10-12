# Contributing to Codex Analytics Ledger

Thank you for improving Codex Analytics Ledger. Contributions should preserve
its local-first, read-only privacy boundary.

## Before you start

For substantial features or state-format changes, open a proposal first so the
data model, privacy impact, and UX can be reviewed before implementation.

Never include real Codex state, prompts, transcripts, credentials, screenshots
with personal data, or machine-specific paths in an issue or pull request.

## Development setup

Requirements:

- Node.js 24 or newer
- npm
- Local Codex or Claude Code data for manual testing (use synthetic data for PRs)

Install and start:

```bash
npm ci
npm run dev
```

Open <http://localhost:3000>. Keep the server bound to `127.0.0.1`.

## Architecture expectations

- Keep Codex database access read-only.
- Validate external and persisted data with Zod.
- Keep server-only filesystem access out of client components.
- Prefer small, composable TypeScript modules and explicit return types.
- Preserve loading, empty, error, disabled, and mobile states.
- Use semantic HTML and accessible keyboard interactions.
- Use Tailwind utilities for interface styling.
- Do not add telemetry, hosted storage, or model calls without an approved design
  that clearly changes the project's privacy contract.

## Verification

Run all required checks before opening a pull request:

```bash
npm run test
npx tsc --noEmit
npx eslint . --fix
npm run build
```

Synthetic tests cover provider selection, Claude parsing and hook reconciliation,
and API-equivalent pricing. Add synthetic regression cases for state-format
changes and describe sanitized browser verification in the pull request.

## Pull requests

- Keep changes focused and explain user-visible behavior.
- Update README.md and CHANGELOG.md when behavior or setup changes.
- Document privacy, compatibility, and migration implications.
- Confirm that no generated state, environment files, or personal paths are
  included.
- Use synthetic examples and screenshots.
- Link the relevant issue or proposal.

By contributing, you agree that your contribution is licensed under the
project's MIT License and that you will follow the Code of Conduct.
