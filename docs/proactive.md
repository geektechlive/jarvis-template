---
title: Proactive Triggers
description: Condition-based trigger engine that fires on upcoming meetings, unread threads, and browsing clusters — distinct from the time-based scheduler.
sidebar_position: 17
---

# Proactive Triggers

## Overview: Proactive vs. Scheduler

The **scheduler** (`scheduler/index.ts`) fires routines at specific clock times:
- Daily: morning brief at 07:30, evening journal at 21:00
- Weekly: curator review on Monday at 08:00
- Interval: `meeting_prep` every 5 minutes

The **proactive engine** (`proactive/index.ts`) is fundamentally different. It fires **condition-driven triggers** that respond to events as they happen, not on a fixed schedule:
- An upcoming meeting 30 minutes away should trigger *right then*, not wait for a scheduled routine
- A cluster of related Safari tabs should trigger *when the cluster forms*, not on a daily basis
- Unread email from high-priority senders should surface *as it accumulates*, not at a fixed time each day

**Why separate?** Mixing time-based and condition-based logic would require complex conditional branching inside the scheduler's tick loop. Instead, proactive runs on its own **5-minute engine tick** and checks conditions independently. This keeps responsibilities clean and makes triggers easy to add or modify.

---

## Architecture: 5-Minute Tick and Cooldown Tracking

The proactive engine runs every 5 minutes (via the scheduler itself, registered as routine `proactive_check`):

```ts
// From index.ts
for (const trigger of TRIGGERS) {
  // 1. Check if trigger is on cooldown (via episodic.recentEvents)
  // 2. If not, run trigger.run() (returns boolean: fired or not)
  // 3. If fired, log cooldown event to episodic database
}
```

**Why every 5 minutes, not faster?** The 5-minute interval balances responsiveness against database load. Most triggers check calendars or Safari history — operations that are cheap but not free. 5 minutes is responsive enough for meeting countdowns and research clusters while avoiding thrash.

### Cooldown Mechanism

Each trigger has a `cooldownHours` field. Cooldowns prevent the same condition from firing repeatedly on every tick:

| Trigger | Cooldown | Reason |
|---------|----------|--------|
| `meeting_countdown` | 0 hours | Cooldown is per-event (title + time), not global — same meeting never fires twice, but multiple meetings can fire in one check |
| `safari_clustering` | 0 hours | Per-domain cooldown (4 hours) managed internally — triggers are checked but individually gated |
| `unread_thread_sweep` | 22 hours | Global cooldown — email is expensive to scan; once per day is intentional |
| `pre_routine_gap_probe` | 0 hours | Per-routine per-day cooldown — runs before each routine but never duplicates on same day |

**Why 22 hours for email, not 24?** Prevents the sweep from drifting to a different time each day. If you miss the 22h window by 2 hours, it fires the next time — unlike "once per day at UTC midnight," which can slip over weeks. This is drift-resistant scheduling.

Cooldowns are stored in the `agent_events` table as `event_type = 'proactive_fired'` with a `created_at` timestamp. The engine queries `recentEvents(trigger_id, 'proactive_fired', cooldownHours)` to check if the trigger has fired within the cooldown window.

---

## Triggers

### Meeting Countdown

**When it fires:** 20–45 minutes before a calendar event starts.

**Why:** Meeting prep is time-critical. Jarvis surfaces context — attendee notes, prior meetings, prep materials — while there's still time to act. By the time the meeting is in 5 minutes, it's too late to review attendee preferences. By 45 minutes, it feels premature. The 20–45-minute window is the decision-making window.

**How it works:**
1. Fetch upcoming events within 45 minutes
2. For each event, parse the start time (e.g., "09:30 AM") and compute minutes until start
3. Filter to only events in the 20–45-minute window
4. Per-event cooldown check (keyed on title + start time; 6-hour cooldown prevents re-notification of the same meeting)
5. Build context:
   - **Contacts lookup:** Parse event title (e.g., "Sync with Alice and Bob") and match against `contacts.yaml`. Return relationship, last seen date, and preferences.
   - **Memory recall:** Query vector store for context tagged with the meeting title (non-fatal if vec-server is down)
6. Post a rich Discord embed with emoji (📅), time countdown, title, attendee context, and memory hits
7. Log cooldown event so the same meeting doesn't fire again for 6 hours

**Data flow:**
```
getUpcomingEvents(45 min)
  → parseStartTime("09:30 AM")
  → compute minutesUntil
  → filter 20-45 min window
  → buildContactsContext(title)
  → recall(title, 'user_profile', 3 results)
  → buildRichEmbed()
  → postProactive() → Discord
  → logEvent(meeting_id, 'proactive_fired')
```

---

### Unread Thread Sweep

**When it fires:** Once every 22 hours.

**Why:** Email accumulates silently. Users miss important threads not because they ignore mail, but because unread counts fade into visual background noise. A proactive sweep — "you have 3 unread threads from high-priority senders, all stale (>24h unread)" — surfaces items that deserve attention without requiring the user to ask.

**How it works:**
1. Load mail configuration (`high_weight_senders` list from `config/integrations.yaml`)
2. Double-check internal 22-hour cooldown (avoids redundant IMAP scans)
3. Run subprocess to fetch unread messages:
   ```bash
   python3 tools-py/vector-store/mail.py --unread
   ```
4. Parse JSON response into `MailMessage[]`
5. Filter to messages from `high_weight_senders` that are stale (unread for > 24 hours)
6. Cap to 5 threads max (keeps embed readable)
7. Post Discord embed with thread summaries and sender names
8. Log cooldown event

**Parameters:**
- `STALE_HOURS = 24` — unread threshold
- `MAX_THREADS = 5` — cap per sweep
- `INTERNAL_COOLDOWN_HOURS = 22` — global cooldown

**Why subprocess, not direct DB query?** Mail state lives in IMAP (server-of-truth). The subprocess handles auth, IMAP connections, and mailbox state. Keeps the TypeScript harness isolated from IMAP protocol details.

---

### Safari Clustering

**When it fires:** When the user visits 5+ pages on the same domain within 1 hour, per domain, with 4-hour per-domain cooldown.

**Why:** Browsing patterns reveal intent. If you visit 8 pages on `arxiv.org` in an hour, you're researching something. Jarvis can surface related memories ("you've read about quantum computing before"), offer to file a research note, or trigger a deeper learning cycle. The cluster detection is pattern-based, not keyword-based — it works even when the user doesn't explicitly ask for help.

**How it works:**
1. Call `summariseSafari(1)` — analyze Safari history for the past 1 hour
2. Returns `domainsAggregated[]` with domain, visit count, sample title
3. Filter to domains with 5+ visits
4. For each qualifying domain:
   - Check per-domain cooldown (keyed on domain; 4-hour cooldown)
   - Post Discord embed: "Research cluster: arxiv.org (8 visits in the past hour)"
   - Suggest: `reply 'note arxiv.org'` to file a research note or `reply 'skip arxiv.org'` to suppress for 4 hours
   - Log per-domain cooldown event

**Parameters:**
- `MIN_PAGE_COUNT = 5` — threshold to trigger
- `COOLDOWN_HOURS = 4` — per-domain cooldown (no per-engine override)

**Data flow:**
```
summariseSafari(1 hour window)
  → filter domains.count >= 5
  → for each domain:
      → check cooldown key: safari_clustering:{domain}
      → buildRichEmbed(emoji='🔍', ...)
      → postProactive() → Discord
      → logEvent(cooldown_key, 'proactive_fired')
```

**Note:** Safari history is read via AppleScript from the local database on-device. No external API call; fully local.

---

### Pre-Routine Gap Probe

**When it fires:** 10–20 minutes before a scheduled daily or weekly routine starts (if a gap is detected).

**Why:** A morning brief that lacks recent stock data, a meeting prep without attendee notes, or a weekly curator review without new sources is worse than no output at all — it's confidently incomplete. Gap probing checks if key knowledge is available *before* the routine runs. If memory is sparse (<2 relevant facts), Jarvis posts a Discord notification: "Morning brief runs in 12 minutes but I have no market data on file. Might want to load an article first." This gives the user a chance to provide context before the routine executes.

**How it works:**
1. Load routines config (`routines.yaml`)
2. For each enabled routine, check if it runs in the next 10–20 minutes (based on scheduled time and today's day-of-week)
3. Look up the routine's topic in `ROUTINE_TOPICS` (e.g., `morning_brief` → topics `["markets", "tech news", "calendar"]`)
4. For each topic, recall from vector store (`user_profile` collection, limit 3 results)
5. If recall returns < 2 facts total, post a gap warning:
   - Discord embed: "Morning brief in 12 minutes but I have sparse market data. Load an article if available?"
   - Suggest user can `/learn` a fact or reply with an article
6. Log per-routine per-day cooldown event (keyed on routine ID + ISO date, e.g., `morning_brief:2026-06-02`)

**Parameters:**
- Probe window: 10–20 minutes before routine start
- Gap threshold: < 2 facts recalled
- Cooldown: one notification per routine per calendar day (not per engine tick)

**Why 10–20 minutes?** Gives the user time to act (provide context) but not so far out that the gap probe feels disconnected from the routine. If you probe at 7:15 AM for a 7:30 routine, there's 15 minutes to load an article or voice a fact.

**Data flow:**
```
getChicagoTime()
  → for each enabled routine:
      → check if scheduled_time is 10-20 min away
      → get topics from ROUTINE_TOPICS[routine_id]
      → for each topic:
          → recall(topic, 'user_profile', 3)
      → if total_facts < 2:
          → buildRichEmbed(emoji='⚠️', ...)
          → postProactive() → Discord
          → logEvent(routine_id + today, 'proactive_fired')
```

---

## Adding a New Trigger

To add a new proactive trigger:

1. **Create a new file** in `harness-ts/src/proactive/myTrigger.ts`:
   ```ts
   export async function myTrigger(): Promise<boolean> {
     // Check condition
     if (!condition_met) return false
     
     // Do work (fetch data, build embed, post to Discord)
     const embed = buildRichEmbed({ ... })
     await postProactive(null, { embed })
     
     // Log cooldown event
     logEvent('my_trigger', 'proactive_fired', { /* context */ })
     
     return true  // Signal that trigger fired
   }
   ```

2. **Register in `index.ts`:**
   ```ts
   const TRIGGERS: Trigger[] = [
     // ...
     { id: 'my_trigger', cooldownHours: 2, run: myTrigger },
   ]
   ```

3. **Choose a cooldown strategy:**
   - **Global cooldown** (`cooldownHours > 0`): Trigger fires once every N hours, period. Use for expensive operations (email sweeps).
   - **Per-event cooldown** (`cooldownHours = 0` + internal `recentEvents` check): Trigger can fire multiple times per engine tick but each specific event/domain is gated. Use for time-sensitive triggers (meetings, research clusters).
   - **Hybrid** (`cooldownHours = 0` + internal per-day gate): Fires before routines; no global cooldown, but per-routine per-day limit. Use for contextual triggers tied to specific events.

4. **Test locally:**
   - Call the trigger directly in a test or via `ion prompt` to verify behavior
   - Check `agent_events` table for logged cooldown entries
   - Verify Discord embeds post correctly

5. **Document** the trigger's purpose, when it fires, and what it does in this file.

---

## Discord Integration

All proactive triggers post rich embeds to a Discord channel configured in `integrations.yaml` (`discord.proactive_channel`). The embed format is consistent:

```ts
buildRichEmbed({
  emoji: '📅',                  // Visual indicator
  title: 'Meeting in 30 minutes',
  subtitle: 'Weekly sync',      // Optional
  badges: ['09:30 AM'],         // Time/status tags
  narrative: 'attendees: Alice, Bob\nContext: last sync...',
  color: 0x5865F2,              // Embed color (decimal)
  footerText: 'Reply `done` to suppress',
})
```

Users can interact with embeds via inline Discord replies (e.g., `reply done` to suppress a meeting reminder, `reply note arxiv.org` to file a research note). The `postProactive` function handles routing replies back to the harness.

---

## Performance and Error Handling

- **Trigger errors are logged but non-fatal.** If one trigger fails (e.g., vec-server is down during memory recall), other triggers still run.
- **Expensive operations are gated.** Email sweeps are 22-hour cooldown; IMAP connections are rare. Safari clustering is read-only; zero network cost.
- **Embeds are non-blocking.** Discord post failures don't crash the engine — they're logged with a warning.
- **Recursion is prevented.** Triggers never spawn child triggers. Proactive is leaf logic, not orchestration.

All proactive engine activity is logged with `log.info` / `log.debug` messages tagged with the trigger ID. Check `~/.ion/engine.log` or `make ion-logs` to diagnose trigger behavior.
