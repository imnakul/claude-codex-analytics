# Changelog

All notable changes to Codex Analytics Ledger will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
the project intends to follow [Semantic Versioning](https://semver.org/) after
the first public release.

## [Unreleased]

### Added

- A Codex / Claude switch within the existing local dashboard.
- Read-only Claude Code transcript, history, index, and subagent analytics with
  per-request model usage, cache-write pricing, and a tool-call ledger.
- Optional timestamped tool-hook log ingestion and a metadata-only Python hook
  collector; missing data and estimated runtime are identified in the UI.
- Synthetic reader, pricing, and provider API regression tests.

- Public security policy, contribution guide, code of conduct, and GitHub
  collaboration templates.
- Explicit documentation for privacy boundaries, compatibility, configuration,
  API-equivalent pricing, and release verification.

### Changed

- Renamed the product to Codex Analytics Ledger.
- Bound standard development and production scripts to `127.0.0.1`.
- Disabled Next.js telemetry in standard scripts.
- Aligned SQLite configuration precedence with current Codex documentation.
- Replaced detailed analytics API error responses with a generic client message.

## Release links

Release comparison links will be added after the GitHub repository URL is known.
