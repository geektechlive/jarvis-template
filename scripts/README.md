# Scripts

Hand tools for Jarvis. Each script is an isolated capability called by staff agents or the scheduler.

## I/O Contract

All scripts follow a strict contract:

- **Stdin**: Never used. All input comes from args or environment.
- **Stdout**: Valid JSON on success, or human-readable plain text. Agents parse JSON; humans read plain text.
- **Stderr**: All errors and progress messages. Unbuffered for real-time streaming.
- **Exit codes**: 0=success, 1=usage error or runtime failure, 2=missing dependency.
- **Credential pattern**: Use `security find-generic-password -s com.example.jarvis -a <account> -w` to fetch secrets from Keychain. Never hardcode.
- **Shell discipline**: Bash scripts must start with `#!/usr/bin/env bash` and `set -euo pipefail`.

A template skeleton is provided at `scripts/TEMPLATE.sh`.

## Script Inventory

| Script | Purpose | Input | Output | Notes |
|--------|---------|-------|--------|-------|
| `ion-serve.sh` | LaunchAgent wrapper; starts ion serve and establishes Jarvis session | None | ion logs to stderr | Internal; not called by agents |
| `daemon.sh` | Local daemon start/stop/restart/status/logs for com.example.jarvis | `$1=start\|stop\|restart\|status\|logs` | Status text | Dev tool |
| `deploy.sh` | Delegates to `make deploy-ion` | None | make output | Thin shim |
| `setup_mini.sh` | One-time Mac Mini provisioning | None | Progress text | Run once |
| `tui-remote.sh` | Legacy TUI launcher (no active callers; TUI layer removed) | None | N/A | **Deprecated** |
| `find-file.sh` | mdfind filename search under /Users/<username> | `$1=query string` | Bare paths, one per line (max 20) | Filters trash/cache |
| `calendar-check.py` | Fetch iCloud calendar events via CalDAV | `--days N`, `--start`, `--end`, `--json`, `--calendars` | Human-readable or `--json` list | Credentials from Keychain |
| `calendar-write.py` | Create iCloud calendar event via CalDAV PUT | `--title`, `--date`, `--start`, `--end`, `--calendar` | Confirmation text | Credentials from Keychain |
| `calendar-delete.py` | Delete iCloud calendar event via CalDAV DELETE | `--uid UUID` or `--title TEXT --date DATE` | Confirmation text | Credentials from Keychain |
| `calendar-update.py` | Update an existing iCloud calendar event via CalDAV PUT | `--uid UUID`, `--title`, `--date`, `--start`, `--end`, `--calendar` | Confirmation text + UID | Credentials from Keychain |
| `mail-check.py` | Fetch Gmail + iCloud mail via IMAP | `--search`, `--uid --body`, `--mark-read`, `--json` | Human-readable or `--json` list | Credentials from Keychain |
| `netflix-history.ts` | Fetch Netflix viewing history via shakti API | None (reads env/config) | `{"count": N, "outputPath": "...", "fetchedAt": "..."}` | Writes JSONL to iCloud Drive |
| `files-check.py` | Scan Downloads/Documents/iCloud Drive for recent files | None | Markdown list (max 20, last 24h) | No `--json` flag |
| `improve-review.py` | Review a self-improvement branch via Claude CLI | `$1=branch name` | Line 1: `approve\|reject`; Line 2: reason | Exit 0=approve, 1=reject |
| `audit_stubs.py` | Scan harness/ for stub/placeholder code patterns | None | Appends to `audit_findings.json` | Dev tool |
| `audit_errors.py` | Scan harness/ for exception-swallowing patterns | None | Appends to `audit_findings.json` | Dev tool |
| `perf_report.py` | Read perf_metrics SQLite table; compare P50/P95/P99 to budgets | None | Report to stdout | Exit 1 if any P95 exceeds budget |
| `ingest_mbwpicks.py` | Bulk-ingest MBW Picks podcast show-notes into knowledge base | None | Progress text | One-shot ingest |
