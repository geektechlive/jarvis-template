---
title: CliBackend
description: How Jarvis invokes Claude via the claude CLI subprocess — no Anthropic SDK, no API key, OAuth token only.
sidebar_position: 2
---

# The CliBackend: How Jarvis Talks to Claude

## Summary

Jarvis does not use the Anthropic Python or JavaScript SDK. Instead, it runs Claude via **CliBackend**: a subprocess mode where ion invokes the `claude` CLI binary (the same CLI used by Claude Code). Authentication uses an OAuth token stored on disk—no API key is needed or set. The TypeScript extension and all staff agents communicate with Claude exclusively through this subprocess pattern, never through a language SDK.

## How CliBackend Works

The ion engine supports multiple backends. Jarvis is configured in `~/.ion/engine.json` on the Mac Mini to use:

```json
{
  "backend": "cli",
  "defaultModel": "claude-sonnet-4-6"
}
```

In CliBackend mode, ion does not connect to `api.anthropic.com` directly. Instead, when a prompt is sent:

1. ion spawns the `claude` CLI binary as a child subprocess
2. Passes the prompt and model selection via command-line flags
3. Reads stdout from the subprocess
4. Returns the response to the caller

This is fundamentally different from an SDK pattern like `new Anthropic({ apiKey })`. There is no network connection from Jarvis to Anthropic's API—ion's engine itself is responsible for spawning and managing the subprocess.

## Authentication: OAuth, Not API Keys

The `claude` CLI authenticates using an **OAuth token** stored in `~/.claude/` on the Mini (user `<username>`). This token is created when you log in via `claude auth login` and is read automatically by the CLI on subsequent invocations.

**Key facts:**

- No `ANTHROPIC_API_KEY` environment variable is set or required
- No API key file is checked in or stored in `.env`
- The OAuth token in `~/.claude/` is a secure credential managed by the Claude app and CLI, not a rotating API key
- The token survives reboots and is renewed transparently by the CLI

**Verification:** There is no `@anthropic-ai/sdk` dependency in `harness-ts/package.json`:

```json
{
  "dependencies": {
    "@atproto/api": "^0.20.7",
    "@hono/node-server": "^2.0.4",
    "better-sqlite3": "^12.10.0",
    "chrono-node": "^2.7.0",
    "discord.js": "^14.26.4",
    "hono": "^4.12.23",
    "js-yaml": "^4.1.1",
    "rss-parser": "^3.13.0"
  }
}
```

No SDK, no API key—only subprocess calls.

## How harness-ts Calls Claude

### Direct Claude CLI for Sub-Tasks

When the TypeScript extension needs to invoke Claude for staff agents, reflections, or panel synthesis, it calls `runClaudeAgent()` from `harness-ts/src/util/claudeAgent.ts`:

```typescript
// runClaudeAgent is a utility that invokes the Claude CLI subprocess.
export async function runClaudeAgent(
  routine: string,
  prompt: string,
  modelOrOpts: string | RunClaudeAgentOpts = DEFAULT_MODEL,
): Promise<string> {
  const claudeBin = process.env['CLAUDE_BIN'] ?? 'claude'
  const opts: RunClaudeAgentOpts =
    typeof modelOrOpts === 'string' ? { model: modelOrOpts } : modelOrOpts
  const model = opts.model ?? DEFAULT_MODEL
  const timeoutMs = opts.timeoutMs ?? 120_000
  try {
    const r = await runCommandAsync(
      claudeBin,
      ['-p', prompt, '--model', model],
      cmdOpts,
    )
    return r.stdout
  } catch (err) {
    return ''
  }
}
```

This spawns the `claude` CLI with a prompt flag (`-p`) and a model flag (`--model`), then captures and returns stdout. No SDK instantiation, no API credentials passed programmatically.

### Ion Context for Main Session

For the main Jarvis conversation loop, the extension uses ion's **IonContext SDK**:

```typescript
// From ion hooks (before_prompt, turn_end, session_end)
await ctx.sendPrompt(prompt)  // Delivers prompt to ion's CliBackend
await ctx.dispatchAgent(staffName, prompt)  // Spawns a staff agent (Claude CLI subprocess)
```

These are ion SDK methods, not Anthropic SDK methods. `ctx.sendPrompt()` sends text to whatever backend is configured in `engine.json` (in this case, CliBackend). `ctx.dispatchAgent()` invokes a registered agent spec (staff agent) as a subprocess.

### Fallback: Ion Prompt Subprocess

When the extension is not in an active session context (e.g., autonomy background routines), it falls back to spawning ion directly:

```typescript
// From ionPrompt.ts: fire-and-forget routine delivery
const ionBin = process.env['ION_BIN'] ?? 'ion'
const r = await runCommandAsync(
  ionBin,
  ['prompt', '--key', 'jarvis', prompt, '--attach'],
  { timeoutMs: 240_000 },
)
```

This invokes `ion prompt --key jarvis "<prompt>" --attach` as a subprocess. ion reads the engine.json CliBackend configuration and spawns `claude` internally.

## What `.claude/` Contains (and What It Doesn't)

### `~/.claude/` on the Mini (user <username>)

This directory contains **LLM credentials**:
- OAuth token for the Claude CLI (created via `claude auth login`)
- CLI configuration and session metadata
- Read by the `claude` CLI binary when invoked as a subprocess

This is where CliBackend finds its authentication. It is separate from the Jarvis repository.

### `Jarvis/.claude/` (in the repo)

This directory contains **Claude Code (IDE) settings and project metadata**, not LLM credentials:
- `settings.json` and `settings.local.json` — Claude Code editor configuration
- Plan files (`.md` documents for session planning)
- Worktree tracking
- Excluded from git in the main repo (separate Claude Code workspace)

These two directories serve completely different purposes and should never be confused. The presence of `Jarvis/.claude/` does not provide LLM credentials. Authentication comes from `~/.claude/` on the filesystem.

## Common Misconceptions

### 1. "Jarvis needs an ANTHROPIC_API_KEY"

**False.** CliBackend does not use API keys. It uses an OAuth token in `~/.claude/`, which is installed once via the Claude CLI and renewed transparently. No environment variable is needed.

### 2. "Jarvis imports @anthropic-ai/sdk"

**False.** The harness-ts `package.json` has zero SDK dependencies. All Claude invocations are subprocess-based. Verify yourself:

```bash
cd harness-ts && grep -i anthropic package.json
# (returns nothing)
```

### 3. "The .claude/ directory in the Jarvis repo contains LLM credentials"

**False.** `Jarvis/.claude/` is Claude Code (IDE) project metadata. LLM authentication happens via `~/.claude/` on the Mini's user filesystem, read by the CLI subprocess.

### 4. "Ollama is the main Jarvis model"

**False.** Ollama is **embeddings only** now — it serves `nomic-embed-text` for vector memory (running on the NAS via `OLLAMA_EMBED_HOST`). Reasoning models (qwen2.5, llama3.1) are no longer resident (issue #613). Triage/classification moved to on-device Apple Foundation Models with a Claude Haiku fallback (see [llm-routing.md](llm-routing.md)).

The main Jarvis session runs **Claude Sonnet 4.6 via CliBackend**. Staff agents also run Claude, not Ollama. Ollama is a supporting utility, not the core reasoning engine.

## Architecture: CliBackend Flow

```
User sends prompt to Ion.app (or via `ion prompt`)
           |
           v
        ion engine starts CliBackend
           |
           v
CliBackend spawns: /opt/homebrew/bin/claude -p "prompt" --model claude-sonnet-4-6
           |
           v
claude CLI reads OAuth token from ~/.claude/ (no ANTHROPIC_API_KEY needed)
           |
           v
claude CLI connects to api.anthropic.com and gets response
           |
           v
Response returned to ion engine (CliBackend reads stdout)
           |
           v
ion extension (harness-ts) receives response and processes it
```

## Reference: engine.json Fields

On the Mini, `~/.ion/engine.json` contains:

| Field | Value | Meaning |
|-------|-------|---------|
| `backend` | `"cli"` | Use CliBackend (subprocess-based) |
| `defaultModel` | `"claude-sonnet-4-6"` | Primary model for Jarvis |
| Other backends | (not used) | e.g., `"anthropic"` would use SDK; `"ollama"` would connect to local Ollama |

When `backend` is `"cli"`, ion spawns the `claude` CLI. When it is `"anthropic"`, ion would use the Anthropic SDK directly (not Jarvis's configuration).

## Summary: Key Takeaway

Jarvis **is not a traditional SDK application**. It is a subprocess orchestrator built on ion's Go runtime. All LLM calls—whether main session or staff agent sub-tasks—are routed through CLI binary spawning, not SDK instantiation. Authentication is OAuth-based and managed entirely by the CLI binary. No API key is ever stored, loaded, or transmitted by Jarvis itself.
