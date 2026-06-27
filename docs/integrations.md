---
title: Integrations
description: Jarvis's external integrations, their purpose, and credential locations.
sidebar_position: 9
---

# Integrations

Jarvis reaches into the principal's real life through a set of macOS-native and network integrations. Most are read-first; writes (sending mail, creating calendar events, sending iMessages) are deliberate and tool-gated. This document explains the WHY behind each integration and exactly where credentials live.

## Overview

Integration configuration lives in `harness/config/integrations.yaml`. Tool implementations are in `harness-ts/src/tools/`. Ion also provides built-in tools that staff agents use directly, including `read_file`, `list_dir`, `run_shell`, `web_fetch`, and `web_search`.

Credentials are stored in one of three places:
1. **macOS Keychain** (service `com.example.jarvis`) — primary storage for sensitive credentials
2. **Environment variables** — for tokens that don't require user interaction (deployment context)
3. **Legacy file** `~/.jarvis-mail-creds` — fallback for mail and calendar credentials on Mini

## Mail (IMAP)

| Field | Value |
|-------|-------|
| Script | `scripts/mail-check.py` (deployed to `~/bin/mail-check`) |
| Credential file | `~/.jarvis-mail-creds` (format: key=value, chmod 600) |
| Invoked by | Chief of Communications staff agent on `comms_pulse` routine |
| Runs on | Mac Mini M2 |

**Why:** Jarvis monitors email for time-sensitive information: bills, high-weight senders (flagged family, merchants, services), and newsletters. The Chief of Communications processes mail on a scheduled routine (`comms_pulse` in `routines.yaml`) and surfaces urgent items to Jarvis's awareness.

**Credential format** in `~/.jarvis-mail-creds`:
```
GMAIL_USER=you@gmail.com
GMAIL_APP_PASSWORD=xxxx
ICLOUD_USER=you@icloud.com
ICLOUD_APP_PASSWORD=xxxx
```

**High-weight senders** are processed more aggressively (flagged for morning brief, immediate routing). All others are batched into the `comms_pulse` digest. If mail credentials are unavailable, the routine degrades gracefully — no error blocks conversation.

## Calendar (CalDAV / iCloud)

| Field | Value |
|-------|-------|
| Script | `scripts/calendar-check.py` (deployed to `~/bin/calendar-check`) |
| Credential sources | macOS Keychain (`icloud_user`, `icloud_app_password`) or `~/.jarvis-mail-creds` |
| Server | iCloud CalDAV at `caldav.icloud.com` |
| Runs on | Mac Mini M2 |

**Why CalDAV over osascript:** osascript deadlocks in headless contexts (the Mini runs with GUI but no user session). CalDAV via HTTPS is the permanent fix — it's network-based, doesn't require a GUI thread, and works over SSH.

**Why:** Meeting prep routine, admin agent queries, morning brief, and reminder creation all need calendar data. Jarvis reads all calendars by default; excluded calendars are listed in `integrations.yaml` (`exclude_calendar_names`).

**Credentials:**
- **Primary:** macOS Keychain account keys `icloud_user` and `icloud_app_password` (read via `security find-generic-password`)
- **Fallback:** `ICLOUD_USER` and `ICLOUD_APP_PASSWORD` in `~/.jarvis-mail-creds`

**VTIMEZONE noise:** iCloud returns verbose VTIMEZONE blocks for every event. Client-side date filtering (in the script) handles this silently; no spurious "event at UTC-7" confusion.

## iMessage and Contacts

| Field | Value |
|-------|-------|
| Outbound | `scripts/imessage-send.sh` (Messages.app automation via AppleScript) |
| Inbound watcher | `scripts/imessage-watcher.sh` (launchd WatchPaths on `~/Library/Messages/chat.db`) |
| Credential context | GUI session (login keychain) — must run via ion LaunchAgent |
| Runs on | Mac Mini M2 |

**Why:** Personal communication channel. Jarvis can send iMessages on behalf of the principal and monitor inbound 1:1 conversations. Group chats are skipped by default unless the sender is flagged urgent.

**Failure mode:** `imessage-watcher.sh` requires GUI session context (login keychain is locked for SSH). The script must run via the ion LaunchAgent (`com.example.jarvis`, which runs with user context). If login keychain is unavailable, IMAP/SMS inbound traffic is lost until the session is reset.

**Credential requirements:**
- No explicit credentials (uses login keychain)
- IMESSAGE_WEBHOOK_TOKEN (env var) — used to verify inbound webhook POST payloads
- Contacts are read directly from Address Book (no authentication required)

## Safari Ambient

| Field | Value |
|-------|-------|
| Endpoint | `/ambient/safari` on vec-server (port 9876) |
| LaunchAgent | `com.example.safari-watcher.plist` (runs on user's primary macOS machine) |
| Storage | `safari_seen` table in SQLite episodic store |

**Why:** Builds ambient awareness of what the principal is reading, researching, or watching. Domains are recorded (not page content). The 24-hour history is surfaced in the morning brief as context ("You've been reading about X" builds continuity across sessions).

**Dedup:** Safari domain + timestamp is stored in `safari_seen`. Re-ingesting the same URL is skipped. Entries older than 24 hours are soft-dropped from ambient context.

**Architecture:** The watcher runs on the principal's personal macOS device (not the Mini), reads Safari history, and POSTs to vec-server `/ambient/safari` endpoint. Runs every 5 minutes via launchd.

## Spotlight (Local Search)

| Field | Value |
|-------|-------|
| Tool | `spotlight_search` (ion built-in, wraps `mdfind`) |
| Roots | Configured in `integrations.yaml` (`spotlight.roots`, default `~/Documents`, `~/Downloads`) |
| Timeout | 10 seconds (default) |
| Max results | 20 |

**Why:** Fast local file search by name or content. Used for finding research docs, PDFs, screenshots, and notes without network delay. Useful when principal asks "find that doc about X."

**Additional roots:** NAS and iCloud Drive roots can be added to `nas_roots` in `integrations.yaml`, but only if mounted (the script skips unmounted paths silently).

## UniFi Network

| Field | Value |
|-------|-------|
| Controller | UDM SE at `<router-ip>` |
| Webhook receiver | HTTP listener on port 8765 (configured in `integrations.yaml`) |
| MCP server | `~/mcp/cloudflare-mcp` on Mini (deployed as-needed) |
| Credential | UNIFI_WEBHOOK_TOKEN (env var, verified on inbound POST) |

**Why:** Real-time network alerts (IDS/IPS events, device health, WAN offline) reach Jarvis without manual checking. Systems Engineer staff agent can query UniFi state (device list, signal strength, threat log) directly from conversation.

**Webhook setup:** UniFi Alarm Manager (Logs > Alarm Manager) requires one webhook per trigger category:
- Security: IDS/IPS, threat detection, honeypot
- WAN: connectivity lost
- Device: offline, adoption issues

All point to `http://<mac-mini-ip>:8765/webhook/unifi`. Each alarm POST includes the trigger category; Jarvis routes to appropriate handling (critical events → immediate infra_watch, others → digest).

**Failure mode:** If webhook token is invalid or port 8765 is unreachable, UniFi alerts queue on the controller and are never delivered. MCP queries still work if credentials are valid.

## Discord

| Field | Value |
|-------|-------|
| Channel IDs | Configured in `integrations.yaml` (public, not secrets) |
| Bot token | macOS Keychain service `jarvis-discord-bot-token` |
| Webhook URLs | Keychain services: `jarvis-discord-webhook`, `jarvis-discord-proactive-webhook`, `jarvis-discord-chat-webhook` |
| Owner user ID | Configured in `integrations.yaml` |

**Why:** Primary proactive notification channel. Threshold alerts, autonomy findings, and long-form content (research digests, briefings) flow through Discord. User can approve/reject actions directly in Discord without leaving the app.

**Architecture:**
- **discord.js bot** in `harness-ts/src/discord/bot.ts` — reads approval reactions, routes to Jarvis
- **Outbound webhooks** — deliver alerts to `#jarvis-proactive` and `#jarvis-chat`
- **Approval loop** — user reacts (✅/❌) to a bot message; bot reads reaction and calls `/approve` or `/deny` on Jarvis
- **Heartbeat file** — `~/.jarvis/discord-bot.heartbeat` tracks last successful bot poll (patrol detects stale heartbeat)

**Setup:** Run `scripts/setup-discord-bot.sh` once to populate channel IDs and user ID. Credentials are stored manually in Keychain.

**Digest behavior:** Identical alerts within 30 minutes (`digest_quiet_minutes`) are de-duplicated. Approval reactions expire after 24 hours (`approval_expire_hours`).

## Bluesky

| Field | Value |
|-------|-------|
| Library | `@atproto/api` (TypeScript) |
| Credentials | macOS Keychain or env vars: `BLUESKY_IDENTIFIER`, `BLUESKY_APP_PASSWORD` |
| Implementation | `harness-ts/src/tools/bluesky.ts` |
| Owned by | Chief of Communications staff agent |

**Why:** Social media posting. Jarvis can create posts, replies, reposts, and likes on Bluesky on behalf of the principal. Useful for sharing research, reacting to news, or maintaining social presence without context-switching.

**Session caching:** Bluesky limits 300 session creations per account per day. Sessions are cached in memory to stay well below this limit.

**Credential lookup:**
1. Keychain account keys `bluesky_identifier` and `bluesky_app_password` (service `com.example.jarvis`)
2. Environment variables `BLUESKY_IDENTIFIER` and `BLUESKY_APP_PASSWORD` (deployment context)

## Cloudflare

| Field | Value |
|-------|-------|
| MCP server | Standalone at `~/mcp/cloudflare-mcp` on Mini |
| Zones | `<your-domain>`, `relay.<your-domain>`, `observatory.<your-domain>`, `<your-domain>` |
| Credential | CLOUDFLARE_API_TOKEN (env var) |
| Owned by | Systems Engineer staff agent |

**Why:** Systems Engineer can manage DNS, Workers, Pages, and SSL health directly from conversation. Useful for DNS troubleshooting, deploying edge functions, or investigating zone issues.

**Architecture:** MCP server runs on Mini as a separate process. Claude Code connects via stdio bridge. No extra authentication needed (token is in Mini environment).

## Graphiti / Neo4j (Optional)

| Field | Value |
|-------|-------|
| Backend | Neo4j 5.26+ (bolt://127.0.0.1:7687) |
| HTTP endpoints | `/graph/ingest` and `/graph/recall` on vec-server (port 9876) |
| Credential | GRAPHITI_NEO4J_PASSWORD (env var) |
| Python dependency | `uv sync --extra graph` (installs graphiti-core) |
| Enabled | Flag in `harness/config/models.yaml` (`graphiti.enabled`) |

**Why:** Optional knowledge graph layer for entity-edge relationships with temporal reasoning. Ingest fires at `turn_end`; recall is injected at `before_prompt`. Enables Jarvis to answer questions like "has Alex talked to Alex before?" or "what projects involve Supabase?"

**Failure mode:** If Neo4j is not running or `graphiti.enabled` is false, graph ingest and recall silently skip. Conversation continues normally. Re-enabling requires a Neo4j restart.

## iOS Relay

| Field | Value |
|-------|-------|
| Binary | `ion-relay` (built from `ion/relay/*.go`) |
| Transport | WebSocket + Cloudflare tunnel (`wss://relay.<your-domain>`) |
| Port | Internal Unix socket to ion daemon |
| Runs on | Mac Mini M2 (M2 Mini only, not M4) |

**Why:** Bidirectional real-time communication between iOS app and Jarvis. User sends prompts from iPhone; Jarvis pushes proactive content (briefs, reminders, urgent interrupts) to iPhone.

**Architecture:**
- relay listens on M2 as a WebSocket server
- Cloudflare tunnel exposes it to WAN as `wss://relay.<your-domain>`
- iOS app uses Bonjour for LAN discovery of relay; uses tunnel for WAN
- APNs token captured on first handshake; relayed to M4 for push notification fallback

**Deployment:** `make deploy-relay` rebuilds and deploys relay. Separate from `make deploy-ion` (which deploys ion engine).

## RSS Feeds

| Field | Value |
|-------|-------|
| Config | `harness/config/feeds.yaml` |
| Module | `harness-ts/src/feeds/index.ts` |
| Runs on | Weekly routine (`weekly_curator`) |

**Why:** Jarvis ingests RSS feeds to stay aware of tech news, product launches, and relevant events without requiring manual browsing. Feed items are evaluated for freshness and quality, then stored in ChromaDB's knowledge collection. During relevant conversations, feed context surfaces automatically to enrich Jarvis's awareness.

**Freshness filter:** Only items published within the last 48 hours are ingested. Why: Prevents bulk-importing old archives when a new feed is first added, which would overwhelm the knowledge store with outdated content.

**Quality filter:** Minimum title length of 20 characters. Why: Removes placeholder entries, ad content, and low-signal noise that slip through some RSS feeds.

**Max items per feed:** 50 items per run. Why: Prevents a prolific feed from dominating the knowledge store at the expense of other sources.

**Current feeds:**

| Feed | URL | Category |
|------|-----|----------|
| Hacker News AI | `hnrss.org/newest?q=AI+LLM+claude+anthropic` | Technology |
| TechCrunch AI | `techcrunch.com/tag/artificial-intelligence/feed/` | Technology |
| The Verge | `theverge.com/rss/index.xml` | Technology |
| Automotive news | `example.com/automotive-feed` | Automotive |
| 9to5Mac | `9to5mac.com/feed/` | Technology |

**How to add a feed:** Edit `harness/config/feeds.yaml` and add a new list entry with `id`, `url`, `category`, `signal` (low/medium/high), and `description`. The next `weekly_curator` run will pick it up automatically.

## Tool-to-Integration Map

| Tool | Backed by |
|------|-----------|
| `recall_memory` | ChromaDB + SQLite memory store |
| `remember_fact` | ChromaDB memory store |
| `get_safari_activity` | Safari ambient watcher |
| `ingest_item` | Triage subsystem (routes items to inbox or brief queue) |
| `get_today_events` | iCloud CalDAV |
| `get_week_events` | iCloud CalDAV |
| `calendar_create_event` | iCloud CalDAV |
| `calendar_update_event` | iCloud CalDAV |
| `calendar_delete_event` | iCloud CalDAV |
| `spotlight_search` | macOS `mdfind` |
| `git_diff` | Local git repository |
| `git_apply_patch` | Local git repository |
| `mail_send` | SMTP (Python fallback: `.eml` file to disk) |
| `send_imessage` | Messages.app AppleScript |
| `lookup_contact` | macOS Contacts (Address Book) |
| `surface_to_inbox` | iPhone push or urgent interruption |
| `queue_for_brief` | Inbox accumulator (morning brief) |
| `create_reminder` | SQLite durable reminders (survive restarts) |
| `discord_send` | Discord webhook |
| `bluesky_post` | Bluesky @atproto/api |
| `bluesky_reply` | Bluesky @atproto/api |
| `bluesky_repost` | Bluesky @atproto/api |
| `bluesky_like` | Bluesky @atproto/api |
| `bluesky_resolve_post` | Bluesky @atproto/api |
| `send_to_chat_channel` | Discord webhook (`#jarvis-chat`) |

Ion built-ins also available: `read_file`, `list_dir`, `run_shell`, `web_fetch`, `web_search`.

## Credential Summary

| Credential | Location | Purpose |
|------------|----------|---------|
| `icloud_user`, `icloud_app_password` | Keychain service `com.example.jarvis` OR `~/.jarvis-mail-creds` | Calendar (CalDAV) and mail (IMAP) |
| `gmail_user`, `gmail_app_password` | `~/.jarvis-mail-creds` | Gmail IMAP |
| UNIFI_WEBHOOK_TOKEN | Environment variable | UniFi webhook verification |
| IMESSAGE_WEBHOOK_TOKEN | Environment variable | iMessage inbound webhook verification |
| `jarvis-discord-bot-token` | Keychain service | Discord bot read/write |
| `jarvis-discord-webhook` | Keychain service | Discord `#jarvis` webhook |
| `jarvis-discord-proactive-webhook` | Keychain service | Discord `#jarvis-proactive` webhook |
| `jarvis-discord-chat-webhook` | Keychain service | Discord `#jarvis-chat` webhook |
| `bluesky_identifier`, `bluesky_app_password` | Keychain service `com.example.jarvis` OR env vars | Bluesky posting |
| CLOUDFLARE_API_TOKEN | Environment variable | Cloudflare API access |
| GRAPHITI_NEO4J_PASSWORD | Environment variable | Neo4j authentication |

## Where to Go Next

- [../README.md](../README.md): Project overview
- [./identity.md](./identity.md): Jarvis's persona and behavior framework
- [./memory.md](./memory.md): How Jarvis learns and remembers
- [./staff.md](./staff.md): Staff agents and the routable system
- [./concept.md](./concept.md): Architecture and core concepts
