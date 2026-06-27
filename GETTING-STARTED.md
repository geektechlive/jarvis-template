# Getting Started

> **Start here.** This repository is a *template* for building your own always-on
> personal AI chief of staff, extracted from a private working system. It runs,
> but every personal detail has been replaced with a `<placeholder>` you fill in.
> This guide walks you from clone to first conversation. The [README](README.md)
> explains *what* the system is; this file explains *how to make it yours*.

Nothing here phones home, and there are no secrets in the repo — credentials live
in your `.env` and the macOS Keychain, both of which stay local.

---

## 1. What you need

This system targets **macOS** (it uses launchd, Keychain, CalDAV, and optionally
Apple Foundation Models). You will need:

- **macOS 14+** (15+ recommended; on-device Foundation Models need macOS 26)
- **Homebrew**, **Node.js 20+**, **[uv](https://docs.astral.sh/uv/)** (Python), **Go 1.22+**
- The **Claude CLI** (`claude`) authenticated with an Anthropic account — this is
  the engine. See `docs/cli-backend.md`.
- **[Ollama](https://ollama.com)** for local embeddings
- Optional: a second Mac for the desktop client, a NAS for cold archive + a
  dedicated embeddings host, Neo4j for the knowledge graph, an ElevenLabs account
  for voice, a Discord server for proactive delivery, an Apple Developer account
  for the iOS app.

You can run a useful subset on a **single Mac** with just Claude CLI + Ollama; the
NAS, second Mac, Discord, and iOS pieces are all optional and degrade gracefully.

---

## 2. Clone and install

```bash
git clone --recurse-submodules https://github.com/<your-org>/jarvis-template.git jarvis
cd jarvis
uv sync --all-groups                 # Python deps (tools-py + tests)
cd harness-ts && npm ci && cd ..     # TypeScript orchestration deps
make check                           # ruff + pyright + pytest + eslint + tsc
```

The `ion/` submodule is a public Go runtime; `--recurse-submodules` fetches it.

---

## 3. The customization checklist

Every personal value in the template is a literal placeholder. **Search the repo
for each placeholder string** and replace it. The fastest way to find them all:

```bash
grep -rn '<mac-mini-ip>\|<username>\|<your-org>\|<your-domain>\|\bAlex\b' .
```

| Placeholder | What it is | Where it appears | Required? |
|---|---|---|---|
| `Alex` (and `Alex Example`) | The name of the person Jarvis serves — replace with your own. The role phrase "the principal" is used elsewhere and can stay as-is. | `harness/identity/*.md`, agent specs, docs | **Yes** |
| `<username>` | macOS username on the engine machine | plists, scripts, `harness-ts/src/**`, Makefile | **Yes** |
| `<your-org>` | Your GitHub org/user (for patrol, issues, deploy) | `harness-ts/src/**`, scripts, docs | If you use patrol/CI |
| `<mac-mini-ip>` | LAN IP of the engine machine | plists, scripts, Makefile, docs | If deploying to a remote Mac |
| `<m4-mini-ip>` | LAN IP of an optional second Mac (desktop client) | plists, docs | Optional |
| `<nas-ip>` | NAS IP (embeddings, Neo4j, cold archive) | `harness/config/*.yaml`, docs | Optional |
| `<router-ip>` | UniFi controller IP | `harness/config/integrations.yaml` | Optional |
| `<your-domain>` | Domain for the Cloudflare relay tunnel | `harness/config/integrations.yaml`, docs | If you expose the relay on WAN |
| `<elevenlabs-voice-id>` | ElevenLabs voice ID | `harness/config/voice.yaml`, `docs/` | If using ElevenLabs voice |
| `<discord-chat-channel-id>` | Discord channel for long-form output | `harness/config/integrations.yaml` | If using Discord |
| `<discord-proactive-channel-id>` | Discord channel for proactive alerts | `harness/config/integrations.yaml` | If using Discord |
| `<discord-owner-user-id>` | Your Discord user ID | `harness/config/integrations.yaml` | If using Discord |
| `<apple-team-id>` | Apple Developer Team ID | `maps.ts`, `jarvis-maps.js`, `.github/workflows/`, plist | For the iOS app / Apple Maps |
| `<apns-key-id>` | APNs auth-key ID | `com.example.ion-relay.plist` | For iOS push |
| `<ios-device-udid>` | A local iOS device UDID | `harness/identity/PROJECTS.md` (example) | For local iOS installs |
| `com.example.` | launchd label prefix | all `com.example.*.plist` filenames + labels | **Yes**, rename to `com.<you>.` |

Then make the content yours:

- **`harness/identity/`** — `GOALS.md`, `PROJECTS.md`, `BEHAVIOR.md`, `MISSION.md`
  define who Jarvis serves and how. These ship as generic templates; rewrite them
  for your life. `SOUL.md` (the persona) is reusable as-is.
- **`harness/config/integrations.yaml`** — the main wiring file; every block is
  marked `CUSTOMIZE`. Remove blocks for services you do not use.
- **`harness/config/staff.yaml`** + **`harness/agents/`** — a 27-specialist roster.
  Keep, prune, or add specialists to fit your needs.

---

## 4. Secrets: `.env` and the Keychain

Copy the example env and fill in what you use (leave the rest blank):

```bash
cp .env.example .env
```

Runtime credentials that should not sit in a file live in the macOS Keychain.
The service names use your launchd prefix — e.g. after renaming `com.example.`
to `com.<you>.`:

```bash
security add-generic-password -a "$USER" -s "jarvis-discord-bot-token" -w
# (repeat for jarvis-discord-webhook, mail creds, etc. — see integrations.yaml)
```

Mail and calendar credentials live in `~/.jarvis-mail-creds`; the scripts in
`scripts/` read them directly.

---

## 5. Local services

```bash
ollama pull nomic-embed-text         # embeddings (required for all recall)
```

- **ChromaDB** runs as the vec-server (`tools-py/vector-store/`, port 9876).
- **Neo4j 5.26+** is optional (the Graphiti knowledge graph). Enable it in
  `harness/config/models.yaml` and set `GRAPHITI_NEO4J_PASSWORD` in `.env`.
  See `docs/graphiti.md`.
- **Voice** (`tools-py/voice-tts/`) and **Apple Foundation Models**
  (`tools-py/apple-foundation/`, macOS 26 only) are optional.

---

## 6. launchd services

The `com.example.*.plist` files are templates for always-on daemons and scheduled
routines. For each one you want:

1. Rename `com.example.X.plist` → `com.<you>.X.plist`.
2. Edit the `Label`, the program/working paths (`/Users/<username>/...`), and any
   IPs inside.
3. Install it:

```bash
cp com.<you>.X.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.<you>.X.plist
```

At minimum you want the ion engine and the vec-server running. See
`docs/deployment.md` for the full set and `docs/RECOVERY.md` for recovery.

---

## 7. First run and verification

```bash
make check                                   # everything green?
ion prompt --key jarvis 'Good morning'       # talk to the engine
```

If `make check` passes and the engine answers, you have a working agent. From
here, read `docs/concept.md` for the design philosophy, `docs/staff.md` for how
delegation works, and `docs/memory.md` for the memory model — then start shaping
the identity files into your own chief of staff.
