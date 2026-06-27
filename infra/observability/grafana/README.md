# Status: deployed & verified live on M2 (2026-06-22)

Validated directly against the running M2 Mini (<mac-mini-ip>, user `<username>`)
on 2026-06-22.

**Running launchd services (all up):**
- `com.example.grafana` — Grafana OSS UI at `http://<mac-mini-ip>:3000`
- `com.example.loki` — Loki log backend on `127.0.0.1:3100`, receiving pushes
- `com.example.alloy` — Grafana Alloy, actively tailing log files
- `com.example.jarvis.health-probe` — host health probe, writing fresh
  `host_health` rows every 60s

**Datasources provisioned (3):** Loki (logs), Jarvis SQLite via
`frser-sqlite-datasource` (`/Users/<username>/.jarvis/conversations.db`), and
Infinity via `yesoreyeram-infinity-datasource` (HTTP probes + GitHub API).

**Dashboards:** 11 provisioned.

**Loki service labels receiving (verified over 14d):** `ion-engine`,
`ion-harness`, `ion-telemetry`, `vec-server`, `imessage`. (`discord-bot` and
the vec error logs are currently empty because those services are healthy and
quiet — expected, not broken.)

**Retention:** Loki 14 days; `host_health` / `host_metrics` 14 days;
`agent_events` and `perf_metrics` pruned in code (`pruneOldEvents` 90d,
`pruneHighFrequencyEvents` 14d, `prunePerfMetrics` 90d in
`harness-ts/src/memory/episodic/index.ts`).

**Known gap:** `voice.error.log` does not exist on the Mini because voice-tts
is not currently deployed, so the Alloy `voice-tts` tail target is currently a
dead path (harmless — Alloy self-heals if the file appears).

**How this was verified:** `launchctl list` for the four service labels, a Loki
label query for the live service streams, and confirming fresh `host_health`
rows landing every 60s.

# Grafana OSS — Jarvis Observability

Grafana is the single monitoring UI for the Jarvis stack, running at
`http://<mac-mini-ip>:3000` on the M2 Mini (user `<username>`).

## Prerequisites — install plugins before loading the plist

Grafana's provisioning wires up datasources by plugin type ID. The two
community plugins must be installed first or their datasources will be
unavailable at startup. Run once on the Mini after `brew install grafana`:

```bash
PLUGINS_DIR=/opt/homebrew/var/lib/grafana/plugins
grafana-cli --pluginsDir "$PLUGINS_DIR" plugins install frser-sqlite-datasource
grafana-cli --pluginsDir "$PLUGINS_DIR" plugins install yesoreyeram-infinity-datasource
```

The `--pluginsDir` flag is required to match the directory the plist passes via
`cfg:default.paths.plugins=/opt/homebrew/var/lib/grafana/plugins`. Without it,
grafana-cli may install to a different default path and Grafana will report the
plugins as missing at startup (silent provisioning failure).

Plugins install into `/opt/homebrew/var/lib/grafana/plugins/`. They persist
across Grafana version upgrades but must be re-installed if the plugins
directory is wiped.

## First-run admin password

Grafana's default credentials are `admin` / `admin`. On first login at
`http://<mac-mini-ip>:3000`, Grafana forces a password change. Set a real
password. Anonymous access is off (`[auth.anonymous] enabled = false` in
`grafana.ini`).

The password is never stored in this repo. If lost, reset via:
```bash
grafana-cli \
  --homepath /opt/homebrew/share/grafana \
  --pluginsDir /opt/homebrew/var/lib/grafana/plugins \
  admin reset-admin-password <newpassword>
```

## Loading the LaunchAgent

```bash
# On Mini (ssh mini):
cp ~/Jarvis/com.example.grafana.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.grafana.plist
launchctl list | grep com.example.grafana
# Should show PID > 0 and no error exit code
```

## Logs

```bash
tail -f ~/Jarvis/logs/grafana.error.log
tail -f ~/Jarvis/logs/grafana.out.log
```

## SQLite WAL note

The SQLite datasource reads `~/.jarvis/conversations.db`. Grafana must run
as `<username>` (the plist LaunchAgent runs as the logged-in user, so this is
automatic) so the WAL shared-memory files (`conversations.db-shm`,
`conversations.db-wal`) are writable. Read-only dashboard queries against a
WAL-mode database are safe from the application side; the WAL writability
requirement is a SQLite internal constraint, not a Grafana one.

If Grafana logs `attempt to write a readonly database`, the process is
running as the wrong user.

## Datasources provisioned

| Name | Type | Endpoint |
|------|------|----------|
| Loki | `loki` (built-in) | `http://127.0.0.1:3100` |
| Jarvis SQLite | `frser-sqlite-datasource` | `~/.jarvis/conversations.db` |
| Infinity | `yesoreyeram-infinity-datasource` | various (see datasources.yaml) |

## Dashboard JSON location

Dashboard JSON files go in:
`infra/observability/grafana/dashboards/`

Grafana polls this directory every 30 seconds. Add `.json` exports there
and Grafana picks them up without a restart. 11 dashboards are currently
provisioned.

## Chrome theming (Jarvis neon-cyan palette)

### Background

Grafana OSS has no native CSS override mechanism. The `[custom_branding]`
and CSS injection APIs are Enterprise-only (confirmed: Grafana issue #71662;
`conf/defaults.ini` has no `custom_css` key). The Boom Theme panel plugin
(yesoreyeram-boomtheme-panel) was the only OSS workaround; it is deprecated,
removed from the plugin catalog, and broken on Grafana 10+.

The approach used here patches Grafana's `public/views/index.html` template
to inject a `<link>` tag pointing to `jarvis-theme.css`, which is copied into
`public/`. This is the only mechanism that reaches Grafana's chrome (page
background, panel borders, topnav) in OSS.

**Maintenance cost:** Homebrew overwrites `public/` on every `brew upgrade
grafana`. Re-run the patch script after each upgrade.

### Apply the theme (run once on Mini, then after each Grafana upgrade)

```bash
# SSH into Mini
ssh mini

# Patch Grafana's index.html, copy jarvis-theme.css into public/,
# and swap the brand assets (sidebar logo, login wordmark, favicons).
bash ~/Jarvis/scripts/patch-grafana-theme.sh

# Restart Grafana to serve the updated files
launchctl kickstart -k gui/$(id -u) com.example.grafana
```

Verify: open `http://<mac-mini-ip>:3000` — page background should be
`#0f1117` (very dark slate) and panel borders `#2a2d3a`, and the sidebar
logo, login-page logo, and browser-tab favicon should show the Jarvis
arc-reactor mark. **Hard-refresh** (Cmd+Shift+R) or use a private window:
favicons and `<img>`-rendered SVG logos cache aggressively, so the stock
Grafana logo can otherwise persist even after a successful swap.

### What the theme changes

- Page background: `#0f1117`
- Panel surfaces: `#1a1d26` with `#2a2d3a` borders
- Accent (links, focus, active tab): neon cyan `#00d4ff`
- Primary text: `#e2e8f0`; muted: `#64748b`
- Font stack: `-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`
- Log panel monospace: `'SF Mono', 'Fira Code', 'Cascadia Code', monospace`
- Status colors: green `#22c55e`, yellow `#eab308`, red `#ef4444`

### Brand swap (Jarvis logo replaces Grafana logo)

The same patch script also replaces Grafana's brand assets with the Jarvis
mark, derived from `docs/JARVIS.png` (a 1774×887 cinematic banner: the
"J.A.R.V.I.S." wordmark on the left, a glowing arc-reactor circle on the
right). The version-controlled Jarvis assets live in
`infra/observability/grafana/branding/` and the script copies them into
Grafana's `public/img/`:

| Branding file | Replaces (in `public/img/`) | Role | Built from |
|---------------|------------------------------|------|------------|
| `grafana_icon.svg` | `grafana_icon.svg` | Sidebar logo **and** login logo | arc-reactor square crop |
| `fav32.png` | `fav32.png` | Browser-tab favicon | arc-reactor crop, 32×32 |
| `apple-touch-icon.png` | `apple-touch-icon.png` | iOS home-screen icon | arc-reactor crop, 180×180 |
| `grafana_typelogo.svg` | `grafana_typelogo.svg` | (no-op in Grafana 13 — see note) | full banner |

Source assets kept in `branding/` for regeneration: `jarvis-icon-512.png`
(512×512 reactor square) and `jarvis-banner-600.png` (600×300 banner).

**Grafana 13 uses `grafana_icon.svg` for both the sidebar menu logo and the
login page logo** (its theme branding sets `logos.small =
"public/img/grafana_icon.svg"` and `logos.large = ""`; verified against the
runtime JS bundle in `public/build/`). So the single arc-reactor square is the
Jarvis mark on both surfaces. `grafana_typelogo.svg` is **not referenced by
the Grafana 13 frontend at runtime** — it is replaced anyway (harmless,
future-proofing) but you will not see it. The full "J.A.R.V.I.S." wordmark
banner is therefore not displayed; if a wordmark is wanted later, it would
have to ride inside `grafana_icon.svg` itself.

**Why the logo SVGs embed base64 PNGs:** `JARVIS.png` is raster, but Grafana
references `grafana_icon.svg` / `grafana_typelogo.svg` by path and renders
them as `<img>` / CSS `background-image`. SVGs loaded that way run in the
browser's *secure static* mode, which **blocks external resource references**
(`<image href="other.png">` renders blank). The Jarvis SVGs therefore embed
the PNG inline as a `data:image/png;base64,…` URI, which is allowed.

**`grafana_mask_icon.svg` is left stock on purpose:** it is a Safari
pinned-tab *mask* (single-color silhouette; the browser applies the `color`
attribute). A full-color raster embed would not render as intended, so the
script does not touch it.

**Re-run after `brew upgrade grafana`:** like the theme, the brand swap lives
in `public/img/` which Homebrew overwrites on every upgrade. Re-running the
patch script restores both. The script is idempotent — it backs up each
stock file to `<file>.orig` *only* on the first overwrite, so a re-run never
clobbers an already-saved original.

### Rollback brand only (restore Grafana's logo)

The first patch run backs up each original brand file to `<file>.orig`.
Restore them and restart Grafana:

```bash
ssh mini
cd /opt/homebrew/share/grafana/public/img
for f in grafana_icon.svg grafana_typelogo.svg fav32.png apple-touch-icon.png; do
  [[ -f "$f.orig" ]] && cp "$f.orig" "$f"
done
launchctl kickstart -k gui/$(id -u) com.example.grafana
```

(A `brew upgrade grafana` also restores stock branding, since it rewrites
`public/`.)

### Rollback theme only (without stopping Grafana)

Remove the `<link>` line from `/opt/homebrew/share/grafana/public/views/index.html`
and restart Grafana. Stock dark mode remains (controlled by `default_theme = dark`
in `grafana.ini`).

## Drill-down

`jarvis-logs-explorer` (uid `jarvis-logs-explorer`) is the shared drill-down
target for all other Jarvis observability dashboards. When an error/health panel
in another dashboard (e.g. `jarvis-errors-health`) carries a data link, it
pre-fills this dashboard's template variables via URL parameters so the user
lands in context:

| URL parameter | Variable | Purpose |
|---------------|----------|---------|
| `var-service` | `service` | Pre-select one or more services (multi-value). Use `All` for fleet-wide. |
| `var-level` | `level` | Free-text LogQL regex, e.g. `error\|critical\|fatal`. Default: `error\|critical\|fatal\|warn\|warning`. |
| `var-search` | `search` | Optional LogQL line filter (substring or regex). Empty matches all lines. |

Example data-link URL appended to a panel linking into the drill-down:

```
/d/jarvis-logs-explorer/jarvis-logs-explorer?var-service=ion&var-level=error%7Ccritical%7Cfatal&from=${__from}&to=${__to}
```

The `level` variable is a free-text regex field -- the full pipe-delimited form
(`error|critical|fatal`) is valid LogQL inside `| level=~"$level"`. The
`search` variable is fed directly to `|~ "$search"` -- an empty string matches
all lines and is a safe no-op.

When adding data links to other dashboards, always pass `from` and `to` so
the drill-down opens on the same time window the user was already viewing.

## Rollback

```bash
launchctl unload ~/Library/LaunchAgents/com.example.grafana.plist
```

Grafana stops. No other services are affected. Datasources, dashboards,
and the theme patch are preserved in the repo.
