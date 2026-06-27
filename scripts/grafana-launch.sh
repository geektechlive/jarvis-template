#!/bin/sh
# Grafana launcher. Sources the M2-Mini fine-grained GitHub PAT from .env into the
# Grafana process environment so the Infinity datasource can authenticate to the
# private <your-org>/jarvis GitHub API (datasources.yaml references it as
# $__env{GITHUB_TOKEN}). The token stays OUT of the repo — only this reference and
# the provisioning placeholder are committed; the value lives in the gitignored .env.
GITHUB_TOKEN="$(grep -E '^GITHUB_TOKEN=' /Users/<username>/Jarvis/.env | cut -d= -f2-)"
export GITHUB_TOKEN
exec /opt/homebrew/bin/grafana server \
  --config /Users/<username>/Jarvis/infra/observability/grafana/grafana.ini \
  --homepath /opt/homebrew/share/grafana \
  --packaging=brew \
  cfg:default.paths.data=/opt/homebrew/var/lib/grafana \
  cfg:default.paths.logs=/opt/homebrew/var/log/grafana \
  cfg:default.paths.plugins=/opt/homebrew/var/lib/grafana/plugins
