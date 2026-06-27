# staff-tools

The sanctioned home for tools Jarvis or his staff create when no existing tool fits.

## Why this folder exists

Jarvis's working directory on the Mac Mini is also the production deploy checkout. The
deploy-watchdog runs `make check` (which lints `harness/ tools-py/ scripts/ tests/` and
`harness-ts/`) before every deploy. A stray file written into any of those paths can
fail the lint and wedge the deploy. This folder is **outside** the lint surface, so tools
authored here can never poison the build.

## The contract

- **Create here, never in the deployed source tree.** When you need a capability and no
  tool exists, write it in `staff-tools/`. Do not write generated scripts into `harness/`,
  `harness-ts/`, `tools-py/`, `scripts/`, or `tests/`.
- **Check first.** Before building, look for an existing tool in `~/bin`, `scripts/`, and
  here. Reuse beats re-creating.
- **Run in place.** Invoke directly, e.g. `python3 staff-tools/<name>.py` (or
  `uv run python staff-tools/<name>.py`). These tools are not installed to `~/bin`.
- **No secrets.** These files are committed and shared. Read credentials from the
  environment or the usual creds files, never inline.
- **Committed automatically.** A sync routine commits new files here onto an
  `auto/staff-tools-*` branch and opens a PR. You do not (and must not) commit to `main`
  on the Mini yourself.

## Relationship to `scripts/`

`scripts/` holds deliberately-promoted, lint-clean, human-reviewed capabilities that are
installed to `~/bin` by `make deploy-scripts-local`. `staff-tools/` holds agent-authored
operational tools that are preserved and reusable but not held to core-source lint. A
tool that proves durable can be promoted from here into `scripts/`.
