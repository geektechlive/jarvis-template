---
title: Contributing
description: Developer guide for working on Jarvis code, tests, and deployments.
sidebar_position: 10
---

# Contributing

Welcome to Jarvis development. This guide covers how to set up your environment, run checks, write tests, and deploy changes correctly.

## Prerequisites

- **macOS 26 (Tahoe)** or later
- **Homebrew** (for esbuild, node, uv)
- **Git** with submodule support
- SSH access to Mac Mini (<mac-mini-ip>) for deployment

## Dev Environment Setup

### Clone and Initialize

```bash
git clone https://github.com/<your-org>/jarvis.git
cd Jarvis
make setup
```

This runs `git submodule update --init --recursive` to fetch the ion engine source and configures the upstream remote for ion.

### Install Dependencies

```bash
# Python dependencies (all groups: dev, voice, rerank, graph)
uv sync --all-groups

# TypeScript dependencies
cd harness-ts
npm install
cd ..
```

All Python tools (ruff, pyright, pytest) and Node tools (TypeScript, esbuild, vitest) are now available in your environment.

## Running Checks

### `make check` (required before every commit)

```bash
make check
```

This runs:

1. **Python Linting**: `ruff check harness/ tests/` — formatting and style
2. **Python Type Checking**: `pyright harness/` — strict type analysis
3. **Python Tests**: `pytest tests/ -v` — all tests in `tests/` directory
4. **TypeScript Type Checking**: `npm run typecheck` (from harness-ts) — strict TS + extra flags
5. **TypeScript Tests**: `npm test` (from harness-ts) — vitest suite
6. **Staff Validation**: `scripts/validate-staff.sh` — verifies staff.yaml structure

**Why run before every commit:** CI only runs on pull requests, not on direct pushes to main. `make check` is the local gate that ensures your code meets project standards.

### Individual Checks

```bash
# Python linting only
uv run ruff check harness/ tests/

# Python type checking
uv run pyright harness/

# Python tests
uv run pytest tests/ -v

# TypeScript type checking
cd harness-ts && npm run typecheck

# TypeScript tests
cd harness-ts && npm test

# TypeScript linting
cd harness-ts && npm run lint
```

## Test Suite

### Python Tests

Located in `tests/`. All tests run **without Ollama, network access, or external services**. This allows local development and CI without special infrastructure.

Run all tests:
```bash
uv run pytest tests/ -v
```

Run a single test file:
```bash
uv run pytest tests/test_store.py -v
```

**Key principle:** Tests in `tests/` must be fully isolated. Use in-memory databases (`:memory:` for SQLite) and mock external APIs.

### TypeScript Tests

Located alongside source in `harness-ts/src/**/*.test.ts`. Uses vitest, compatible with Jest API.

Run all tests:
```bash
cd harness-ts && npm test
```

Run a single test file:
```bash
cd harness-ts && npm test -- src/learning/index.test.ts
```

Watch mode for development:
```bash
cd harness-ts && npm run test:watch
```

**Key principle:** Tests focus on utilities, data transforms, and custom hooks. Visual components and integration points are tested via deployment on the Mini.

## Git Workflow

### Commit Directly to Main

Jarvis is a single-developer personal agent. There are no feature branches.

1. Make code changes
2. Run `make check` — all checks must pass
3. Commit with conventional commit format: `type(scope): description`
4. Push to origin/main

Allowed types: `feat`, `fix`, `refactor`, `docs`, `chore`, `perf`

Example:
```bash
git add harness-ts/src/learning/index.ts
git commit -m "fix(learning): use correct collection name for gap detection"
git push origin main
```

**Critical:** Do not run `make deploy-jarvis` or `make deploy-ion` until your local commit is complete and pushed. The deploy targets run `git push origin main` as their first step.

## Deploy Workflow

### Before Deploying

Always commit locally and push to origin/main first. Deployment targets verify a clean working tree and run `git push`.

```bash
# Verify all checks pass
make check

# Commit and push
git add .
git commit -m "..."
git push origin main

# Now deploy
```

### Deployment Targets

**For harness-ts changes (identity, staff agents, TS extension, scripts):**
```bash
make deploy-jarvis
```

This rebuilds the TS extension, copies agent specs to `~/.claude/agents/` on Mini, and restarts the ion LaunchAgent. Use this for 90% of changes.

**For ion Go engine changes:**
```bash
make deploy-ion
```

This rebuilds the ion binary from `ion/engine/`, codesigns it, and restarts ion. Use only when ion Go source changed.

**For faster iteration on Mini:**
```bash
# From ~/Jarvis on the Mini after committing
make deploy-ts-local     # TS extension only, no Go rebuild
make deploy-ion-local    # Full local rebuild (Go + TS)
```

**Verify deployment succeeded:**

```bash
# Check that the latest commit is live
ssh mini "cd ~/Jarvis && git log --oneline -1"

# View ion status
make ion-status

# Tail ion logs
make ion-logs
```

## Adding a Staff Agent

Staff agents handle delegated tasks and proactive routines (briefings, meeting prep, etc.).

### Step 1: Create the Agent Spec

Create `harness/agents/your-agent.md` following the format of existing agents:

```markdown
---
model: claude-sonnet-4-6
temperature: 0.7
max_tokens: 2000
---

# Your Agent Title

You are a brief description of your agent's role.

## Responsibilities

- Responsibility 1
- Responsibility 2

## Constraints

- Do not X
- Always Y

## Tools

You have access to: calendar, mail, memory recall, etc.
```

### Step 2: Register in Staff Config

Add an entry to `harness/config/staff.yaml`:

```yaml
your-agent:
  title: "Your Agent Title"
  model_key: "sonnet"  # or other model role from models.yaml
  specialties:
    - skill1
    - skill2
  description: "Brief description"
```

### Step 3: Add Model Role (if new)

If you used a new `model_key`, add it to `harness/config/models.yaml`:

```yaml
your_role:
  model: claude-sonnet-4-6
  temperature: 0.7
```

### Step 4: Deploy

```bash
make deploy-jarvis
```

This copies your agent spec to `~/.claude/agents/` on Mini.

### Step 5: Test

From an ion session on Mini:

```
/list-staff
```

Your agent should appear in the roster. Call it via `/recall "agent:your-agent brief me on X"` or let ion dispatch it naturally when its specialty matches a user query.

## Adding a Tool or Script

Tools extend Jarvis's capabilities (read files, send mail, create reminders, etc.).

### Scripts-First Pattern

**Always write a script in `scripts/` first**, test it directly, then optionally register it as an ion tool.

Why: Scripts are independently testable without an active ion session. They're the "hand tools"; the agent picks them up via tool registration.

### Example: Adding a New Calendar Helper

1. **Write the script** at `scripts/calendar-helper.sh`:

```bash
#!/bin/bash
# Usage: calendar-helper.sh <action> [args...]
# Actions: list-meetings, block-time, etc.

set -euo pipefail

action="${1:-}"
# ... implementation
```

2. **Make it executable and test on Mini**:

```bash
chmod +x scripts/calendar-helper.sh
ssh mini '~/Jarvis/scripts/calendar-helper.sh list-meetings today'
```

3. **Copy to ~/bin** in the deploy (already handled by `make deploy-jarvis` for known scripts).

4. **Optional: Register as ion tool** in `harness-ts/src/registrations/tools.ts`:

```typescript
{
  name: "calendar_helper",
  description: "Helper for calendar operations",
  input_schema: {...},
  handler: async (input) => {
    const result = await runCommandAsync("calendar-helper", [input.action, ...input.args])
    return result
  }
}
```

Only register if the script needs **session context** (access to messages, memory, or other session state). Standalone scripts don't need tool registration.

## Ion Submodule Rules (Critical)

The ion engine is a git submodule at `Jarvis/ion/` pointing to https://github.com/geektechlive/ion.

### NEVER do this:
- Edit `/Users/<username>/Source/ion` (that directory is not the source of truth)
- Commit ion Go changes directly to Jarvis; they belong in the ion repo

### Correct workflow for ion Go changes:

```bash
# 1. Edit in the submodule
cd ion/engine
# ... make changes
git add .
git commit -m "feat(engine): ..."
git push origin main

# 2. Bump the submodule pointer in Jarvis
cd ../..
git add ion
git commit -m "chore(ion): bump submodule to latest"

# 3. Deploy
make deploy-ion
```

### Sync upstream ion (if needed):

```bash
cd ion
git fetch upstream
git merge upstream/main
git push origin main
cd ..
git add ion
git commit -m "chore(ion): merge upstream/main"
```

The Go module path always stays `github.com/dsswift/ion/engine` regardless of the fork URL.

## TypeScript Build

The ion extension is the orchestration brain. It's TypeScript that bundles to CommonJS (better-sqlite3 is marked external).

### Build

```bash
cd harness-ts
npm run build
```

Output: `harness-ts/dist/extension.js` (bundled, ready for ion to load)

### Type Check Only

```bash
cd harness-ts
npm run typecheck
```

This runs `tsc --noEmit` with strict mode + extra flags (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`).

### Build Configuration

- **Entry**: `harness-ts/src/extension.ts`
- **Target**: Node 20 (ES2022 syntax available)
- **External deps**: `better-sqlite3` (native addon, cannot be bundled)
- **Output**: UMD bundle, ready for ion to `require()`

## Code Style

See `docs/conventions.md` and `harness-ts/tsconfig.json` for strict type rules.

### Key Discipline

- **No `any`** — use `unknown` at boundaries, narrow with guards
- **Immutability** — prefer const and new objects, never mutate
- **Error handling** — handle errors explicitly, never silently fail
- **Functions under 50 lines** — extract helpers for complex logic
- **Files under 800 lines** — split into modules by domain
