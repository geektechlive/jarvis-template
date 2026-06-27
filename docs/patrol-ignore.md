# Patrol Ignore List

Findings that have been **deliberately accepted** and must NOT be re-filed by any patrol routine. Each entry has a pattern (so the agent can semantic-match), a reason, and a reference to the original issue that decided this.

When patrol scans the codebase or logs, it must check this file as the final step before filing a new issue. If the finding matches any entry here, **skip it — do not file**.

---

## Hardcoded values that are intentionally hardcoded

### `<mac-mini-ip>` in any CI / deploy / config file
- **Pattern**: hardcoded IP `<mac-mini-ip>` (the M2 Mini)
- **Why accepted**: The M2 Mini has a static LAN IP, not DHCP. Discovery via mDNS / `mini.local` is unreliable on macOS LaunchAgents. Hardcoding is the deliberate choice; if the IP ever changes (network reconfiguration), CI fails loudly, which is acceptable.
- **Locations known to contain it**: `.github/workflows/desktop-deploy.yml`, `Makefile` (`MINI_HOST` / `MINI_IP`), `harness/config/integrations.yaml`, `~/.ion/engine.json` on Mini.
- **Decided**: 2026-05-26
- **Original issue**: #383

---

## Integrations with capability provided outside `harness-ts/src/tools/`

### Missing TypeScript tool for an integration whose config has an `implementation:` field

- **Pattern**: a finding that says "no TypeScript tool exists for X" / "no `harness-ts/src/tools/X.ts` file" / "tool missing from harness-ts" / "integrations.yaml configures X but no TS implementation found"
- **Why accepted**: When an `integrations.yaml` config block lists an `implementation:` field, the capability is **deliberately provided outside of `harness-ts/src/tools/`** — typically via a Python script in `scripts/` invoked by an agent. The absence of a TS tool is intentional. Reading the `implementation:` value is part of the assessment.
- **Examples**:
  - `mail.implementation = scripts/mail-check.py` — mail is read by the Chief of Communications agent shelling out to `~/bin/mail-check` on a `comms_pulse` cadence. No TS `read_mail` tool is needed. Credentials are at `~/.jarvis-mail-creds`, not in integrations.yaml.
- **How to check**: before filing any "missing TS tool" finding, grep the relevant integration block in `harness/config/integrations.yaml` for `implementation:`. If present, the integration already has a working capability provider; do not file.
- **Decided**: 2026-05-26
- **Original issue**: #350 (a TS IMAP tool was implemented and then removed as redundant; the Python script remains canonical)

---

## How to add an entry

When you decide a patrol finding is genuinely a non-issue (intentional design choice, accepted trade-off, external constraint), add a heading under the appropriate category with:

```markdown
### Short pattern description
- **Pattern**: what to match (string, regex idea, or semantic phrasing)
- **Why accepted**: the reason it's OK
- **Locations**: known files where it appears (optional)
- **Decided**: YYYY-MM-DD
- **Original issue**: #N
```

Then close the corresponding open issue with a comment pointing at this file.

## How patrol consumes this file

Each patrol routine (`log_patrol`, `commit_patrol`, `issue_patrol`, `improve_patrol`) reads this file at the start of every run and injects it into the agent's prompt. The agent's final filter, before running `gh issue create`, is to check candidate findings against these entries.

If you want patrol to re-evaluate something currently on the list, remove the entry. The next patrol cycle will surface it again if it's still a real problem.
