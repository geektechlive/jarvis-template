#!/usr/bin/env bash
# patch-grafana-theme.sh
#
# Injects the Jarvis neon-cyan theme into Grafana's index.html template AND
# swaps Grafana's brand assets (sidebar logo, login wordmark, favicons) for
# Jarvis ones derived from docs/JARVIS.png.
#
# MUST be re-run after every `brew upgrade grafana` because Homebrew
# overwrites /opt/homebrew/share/grafana/public/ on each upgrade.
#
# Usage (on Mac Mini):
#   bash ~/Jarvis/scripts/patch-grafana-theme.sh
#
# What it does:
#   1. Copies jarvis-theme.css into Grafana's public/ directory.
#   2. Injects a <link> tag into Grafana's index.html template (once only).
#   3. Backs up Grafana's original brand files to *.orig (once only) and
#      replaces them with the Jarvis brand assets in branding/.
#   4. Does NOT restart Grafana — run `launchctl kickstart -k gui/$(id -u) com.example.grafana`
#      or cycle the LaunchAgent after patching.
#
# Reversible: every overwritten brand file is backed up to <file>.orig before
# the first overwrite. Rollback = restore the *.orig files (see README).

set -euo pipefail

GRAFANA_PUBLIC="/opt/homebrew/share/grafana/public"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
THEME_SRC="$REPO_ROOT/infra/observability/grafana/jarvis-theme.css"
THEME_DEST="$GRAFANA_PUBLIC/jarvis-theme.css"
INDEX_TMPL="$GRAFANA_PUBLIC/views/index.html"
BRANDING_SRC="$REPO_ROOT/infra/observability/grafana/branding"
GRAFANA_IMG="$GRAFANA_PUBLIC/img"
# href needs the public/ prefix: Grafana's index uses <base href="/">, so a bare
# "jarvis-theme.css" resolves to /jarvis-theme.css (a 302 app-route, not the asset).
# Serve it at /public/jarvis-theme.css to match the other public/build/* links.
LINK_TAG='<link rel="stylesheet" href="public/jarvis-theme.css" />'

# ── Safety checks ─────────────────────────────────────────────────────────
if [[ ! -d "$GRAFANA_PUBLIC" ]]; then
  echo "ERROR: $GRAFANA_PUBLIC not found. Is Grafana installed via Homebrew?" >&2
  exit 1
fi

if [[ ! -f "$THEME_SRC" ]]; then
  echo "ERROR: $THEME_SRC not found. Run from within the Jarvis repo." >&2
  exit 1
fi

if [[ ! -f "$INDEX_TMPL" ]]; then
  echo "ERROR: $INDEX_TMPL not found. Grafana version may be unexpected." >&2
  exit 1
fi

if [[ ! -d "$BRANDING_SRC" ]]; then
  echo "ERROR: $BRANDING_SRC not found. Run from within the Jarvis repo." >&2
  exit 1
fi

# ── Step 1: copy theme CSS ────────────────────────────────────────────────
echo "Copying jarvis-theme.css to $THEME_DEST ..."
cp "$THEME_SRC" "$THEME_DEST"
echo "  done."

# ── Step 2: inject <link> tag (idempotent) ────────────────────────────────
if grep -qF 'jarvis-theme.css' "$INDEX_TMPL"; then
  echo "<link> tag already present in $INDEX_TMPL — skipping injection."
else
  echo "Injecting <link> tag into $INDEX_TMPL ..."
  # Insert before closing </head>. Use sed in-place (BSD sed on macOS needs -i '').
  sed -i '' "s|</head>|  ${LINK_TAG}\n</head>|" "$INDEX_TMPL"
  echo "  done."
fi

# ── Step 3: swap brand assets (backup-once, then copy; idempotent) ─────────
# Map: <branding source file>  ->  <file under Grafana public/img/>
# - grafana_icon.svg      sidebar AND login logo (base64-embedded PNG) — the
#                         Grafana 13 frontend uses this one file for both.
# - fav32.png             browser-tab favicon    ([[.FavIcon]])
# - apple-touch-icon.png  iOS home-screen icon   ([[.AppleTouchIcon]])
# - grafana_typelogo.svg  no-op in Grafana 13 (not referenced at runtime);
#                         replaced anyway for future-proofing.
#
# NOTE: grafana_mask_icon.svg (Safari pinned-tab) is left STOCK on purpose:
# it is a single-color silhouette mask, so a full-color raster embed would not
# render as intended. Not worth fighting.
echo ""
echo "Swapping Grafana brand assets ..."
BRAND_FILES=(grafana_icon.svg grafana_typelogo.svg fav32.png apple-touch-icon.png)
for f in "${BRAND_FILES[@]}"; do
  src="$BRANDING_SRC/$f"
  dest="$GRAFANA_IMG/$f"
  if [[ ! -f "$src" ]]; then
    echo "  WARN: $src missing — skipping $f" >&2
    continue
  fi
  if [[ -f "$dest" && ! -f "$dest.orig" ]]; then
    # Back up the stock Grafana asset once, before the first overwrite.
    cp "$dest" "$dest.orig"
    echo "  backed up $f -> $f.orig"
  fi
  cp "$src" "$dest"
  echo "  installed $f"
done
echo "  done."

# ── Done ──────────────────────────────────────────────────────────────────
echo ""
echo "Theme + brand patched. Restart Grafana to apply:"
echo "  launchctl kickstart -k gui/\$(id -u) com.example.grafana"
echo ""
echo "To verify, open http://<mac-mini-ip>:3000 — the page background should"
echo "be #0f1117 (very dark slate), panel borders #2a2d3a, and the sidebar"
echo "logo + login wordmark + browser-tab favicon should show the Jarvis mark."
