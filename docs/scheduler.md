---
title: Scheduler
description: Background routine orchestrator running inside the ion extension process. Fires daily, weekly, and interval jobs with cross-restart dedup and ambient gap detection.
sidebar_position: 8
---

# Scheduler

The Jarvis scheduler is a TypeScript job orchestrator embedded in the ion extension. It fires 49 routines on daily, weekly, and interval schedules while maintaining dedup guards across daemon restarts and detecting knowledge gaps before task execution.

## Overview

The scheduler is not a separate cron daemon or external process. It runs **inside the ion extension process** as a `setInterval(tick, 60_000)` loop that fires every minute. This design has explicit tradeoffs:

| Aspect | In-Process | Separate Daemon |
|--------|-----------|-----------------|
| IPC complexity | None | Needs message queue to fire turns |
| Session context access | Direct | Requires polling episodic.ts |
| Restart resilience | Simpler dedup guards | More complex state sync |
| Memory overhead | One timer loop | Separate process overhead |

**WHY in-process:** The scheduler needs to call `ctx.dispatchAgent()` to fire routine turns with session context. A separate cron daemon would lose that context and need to send messages back to ion. Embedding the scheduler avoids this IPC penalty and keeps all state in one place.

## Architecture: Why In-Process

1. **Session context is free** — routines run inside `before_prompt` and `turn_end` hooks, so they have access to `ctx` (ion context) without serialization.
2. **Dedup is local** — in-memory Set (`_runningJobs`) tracks concurrent interval jobs without database polling.
3. **Restarts are survivable** — episodic.ts (SQLite) persists `routine_started` and `routine_delivered` events, so daily/weekly jobs know whether they already ran today even after a daemon restart.

The scheduler reads `harness/config/routines.yaml` at startup and wraps every routine with `prospectiveGapProbe()` before firing. If a gap is detected (e.g., morning brief needs stock prices but has no recent financial knowledge), the routine still runs but has context about what is missing.

## Routine Types

The scheduler supports three job patterns:

### Daily Jobs

Fire **once per calendar day** at a specific time (HH:MM CT). Tracks last run by **date string**, not by wall-clock time.

```typescript
// Pseudocode: check if already ran today
function alreadyFiredToday(jobId: string): boolean {
  const recent = recentEvents(jobId, 'routine_delivered', 23)
  return recent.length > 0
}
```

**WHY 23-hour window, not 24?** A job scheduled for 07:30 tomorrow must fire by 07:30. With a 24h window, if it fires at 07:35 today, the window includes that run until 07:35 tomorrow, blocking the next fire. A 23h window clears by 07:30 tomorrow (24h later), ensuring the next day's fire is not blocked.

**WHY date string, not timestamp?** Date-based logic survives daemon restarts. If the daemon restarts at 08:00, the morning_brief (07:30) already fired today. Checking the date (not a timer) answers correctly without re-firing.

### Weekly Jobs

Fire **once per calendar week** on a specific day and time (e.g., Monday 08:15).

```typescript
// Example: weekly_curator fires Monday 08:15 CT
day: "monday"
time: "08:15"
```

Tracks last run by date string, just like daily jobs. If the daemon restarts mid-week, the job knows whether it already ran this week.

### Interval Jobs

Fire **every N minutes** with two dedup guards:

1. **Within-process** — `_runningJobs` Set prevents overlapping runs of the same job if it outlasts its own interval.
2. **Cross-process** — `recentlyStarted(jobId, withinHours)` checks SQLite `routine_started` events from the last 23 hours. If a run is already in progress (started but not yet delivered), the next tick skips it.

```typescript
// Pseudocode: cross-process guard
function recentlyStarted(jobId: string, withinHours: number): boolean {
  const recent = recentEvents(jobId, 'routine_started', withinHours)
  return recent.length > 0
}
```

**WHY two guards?** Within-process Set catches same-tick recursion (e.g., a slow job that takes 6 minutes running on a 5-minute interval). Cross-process SQLite catches restarts: if `findings_dispatcher` starts, writes `routine_started`, then the daemon restarts before `routine_delivered` fires, the next instance sees the in-flight `routine_started` event and does not spawn a duplicate.

## Quiet Hours

Interval jobs respect a quiet-hours window (default 23:00–06:00 CT) unless explicitly tagged `ignore_quiet_hours: true`.

```yaml
quiet_hours_start: 23
quiet_hours_end: 6
```

Jobs with `ignore_quiet_hours: true` (e.g., `findings_dispatcher`, `resolver_feedback_poll`) fire 24/7 because finding delivery and CI monitoring cannot sleep.

## Routine Reference

> **Snapshot of `harness/config/routines.yaml` — regenerate from that file when it changes.**

All 49 routines defined in `harness/config/routines.yaml`. Schedule and Enabled values are pulled directly from the YAML.

| Routine | Schedule | Enabled | Purpose |
|---------|----------|---------|---------|
| **Daily** | | | |
| memory_consolidation | daily 02:00 | ✓ | Session summaries, cross-session synthesis, dedup, decay |
| daily_summary | daily 02:05 | ✓ | Nightly cross-session digest of what Jarvis and Alex discussed/worked on |
| overnight_reflection | daily 03:00 | ✓ | Wakes with an open prompt; decides whether to run_reflection |
| vault_export | daily 03:30 | ✓ | Export all three memory collections to iCloud markdown |
| chain_miner | daily 06:00 | ✓ | Scan agent_events for A→B dispatch patterns; write chain hints |
| morning_brief | daily 07:30 | ✓ | Calendar, open mail, open items |
| daily_newsdesk | daily 08:30 | ✓ | Daily news digest from the news collection pushed to Discord |
| github_watch | daily 09:00 | ✓ | Repo Steward scan: open PRs, failing CI, new issues on active repos |
| intervention_digest | daily 09:05 | ✓ | Discord digest of patrol issues needing human action |
| infra_watch | daily 09:15 | ✓ | Systems Engineer check: Cloudflare zone health, UniFi network status |
| portfolio_watch | daily 09:25 | ✓ | Portfolio Manager scan: significant moves (>2%), breaking news, risk flags |
| milestone_sweep | daily 09:30 | ✓ | Auto-assign unmilestoned jarvis-patrol issues to their milestone |
| stale_approval_scan | daily 10:05 | ✓ | Surface proposed actions older than 7 days awaiting approval |
| triage_check | daily 12:00 | ✓ | Open issues missing severity/milestone, posted to Discord |
| midday_checkin | daily 13:00 | ✓ | Mid-day summary of unresolved triage items (question/review) |
| evening_journal | daily 21:00 | ✓ | Evening journal surfaced to inbox (journal always writes; this gates delivery) |
| **Weekly** | | | |
| monthly_summary | Mon 06:50 | ✓ | Monthly synthesis of weekly summaries (first 7 days of month only) |
| goal_proposal | Mon 06:10 | ✓ | Autonomous goal proposal engine (max 3/run, 10 active max) |
| projects_refresh | Mon 06:30 | ✓ | Refresh PROJECTS.md last-pushed dates and tier categorization from GitHub |
| weekly_summary | Mon 07:10 | ✓ | Weekly narrative synthesized from daily summaries |
| weekly_curator | Mon 08:15 | ✓ | Weekly knowledge-pattern summary |
| contacts_pulse | Mon 09:05 | ✓ | Surface upcoming birthdays/anniversaries and overdue relationships |
| wellness_checkin | Mon 10:00 | ✓ | Wellness Coach check-in on calendar density, energy, wellbeing (Mon) |
| home_maintenance_check | Mon 11:00 | ✓ | Home/Property Manager sweep: overdue maintenance from property.yaml |
| tech_advisor_watch | Thu 09:10 | ✓ | Tech Advisor observer: recurring tech topics, deferred tech decisions |
| security_watch | Thu 09:30 | ✓ | Security Analyst scan: CVE checks, credential leak detection, OSINT |
| wellness_checkin_thu | Thu 09:40 | ✓ | Thursday Wellness Coach check-in (independently gated) |
| cfo_watch | Fri 09:00 | ✓ | CFO scan: new charges, uncategorized subscriptions, spend patterns |
| commit_activity_summary | Fri 10:00 | ✓ | Chief of Strategy + Repo Steward review of commits across Source projects |
| weekly_newsdesk | Fri 15:00 | ✓ | Weekly News Desk observer: topics Alex asked about, noteworthy developments |
| weekly_entertainment | Fri 17:00 | ✓ | Entertainment Advisor brief: new releases matching taste profile |
| weekly_doc_triage | Sat 10:00 | ✓ | Document Steward triage: Downloads aging, large files, recent iCloud activity |
| netflix_history_sync | Sun 10:00 | ✓ | Fetch Netflix history; dispatch Entertainment Advisor to update taste profile |
| **Interval** | | | |
| autonomy | every 1m (managed separately) | ✓ | Always-on goal pursuit worker; managed by autonomy module, not scheduler |
| resolver_feedback_poll | every 1m (24/7) | ✓ | Poll vec-server for watchdog deploy outcomes after resolver pushes |
| self_improvement | every 2880m (48h) | ✗ | Propose one config/identity improvement, push auto/improve-* branch for CI |
| meeting_prep | every 5m | ✓ | Pre-meeting brief fired 10 min before calendar events |
| proactive_check | every 5m | ✓ | Proactive trigger engine: check thresholds, push to #jarvis-proactive |
| findings_dispatcher | every 10m (24/7) | ✓ | Drain findings queue, route by criticality (critical → push, info → brief) |
| comms_pulse | every 15m | ✓ | Chief of Communications pulse: scan inbound mail/comms, surface urgent |
| discord_pulse | every 20m | ✗ | Chief of Communications Discord pulse: scan watched channels/DMs |
| staff_tools_sync | every 60m | ✓ | PR any untracked staff-tools/ files to origin, then clean local copies |
| issue_resolver | every 240m | ✓ | Pick a jarvis-auto issue, implement a fix, validate, push to main |
| relay_health_check | every 240m | ✓ | End-to-end relay health: cloudflared tunnel, ion-relay binding, push-channel |
| rss_fetch | every 360m | ✓ | Fetch configured RSS feeds, store notable items to knowledge for News Desk |
| log_patrol | every 480m | ✓ | Scan runtime error logs for real errors; file GitHub bugs |
| commit_patrol | every 485m | ✓ | Review recent commits for quality problems/regressions; file issues |
| issue_patrol | every 490m | ✓ | Triage open jarvis-patrol issues, close resolved/stale (files no new issues) |
| improve_patrol | every 495m | ✓ | Review config and identity files for gaps; file enhancement issues |

## Gap Probing

Every routine is wrapped with `prospectiveGapProbe()` before execution:

```typescript
function wrapWithGapProbe(routineId: string, fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    // Probe for knowledge gaps before running
    // Routine can access gap context if needed
    await fn()
  }
}
```

**WHY probing before execution?** A routine like morning_brief might need recent financial data. Before running, the scheduler checks whether that knowledge exists. If not, a `gap_probe` event is logged. The routine itself can then decide: run anyway (common case), or ask a clarification question first. This prevents wasting effort on incomplete briefs.

## Dedup Across Restarts

When the ion daemon restarts:

1. **Daily/weekly jobs** — check SQLite for `routine_delivered` events in the last 23 hours. If found, the job already ran today/this week; skip it.
2. **Interval jobs** — check SQLite for `routine_started` events in the last 23 hours. If found, a run is already in progress or recently completed; skip it. This prevents re-firing jobs that were interrupted by a restart.
3. **Autonomy** — not a scheduler job. Managed entirely by `harness-ts/src/autonomy/index.ts` with its own 1-minute polling loop and 20-run/day cap.

**WHY SQLite, not in-memory?** Memory state is lost on restart. SQLite persists across daemon restarts, so the scheduler knows globally whether a job already ran, not just locally.

## Adding a New Routine

1. **Edit `harness/config/routines.yaml`** — add a new entry with schedule and description:
   ```yaml
   my_new_routine:
     enabled: true
     time: "10:00"  # or interval_minutes: 15
     deliver_to: [tui]
     ephemeral: true
     description: "What this routine does."
   ```

2. **Implement the routine function** — in `harness-ts/src/scheduler/routines/` (or appropriate subdirectory):
   ```typescript
   export async function runMyNewRoutine(): Promise<void> {
     if (!isEnabled('my_new_routine')) return
     // Your implementation
   }
   ```

3. **Register in `buildJobs()`** — add to the jobs array in `harness-ts/src/scheduler/index.ts`:
   ```typescript
   if (cfg.my_new_routine?.enabled) {
     _jobs.push({
       type: 'daily',
       id: 'my_new_routine',
       hour: 10,
       minute: 0,
       run: () => runMyNewRoutine(),
       lastRunDate: '',
     })
   }
   ```

4. **Test locally** — use `ion prompt` with a manual `/brief my-routine-name` command, or manually call the routine from a REPL.

5. **Deploy** — `make deploy-jarvis` restarts the ion extension and reloads the YAML.

## Disabling / Enabling Routines

To disable a routine **without restarting the daemon:**

```bash
# Edit the YAML and save
vi harness/config/routines.yaml

# Set enabled: false on the routine
# The scheduler watches the file and reloads on the next tick
```

To enable/disable **at runtime** (temporary, until next deploy):

```
/list-staff  # See enabled routines
# (no command to toggle yet; requires code edit + deploy)
```

**WHY YAML flag, not a CLI toggle?** The flag is persistent and survives restarts. A toggle command would be lost on daemon restart. YAML is the source of truth.

## Ephemeral and Working Memory

Routines tagged with `ephemeral: true` route extracted facts to **task memory** instead of long-term **knowledge**. This prevents briefing facts from polluting the long-term recall pool.

```yaml
morning_brief:
  ephemeral: true  # Facts stay session-scoped
```

Feature flags (read from YAML at startup):

| Flag | Purpose | Default |
|------|---------|---------|
| `ephemeral_memory_enabled` | Shadow mode: test task memory without disabling knowledge writes | `true` |
| `working_memory_enabled` | Accumulate facts during a session for in-turn recall | `true` |
| `entity_batching_enabled` | Batch entity mentions for efficient storage | `true` |

## Monitoring

Check scheduler health via the `/pending` command:

```
/pending
```

This shows:
- Next scheduled routine fires
- Currently running routines
- Recently delivered routines (last 24h)

Check scheduler logs:

```bash
ssh mini
tail -f ~/.ion/engine.log | grep "routine_"
```

## Reminders

Reminders are one-off time-based alerts set by the user or Jarvis (e.g., "remind me in 2 hours to call back"). They are different from scheduler routines, which are recurring. Reminders are stored in SQLite and delivered via a tick that runs alongside the scheduler.

### Parsing Natural Language

Reminders use **chrono-node** for natural language date parsing. This library handles relative times without custom logic:

- `"in 2 hours"` → 2 hours from now
- `"tomorrow at 3pm"` → tomorrow at 15:00 CT
- `"next Monday"` → next Monday at the current time

The `parseReminderInput()` function returns a `ParseResult` containing the fire time and extracted message (with time expressions stripped).

**WHY chrono-node?** Natural language scheduling is complex. Chrono handles relative offsets, absolute dates, recurring patterns, and timezone awareness. Rolling this by hand would be thousands of lines of fragile logic.

### Delivery: Active Session vs. Sleeping

The reminder tick (`tickReminders()`) checks each due reminder and delivers via one of two paths:

**Active session (within 5 minutes):** Inject as a `pending_reminder` block in the next `before_prompt` hook. The user sees it inline with the conversation.

**No active session:** Push to phone via APNs relay. The reminder reaches the phone immediately, regardless of whether Jarvis is awake.

**WHY two paths?** A reminder injected into a sleeping session would never be seen. The 5-minute active window catches rapid back-and-forth conversations. If the user is idle, APNs ensures the alert still reaches them.

### Creating a Reminder

Use the `/remind` command with natural language:

```
/remind tomorrow at 3pm to review the PR
/remind in 2 hours call back Alex
/remind next Monday email the team
```

The command parses the input, stores the reminder in SQLite, and confirms the fire time in Chicago time (CT).

### Implementation Detail: Idempotency

Each delivery attempt marks the reminder as fired using a compare-and-swap (CAS) check. If the tick fires twice before the database write completes, only one delivery succeeds. This prevents duplicate reminders on slow systems.
