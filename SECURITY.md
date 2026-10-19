# Security Policy

Codex Analytics Ledger reads sensitive local Codex metadata. Security reports
must never include real prompts, transcripts, databases, authentication files,
environment variables, usernames, or absolute machine paths.

## Supported versions

Until the first stable release, security fixes are provided only for the latest
published `0.x` version.

| Version | Supported |
| --- | --- |
| Latest `0.x` | Yes |
| Older `0.x` | No |

## Report a vulnerability

Use GitHub's private vulnerability reporting flow under **Security → Report a
vulnerability**. Repository maintainers should enable private vulnerability
reporting before the first public release.

If private reporting is unavailable, contact a maintainer privately through
their GitHub profile and request a secure reporting channel. Do not open a public
issue containing exploit details or sensitive data.

Include only sanitized information:

- A concise description and realistic impact
- Affected version and commit
- Operating system, Node.js version, and Codex version
- Minimal reproduction steps using synthetic data
- Suggested mitigation, when known

Maintainers should acknowledge a complete report within seven days and provide
status updates as investigation progresses. Disclosure timing will be coordinated
with the reporter after a fix or mitigation is available.

## Security boundary

The supported default assumes:

- The standard scripts are used and the dashboard is opened through `localhost`.
- The machine and local user account are trusted.
- Codex state is readable only by intended local users.
- The dashboard is not placed behind a public proxy or port-forward.

Remote deployment, shared-machine isolation, and protection from a compromised
local account are outside the current security boundary.

## Sensitive files

Never commit or attach:

- `.codex/` directories
- `auth.json`, configuration secrets, or access tokens
- `state_*.sqlite`, `*.db`, journal, WAL, or shared-memory files
- Session or archived-session JSONL files
- `.env` files
- Screenshots containing prompts, project paths, usernames, or customer data

Use synthetic fixtures for security research and compatibility tests.
