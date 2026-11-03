# JEUS Lens v1.0.4 — Live monitoring and Connect workspace

## Added
- Local file append monitoring: explicit user-selected Chromium File System Access handle, 2-second change polling, bounded 1MiB reads of newly appended bytes, separate live event explorer and column sorting. A 5,000-event in-memory limit applies; the pre-existing immutable import index remains unchanged.
- New left-hand **Connect** workspace separated from local file analysis, including dedicated read-only remote log event explorer, error/warning statistics, per-column sorting and diagnostics.
- Incremental remote SSH/SFTP log reading for both Go and Rust from optional byte offset (`fromOffset`). Bounded maximum 512KiB response; repeated 10-second refreshes append newly written bytes instead of repeatedly showing the same window. Cursor reset is signaled when a file shrinks.
- Connection access-control gateway labels for **DBSAFER AM**, **SecureGuard AM**, **DB-i** and generic SSH/SFTP gateways. The existing password entry can authenticate to an **administrator-approved, SFTP-compatible gateway endpoint**.

## Security
- Keep strict SSH SHA256 host-key pinning, no remote shell execution or file modification, and no saved session passwords in connection profiles.
- Proprietary gateway protocols, separate proxy and backend passwords, OTP/MFA prompts, mandatory approvals and SSH jump-host authentication are **not implemented**. Listing a product is not proof of interoperability; verify the organization's exact product/version and approved SFTP endpoint before relying on this feature.
- No attempt to circumvent DBGuard or other security policies.

## Important limitations
- Local file append events are shown separately and are not folded into the existing immutable historical index or totals. Local historical column sorting applies only to the displayed 100-event page; remote and live explorers show a bounded recent window.
- The local watcher detects file shrinking/rewriting near the read cursor and stops instead of silently accepting inconsistent data; an unchanged-size rotation or rewrite outside the checked tail may be undetected.
- Remote rotation with a replacement file of equal/greater size is not detected by size-only cursor tracking. Start a fresh connection to resynchronize.
- Actual Windows runtime and third-party gateway behavior require verification in the customer's environment; generated EXEs are not code-signed.

## Verification gates
- Run Go unit, race, static analysis, Chromium end-to-end UI and Windows x64 build.
- Run independent Rust Windows x64 native build, Rust/Go API parity, live OpenSSH read-only SFTP smoke including incremental cursor/rotation tests and performance comparison.
- Official release workflow requires BOTH Go and Rust main-branch CI successes for one exact immutable commit, verifies Windows binary signatures and independent SHA256 checksums, publishes six assets after re-download validation, and never overwrites earlier tags/releases.
