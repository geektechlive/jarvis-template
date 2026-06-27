#!/usr/bin/env bash
set -euo pipefail

# Validates that every active staff member in staff.yaml has an agent spec in
# harness/agents/, which is the source of truth bundled into the extension
# (dist/agents/) and loaded into the dispatch roster at runtime. The old check
# (presence in a BEHAVIOR.md roster table) is gone: the staff catalog is now
# injected dynamically from the bundled specs, so BEHAVIOR.md no longer carries
# a per-agent table to drift against.

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAFF_YAML="$REPO_ROOT/harness/config/staff.yaml"
AGENTS_DIR="$REPO_ROOT/harness/agents"

# Extract ids of all active staff members from staff.yaml.
active_ids=$(awk '
  /^  - id:/ {
    if (in_block && status == "active" && id != "") print id
    in_block = 1; id = $3; status = ""
  }
  in_block && /^    status:/ { status = $2 }
  END {
    if (in_block && status == "active" && id != "") print id
  }
' "$STAFF_YAML")

missing=()
while IFS= read -r id; do
  [[ -z "$id" ]] && continue
  # staff.yaml ids may use underscores; agent files use hyphens.
  file_id="${id//_/-}"
  # Specs live anywhere under harness/agents/ (departments/<dept>/{lead,specialists}/,
  # staff/, consultants/) since the ion-dev department restructure — match by filename.
  if [[ -z "$(find "$AGENTS_DIR" -type f -name "$file_id.md" -print -quit 2>/dev/null)" ]]; then
    missing+=("$id")
  fi
done <<< "$active_ids"

if [ ${#missing[@]} -gt 0 ]; then
  echo "ERROR: validate-staff: active staff missing an agent spec under harness/agents/:" >&2
  for id in "${missing[@]}"; do
    echo "  - $id (expected a file named ${id//_/-}.md somewhere under harness/agents/)" >&2
  done
  echo "" >&2
  echo "Fix: create the agent spec under harness/agents/ (departments/<dept>/, staff/, or consultants/), then re-run make check." >&2
  exit 1
fi

count=$(echo "$active_ids" | grep -c '.' || true)
echo "validate-staff: OK ($count active staff all have agent specs under harness/agents/)"
