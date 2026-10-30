# JEUS Lens v1.0.3 — Verified remote log parity and preview corrections

## Fixed
- Go/Rust SSH host validation parity. Both accept DNS-style names and valid IPv4/IPv6 literals; malformed colon-containing names are rejected before network access.
- Remote log type selection now controls HTTP classification. Application, error, and system logs no longer count embedded HTTP request strings as access log entries.
- JEUS numeric severity `[0]` / `[1]` is detected as error/warning in remote previews.
- Previous remote content is cleared on every new request, failure, cancellation or connection configuration change.
- Synthetic JEUS, WebtoB 5/6 and real local OpenSSH SFTP fixtures plus Chromium UI regressions are extended.

## Limitations and security
- HTTP status counting recognizes the standard quoted request/status format only. Customized WebtoB LOGGING layouts are not automatically parsed.
- Remote access remains SFTP-only, with SSH host-key SHA256 pinning and no shell, exec, upload, modification or deletion API. Administrators must separately enforce read-only server account permissions.
- Tests use an ephemeral CI OpenSSH instance and synthetic middleware logs rather than production servers.
- Executables are unsigned. v1.0.2 assets remain unchanged.
- Release is published only after successful Go and Rust verification of the same commit, Windows x64 builds and SHA-256 re-download checks.
