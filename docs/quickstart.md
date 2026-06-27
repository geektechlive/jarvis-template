---
title: Quickstart
description: Prerequisites, environment setup, and first run. What you need and how to verify Jarvis works.
sidebar_position: 18
---

# Quickstart

Jarvis is a personal always-on AI agent running on a Mac Mini with the ion runtime. This guide covers two scenarios: **developing locally** and **deploying to a dedicated Mini**.

## Can I run Jarvis on my development Mac?

**Short answer:** You can run tests and develop harness-ts code locally. You cannot easily run the full daemon.

**Why?** The full Jarvis stack is tuned for a dedicated Mac Mini (M2 with username `<username>`) and includes:
- ion daemon (requires launchd and always-on thinking)
- Ollama (requires 30+ GB RAM for models)
- ChromaDB vector store (persistent)
- Voice TTS server
- LaunchAgent daemons (scheduled routines, always-on goal runner)

All of these are configured for specific Mini paths and require a machine that stays on.

**What you can do locally:**
- Run `make check` (linting + type-checking + tests)
- Write and test harness-ts code
- Modify Python scripts and run unit tests
- Push changes to the Mini via `make deploy-*`

**What you cannot do locally:**
- Run the ion engine with full features
- Test email/calendar integrations (requires keychain unlock)
- Deploy to launchd
- Test always-on routines

If you have SSH access to a Mini running Jarvis, you can deploy changes remotely. Otherwise, focus on code quality and tests.

---

## Prerequisites

### Required
- **macOS 15+** (Sequoia or Tahoe)
- **Homebrew** — https://brew.sh
- **Git with SSH key** — `ssh-keygen -t ed25519 -C your-email`

### Required for Development
- **uv** (Python package manager)
  ```bash
  brew install uv
  ```
- **Node.js 20+**
  ```bash
  brew install node
  ```
- **Claude CLI** (for testing tools that call Claude)
  ```bash
  # Download the latest build from https://claude.ai/download
  # Then authenticate (this authorizes every installed model, not a single version):
  claude auth login
  ```
  Jarvis runs Claude Sonnet 4.6 via the ion CliBackend by default (see docs/cli-backend.md). `claude auth login` authenticates all installed models; do not pin a specific version here.

### Required for Remote Deployment (Mini)
- **Go 1.22+** (only needed to rebuild ion engine)
  ```bash
  brew install go
  ```
- **SSH access to Mini** — verify with:
  ```bash
  ssh mini echo "Connected"
  ```

### Optional for Local Testing
- **Ollama** (for testing vector embeddings locally)
  ```bash
  brew install ollama
  ollama pull nomic-embed-text
  ```

---

## Environment Setup

### Clone and Initialize

```bash
git clone git@github.com:<your-org>/jarvis.git
cd Jarvis
git submodule update --init --recursive
```

### Configure Environment Variables

```bash
cp .env.example .env
# Edit .env if needed — defaults work for local development
```

| Variable | Required | Purpose | Default |
|----------|----------|---------|---------|
| `OLLAMA_HOST` | optional | Local Ollama endpoint for embeddings | `http://localhost:11434` |
| `AGENT_DATA_DIR` | optional | Where to store SQLite + vector store | `~/.jarvis` |
| `BRAVE_SEARCH_API_KEY` | optional | Web search (leave blank for offline) | (blank) |
| `ANTHROPIC_API_KEY` | optional | Cloud escalation (leave blank to stay local) | (blank) |
| `ELEVENLABS_API_KEY` | optional | Voice backend (blank = macOS `say`) | (blank) |
| `BLUESKY_IDENTIFIER` | optional | Chief of Communications tool | (blank) |
| `BLUESKY_APP_PASSWORD` | optional | Chief of Communications tool | (blank) |

### Install Dependencies

```bash
# Python + harness/
uv sync --all-groups

# TypeScript + harness-ts/
cd harness-ts
npm install
cd ..
```

---

## Verify Your Setup

Run the full validation suite:

```bash
make check
```

This runs:
- **Linting** — `ruff` (Python style)
- **Type-checking** — `pyright` (Python types) + `tsc` (TypeScript strict mode)
- **Unit tests** — `pytest` (Python episodic/memory tests) + `vitest` (TypeScript ion extension tests)
- **Staff validation** — checks agent specs are well-formed

All should pass with exit code 0.

### Test Individual Components

```bash
# Python tests only
uv run pytest tests/ -v

# TypeScript tests only
cd harness-ts && npm test

# Type-checking only
cd harness-ts && npm run typecheck

# Linting only
uv run ruff check harness/ tests/
```

---

## First Deployment (to Mac Mini)

If you have SSH access to a Mini running Jarvis:

### 1. Verify SSH Connection

```bash
ssh mini uname -a
# Expected: Darwin <username> 25.x.x ...
```

### 2. Deploy Your Changes

```bash
make deploy-jarvis
```

This command:
- Commits and pushes your code to main
- Syncs your Claude Code rules to the Mini
- Rebuilds the TypeScript extension on the Mini
- Copies agent specs to `~/.claude/agents/`
- Restarts the ion daemon

**Deployment takes 2-3 minutes.** Do not interrupt.

### 3. Verify the Daemon

```bash
make ion-status
```

Expected output:
```
gui/<uid>/com.dsswift.ion   0   1 <pid> (Running)
```

### 4. Test a Prompt

```bash
ssh mini '~/bin/ion prompt --key jarvis "hello" --attach'
```

If you see a response from Claude, Jarvis is running.

---

## What Working Looks Like

### Local Development (No Mini)
- `make check` exits with code 0
- All tests pass
- TypeScript compiles with zero errors

### Deployed to Mini
- `make ion-status` shows daemon running
- `make ion-logs` shows no ERROR entries
- `~/bin/ion prompt --key jarvis "test" --attach` returns a response
- Staff agents (admin, curator, etc.) appear in `~/Jarvis/harness/agents/`

---

## Common Issues

### "make check" Fails

1. **Missing `uv`?**
   ```bash
   brew install uv
   uv sync --all-groups
   ```

2. **Missing Node.js?**
   ```bash
   brew install node
   cd harness-ts && npm install
   ```

3. **Python version too old?**
   - Requires Python 3.11+
   - Check with `python3 --version`
   - uv manages the correct version; run `uv python install 3.11`

### SSH to Mini Fails

1. **Host key not recognized?**
   ```bash
   ssh-keyscan mini >> ~/.ssh/known_hosts
   ```

2. **Permission denied?**
   - Verify your public key is on Mini: `cat ~/.ssh/id_ed25519.pub`
   - Add to Mini: `ssh mini 'cat >> ~/.ssh/authorized_keys' < ~/.ssh/id_ed25519.pub`

### Deployment to Mini Hangs

- Check if the Mini is locked or has a security prompt on screen
- Check network connectivity: `ssh mini ping -c 1 8.8.8.8`
- If ion daemon won't restart, SSH to Mini and run: `pkill -f "ion serve"` then retry

### Ollama Embeddings Timeout

If you see embedding timeouts during tests:
- Start Ollama: `ollama serve`
- In another terminal: `ollama pull nomic-embed-text`
- Set `OLLAMA_HOST=http://localhost:11434` in `.env`

---

## Next Steps

- **Read architecture:** `docs/architecture.md`
- **Understand memory:** `harness/memory/episodic.py` and `harness/memory/store.py`
- **Write an agent:** `harness/agents/example.md` (template)
- **Modify routines:** `harness/config/routines.yaml`
- **Contribute:** Make changes locally, run `make check`, deploy with `make deploy-jarvis`

---

## Getting Help

- **ion SDK docs:** `ion/docs/extensions/sdk-typescript.md`
- **Memory model:** `harness/memory/episodic.py` (SQLite) + `harness/memory/store.py` (ChromaDB)
- **Staff routing:** `harness/config/staff.yaml`
- **Models & roles:** `harness/config/models.yaml`

---

**Ready?** Run `make check` and report back.
