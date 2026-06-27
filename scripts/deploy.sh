#!/usr/bin/env bash
# Deploy Jarvis to the Mac Mini.
#
# This script delegates to `make deploy-ion`, which is the only correct way
# to deploy this project. A previous version of this script tried to bypass
# the Makefile by ssh'ing in and running `launchctl kickstart` directly, but:
#
#   1. It referenced a service label (`com.example.jarvis`) that does
#      not exist on the Mini -- the real one is `com.dsswift.ion`.
#   2. It skipped the five mandatory deploy steps that `make deploy-ion`
#      performs: git submodule sync, `go build` of the ion engine, ad-hoc
#      codesign, esbuild of harness-ts/dist/extension.js, and copying agent
#      specs into ~/.claude/agents/. Skipping any of these silently leaves
#      the Mini on stale code.
#
# Usage:
#   ./scripts/deploy.sh
#   MINI_HOST=mymini ./scripts/deploy.sh

set -euo pipefail

cd "$(dirname "$0")/.."
exec make deploy-ion
