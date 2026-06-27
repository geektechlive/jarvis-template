// Canonical ion.schedule.* registrations. Called once at extension module init
// (extension.ts). concurrency:'single' on every job so the engine deduplicates
// fires across all open Ion Desktop tabs — no per-session gating needed.
//
// The `scheduled()` wrapper handles:
//   - Ephemeral mode for routines that declare ephemeral: true
//   - Working memory write after routines that declare writes_chain_context: true
//   - routine_started / routine_delivered event logging
//   - Storing the job's ctx in the module-level schedulerCtx so dispatchObserver
//     still works (scheduled handlers get a fresh ctx per fire, not a session ctx)

import { type IonSDK, type IonContext, log } from 'ion-sdk'
import { loadRoutinesConfig, isEnabled, isQuietHours, isWorkingMemoryEnabled, isEphemeralMemoryEnabled } from './helpers'
import { setEphemeralMode, isEphemeralGlobalEnabled, setEphemeralGlobalEnabled } from '../memory/ephemeralMode'
import { logEvent, lastInboxItemText, writeWorkingMemory, hasPendingImprove, clearPendingImprove } from '../memory/episodic'
import { setSchedulerCtx } from './ctx'
import { wrapWithGapProbe } from './gapProbe'
import { schedulerIsIdle } from './index'
import { hasImproveBranchToday } from '../improve'
import { evictStale } from '../hooks/state'
import { tickReminders } from '../reminders/tick'

import {
  runMorningBrief,
  runMiddayCheckin,
  runMeetingPrep,
  runEveningJournal,
  runCommsPulse,
} from './routines/brief'
import { runFindingsDispatcher } from './routines/dispatcher'
import { runTriageCheck } from './routines/triageCheck'
import {
  runOvernightReflection,
  runWeeklyCurator,
  runSelfImprovement,
  runWellnessCheckin,
  runWeeklyNewsdesk,
  runDailyNewsdesk,
  runTechAdvisorWatch,
  runCfoWatch,
  runPortfolioWatch,
  runMemoryConsolidation,
  runVaultExport,
  runGithubWatch,
  runDiscordPulse,
  runRssFetch,
  runInfraWatch,
  runSecurityWatch,
  runRelayHealthCheck,
} from './routines/watch'
import {
  runLogPatrol,
  runCommitPatrol,
  runIssuePatrol,
  runImprovePatrol,
  runIssueResolver,
} from './routines/patrol'
import { runInterventionDigest } from './routines/intervention'
import { runNetflixHistorySync } from './routines/netflix'
import { runChainMiner } from '../chains'
import { runProactiveCheck } from '../proactive'
import { pollResolverFeedback } from '../patrol/feedback'
import { scanStaleApprovals } from '../patrol/staleApprovals'
import { runProjectsRefresh } from './routines/projects_refresh'
import { runMilestoneSweep } from './routines/milestone_sweep'
import { runStaffToolsSync } from './routines/staff_tools_sync'
import { runContactsPulse } from './routines/contacts_pulse'
import { runHomeMaintenanceCheck } from './routines/home_maintenance_check'
import { runWeeklyEntertainment } from './routines/weekly_entertainment'
import { runWeeklyDocTriage } from './routines/weekly_doc_triage'
import { runCommitActivitySummary } from './routines/commit_activity_summary'
import { runDailySummary, runWeeklySummary, runMonthlySummary } from './routines/daily_summary'
import { runGoalProposal } from '../autonomy/goalProposal'

// ---------------------------------------------------------------------------
// Job manifest — static list for listJobs() without needing the live registry
// ---------------------------------------------------------------------------

export const JOB_MANIFEST: Array<{ id: string; type: 'daily' | 'weekly' | 'interval'; schedule: string }> = []

// Per-fire ack window for interval routines that dispatch an agent inside the
// handler. ion's default fire_async ack is 60s, but these handlers legitimately
// run longer (comms_pulse's inner dispatchStaff budgets reach 90s; relay_health_check
// dispatches the observability-watcher agent), so the default logs a spurious
// timeout while the work completes. Mirrors the _autonomy_tick fix. concurrency
// stays 'single', so a wider window only delays the next fire of a job already
// running -- no overlap risk. The deployed ion honors per-job ScheduleJob.TimeoutMs.
const AGENT_DISPATCH_FIRE_TIMEOUT_MS = 180_000

// ---------------------------------------------------------------------------
// Wrapper: handles lifecycle logging, ephemeral mode, working memory
// ---------------------------------------------------------------------------

function scheduled(id: string, fn: (ctx: IonContext) => Promise<void>) {
  return async (ctx: IonContext): Promise<void> => {
    setSchedulerCtx(ctx)
    const cfg = loadRoutinesConfig()[id]
    logEvent(id, 'routine_started', { routine: id })
    const isEphemeral = cfg?.ephemeral === true && isEphemeralGlobalEnabled()
    if (isEphemeral) setEphemeralMode(true)
    try {
      await fn(ctx)
      logEvent(id, 'routine_delivered', { routine: id, dispatched: true })
    } catch (err: unknown) {
      logEvent(id, 'routine_delivered', { routine: id, exit_code: -1, error: String(err) })
      // Also emit a distinct routine_error event (matches the comms_pulse
      // convention in brief.ts) so routine failures are queryable as their own
      // event type instead of being buried in routine_delivered rows with
      // exit_code:-1. BEHAVIOR.md documents this as the failure-signal contract.
      logEvent(id, 'routine_error', { routine: id, error: String(err) })
      log.warn(`scheduler: ${id} failed`, { err: String(err) })
    } finally {
      if (isEphemeral) setEphemeralMode(false)
      if (cfg?.writes_chain_context && isWorkingMemoryEnabled()) {
        const summary = lastInboxItemText(id)
        if (summary) writeWorkingMemory(`[${id}] ${summary}`, id, 24)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Quiet-hours-aware enabled predicate
// ---------------------------------------------------------------------------

function gate(id: string): () => boolean {
  return () => {
    const cfg = loadRoutinesConfig()[id]
    const ignoreQuiet = cfg?.ignore_quiet_hours === true
    return isEnabled(id) && (ignoreQuiet || !isQuietHours())
  }
}

// Always-on gate: ignores quiet hours and enabled flag (internal infrastructure)
function alwaysOn(): () => boolean {
  return () => true
}

// ---------------------------------------------------------------------------
// Registration helpers
// ---------------------------------------------------------------------------

function dailyTime(id: string, defaultTime: string): string {
  return loadRoutinesConfig()[id]?.time ?? defaultTime
}

function weeklyTime(id: string, defaultTime: string): string {
  return loadRoutinesConfig()[id]?.time ?? defaultTime
}

function weeklyDay(id: string, defaultDay: 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday'): 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday' {
  const day = loadRoutinesConfig()[id]?.day?.toLowerCase()
  const valid = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday']
  if (day && valid.includes(day)) return day as 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday'
  return defaultDay
}

function intervalMs(id: string, defaultMinutes: number): number {
  const mins = loadRoutinesConfig()[id]?.interval_minutes ?? defaultMinutes
  return mins * 60_000
}

// ---------------------------------------------------------------------------
// Public registration entry point
// ---------------------------------------------------------------------------

export async function registerScheduledJobs(ion: IonSDK): Promise<void> {
  JOB_MANIFEST.length = 0 // reset before repopulating (safe to call on re-register after respawn)
  setEphemeralGlobalEnabled(isEphemeralMemoryEnabled())

  // ------------------------------------------------------------------
  // Daily jobs
  // ------------------------------------------------------------------

  // morning_brief
  await ion.schedule.daily({
    id: 'morning_brief',
    time: dailyTime('morning_brief', '07:30'),
    tz: 'America/Chicago',
    enabled: gate('morning_brief'),
    concurrency: 'single',
    handler: scheduled('morning_brief', async () => {
      await wrapWithGapProbe('morning_brief', runMorningBrief)()
    }),
  })
  JOB_MANIFEST.push({ id: 'morning_brief', type: 'daily', schedule: `daily ${dailyTime('morning_brief', '07:30')}` })

  // midday_checkin
  await ion.schedule.daily({
    id: 'midday_checkin',
    time: dailyTime('midday_checkin', '13:00'),
    tz: 'America/Chicago',
    enabled: gate('midday_checkin'),
    concurrency: 'single',
    handler: scheduled('midday_checkin', async () => {
      await wrapWithGapProbe('midday_checkin', runMiddayCheckin)()
    }),
  })
  JOB_MANIFEST.push({ id: 'midday_checkin', type: 'daily', schedule: `daily ${dailyTime('midday_checkin', '13:00')}` })

  // triage_check
  await ion.schedule.daily({
    id: 'triage_check',
    time: dailyTime('triage_check', '12:00'),
    tz: 'America/Chicago',
    enabled: gate('triage_check'),
    concurrency: 'single',
    handler: scheduled('triage_check', async () => { await runTriageCheck() }),
  })
  JOB_MANIFEST.push({ id: 'triage_check', type: 'daily', schedule: `daily ${dailyTime('triage_check', '12:00')}` })

  // evening_journal
  await ion.schedule.daily({
    id: 'evening_journal',
    time: dailyTime('evening_journal', '21:00'),
    tz: 'America/Chicago',
    enabled: gate('evening_journal'),
    concurrency: 'single',
    handler: scheduled('evening_journal', async () => { await runEveningJournal() }),
  })
  JOB_MANIFEST.push({ id: 'evening_journal', type: 'daily', schedule: `daily ${dailyTime('evening_journal', '21:00')}` })

  // overnight_reflection
  await ion.schedule.daily({
    id: 'overnight_reflection',
    time: dailyTime('overnight_reflection', '03:00'),
    tz: 'America/Chicago',
    enabled: gate('overnight_reflection'),
    concurrency: 'single',
    handler: scheduled('overnight_reflection', async () => { await runOvernightReflection() }),
  })
  JOB_MANIFEST.push({ id: 'overnight_reflection', type: 'daily', schedule: `daily ${dailyTime('overnight_reflection', '03:00')}` })

  // portfolio_watch
  await ion.schedule.daily({
    id: 'portfolio_watch',
    time: dailyTime('portfolio_watch', '09:15'),
    tz: 'America/Chicago',
    enabled: gate('portfolio_watch'),
    concurrency: 'single',
    handler: scheduled('portfolio_watch', async () => { await runPortfolioWatch() }),
  })
  JOB_MANIFEST.push({ id: 'portfolio_watch', type: 'daily', schedule: `daily ${dailyTime('portfolio_watch', '09:15')}` })

  // memory_consolidation
  await ion.schedule.daily({
    id: 'memory_consolidation',
    time: dailyTime('memory_consolidation', '02:00'),
    tz: 'America/Chicago',
    enabled: gate('memory_consolidation'),
    concurrency: 'single',
    handler: scheduled('memory_consolidation', async () => { await runMemoryConsolidation() }),
  })
  JOB_MANIFEST.push({ id: 'memory_consolidation', type: 'daily', schedule: `daily ${dailyTime('memory_consolidation', '02:00')}` })

  // vault_export
  await ion.schedule.daily({
    id: 'vault_export',
    time: dailyTime('vault_export', '03:30'),
    tz: 'America/Chicago',
    enabled: gate('vault_export'),
    concurrency: 'single',
    handler: scheduled('vault_export', async () => { await runVaultExport() }),
  })
  JOB_MANIFEST.push({ id: 'vault_export', type: 'daily', schedule: `daily ${dailyTime('vault_export', '03:30')}` })

  // chain_miner
  await ion.schedule.daily({
    id: 'chain_miner',
    time: dailyTime('chain_miner', '06:00'),
    tz: 'America/Chicago',
    enabled: gate('chain_miner'),
    concurrency: 'single',
    handler: scheduled('chain_miner', async () => { await runChainMiner() }),
  })
  JOB_MANIFEST.push({ id: 'chain_miner', type: 'daily', schedule: `daily ${dailyTime('chain_miner', '06:00')}` })

  // daily_summary
  await ion.schedule.daily({
    id: 'daily_summary',
    time: dailyTime('daily_summary', '02:00'),
    tz: 'America/Chicago',
    enabled: gate('daily_summary'),
    concurrency: 'single',
    handler: scheduled('daily_summary', async () => { await runDailySummary() }),
  })
  JOB_MANIFEST.push({ id: 'daily_summary', type: 'daily', schedule: `daily ${dailyTime('daily_summary', '02:00')}` })

  // github_watch
  await ion.schedule.daily({
    id: 'github_watch',
    time: dailyTime('github_watch', '09:00'),
    tz: 'America/Chicago',
    enabled: gate('github_watch'),
    concurrency: 'single',
    handler: scheduled('github_watch', async () => { await runGithubWatch() }),
  })
  JOB_MANIFEST.push({ id: 'github_watch', type: 'daily', schedule: `daily ${dailyTime('github_watch', '09:00')}` })

  // intervention_digest
  await ion.schedule.daily({
    id: 'intervention_digest',
    time: dailyTime('intervention_digest', '09:00'),
    tz: 'America/Chicago',
    enabled: gate('intervention_digest'),
    concurrency: 'single',
    handler: scheduled('intervention_digest', async () => { await runInterventionDigest() }),
  })
  JOB_MANIFEST.push({ id: 'intervention_digest', type: 'daily', schedule: `daily ${dailyTime('intervention_digest', '09:00')}` })

  // milestone_sweep
  await ion.schedule.daily({
    id: 'milestone_sweep',
    time: dailyTime('milestone_sweep', '09:30'),
    tz: 'America/Chicago',
    enabled: gate('milestone_sweep'),
    concurrency: 'single',
    handler: scheduled('milestone_sweep', async () => { await runMilestoneSweep() }),
  })
  JOB_MANIFEST.push({ id: 'milestone_sweep', type: 'daily', schedule: `daily ${dailyTime('milestone_sweep', '09:30')}` })

  // infra_watch
  await ion.schedule.daily({
    id: 'infra_watch',
    time: dailyTime('infra_watch', '09:00'),
    tz: 'America/Chicago',
    enabled: gate('infra_watch'),
    concurrency: 'single',
    handler: scheduled('infra_watch', async () => { await runInfraWatch() }),
  })
  JOB_MANIFEST.push({ id: 'infra_watch', type: 'daily', schedule: `daily ${dailyTime('infra_watch', '09:00')}` })

  // stale_approval_scan
  await ion.schedule.daily({
    id: 'stale_approval_scan',
    time: dailyTime('stale_approval_scan', '10:00'),
    tz: 'America/Chicago',
    enabled: gate('stale_approval_scan'),
    concurrency: 'single',
    handler: scheduled('stale_approval_scan', async () => { await scanStaleApprovals() }),
  })
  JOB_MANIFEST.push({ id: 'stale_approval_scan', type: 'daily', schedule: `daily ${dailyTime('stale_approval_scan', '10:00')}` })

  // ------------------------------------------------------------------
  // Weekly jobs
  // ------------------------------------------------------------------

  // weekly_curator
  await ion.schedule.weekly({
    id: 'weekly_curator',
    time: weeklyTime('weekly_curator', '08:00'),
    dayOfWeek: weeklyDay('weekly_curator', 'monday'),
    tz: 'America/Chicago',
    enabled: gate('weekly_curator'),
    concurrency: 'single',
    handler: scheduled('weekly_curator', async () => {
      await wrapWithGapProbe('weekly_curator', runWeeklyCurator)()
    }),
  })
  JOB_MANIFEST.push({ id: 'weekly_curator', type: 'weekly', schedule: `monday ${weeklyTime('weekly_curator', '08:00')}` })

  // wellness_checkin
  await ion.schedule.weekly({
    id: 'wellness_checkin',
    time: weeklyTime('wellness_checkin', '09:00'),
    dayOfWeek: weeklyDay('wellness_checkin', 'monday'),
    tz: 'America/Chicago',
    enabled: gate('wellness_checkin'),
    concurrency: 'single',
    handler: scheduled('wellness_checkin', async () => { await runWellnessCheckin() }),
  })
  JOB_MANIFEST.push({ id: 'wellness_checkin', type: 'weekly', schedule: `monday ${weeklyTime('wellness_checkin', '09:00')}` })

  // wellness_checkin_thu
  await ion.schedule.weekly({
    id: 'wellness_checkin_thu',
    time: weeklyTime('wellness_checkin_thu', '09:00'),
    dayOfWeek: weeklyDay('wellness_checkin_thu', 'thursday'),
    tz: 'America/Chicago',
    enabled: gate('wellness_checkin_thu'),
    concurrency: 'single',
    handler: scheduled('wellness_checkin_thu', async () => { await runWellnessCheckin() }),
  })
  JOB_MANIFEST.push({ id: 'wellness_checkin_thu', type: 'weekly', schedule: `thursday ${weeklyTime('wellness_checkin_thu', '09:00')}` })

  // weekly_newsdesk
  await ion.schedule.weekly({
    id: 'weekly_newsdesk',
    time: weeklyTime('weekly_newsdesk', '15:00'),
    dayOfWeek: weeklyDay('weekly_newsdesk', 'friday'),
    tz: 'America/Chicago',
    enabled: gate('weekly_newsdesk'),
    concurrency: 'single',
    handler: scheduled('weekly_newsdesk', async () => { await runWeeklyNewsdesk() }),
  })
  JOB_MANIFEST.push({ id: 'weekly_newsdesk', type: 'weekly', schedule: `friday ${weeklyTime('weekly_newsdesk', '15:00')}` })

  // daily_newsdesk (#850)
  await ion.schedule.daily({
    id: 'daily_newsdesk',
    time: dailyTime('daily_newsdesk', '08:30'),
    tz: 'America/Chicago',
    enabled: gate('daily_newsdesk'),
    concurrency: 'single',
    handler: scheduled('daily_newsdesk', async () => { await runDailyNewsdesk() }),
  })
  JOB_MANIFEST.push({ id: 'daily_newsdesk', type: 'daily', schedule: `daily ${dailyTime('daily_newsdesk', '08:30')}` })

  // tech_advisor_watch
  await ion.schedule.weekly({
    id: 'tech_advisor_watch',
    time: weeklyTime('tech_advisor_watch', '09:00'),
    dayOfWeek: weeklyDay('tech_advisor_watch', 'thursday'),
    tz: 'America/Chicago',
    enabled: gate('tech_advisor_watch'),
    concurrency: 'single',
    handler: scheduled('tech_advisor_watch', async () => { await runTechAdvisorWatch() }),
  })
  JOB_MANIFEST.push({ id: 'tech_advisor_watch', type: 'weekly', schedule: `thursday ${weeklyTime('tech_advisor_watch', '09:00')}` })

  // cfo_watch
  await ion.schedule.weekly({
    id: 'cfo_watch',
    time: weeklyTime('cfo_watch', '09:00'),
    dayOfWeek: weeklyDay('cfo_watch', 'friday'),
    tz: 'America/Chicago',
    enabled: gate('cfo_watch'),
    concurrency: 'single',
    handler: scheduled('cfo_watch', async () => { await runCfoWatch() }),
  })
  JOB_MANIFEST.push({ id: 'cfo_watch', type: 'weekly', schedule: `friday ${weeklyTime('cfo_watch', '09:00')}` })

  // security_watch
  await ion.schedule.weekly({
    id: 'security_watch',
    time: weeklyTime('security_watch', '09:30'),
    dayOfWeek: weeklyDay('security_watch', 'thursday'),
    tz: 'America/Chicago',
    enabled: gate('security_watch'),
    concurrency: 'single',
    handler: scheduled('security_watch', async () => { await runSecurityWatch() }),
  })
  JOB_MANIFEST.push({ id: 'security_watch', type: 'weekly', schedule: `thursday ${weeklyTime('security_watch', '09:30')}` })

  // netflix_history_sync
  await ion.schedule.weekly({
    id: 'netflix_history_sync',
    time: weeklyTime('netflix_history_sync', '10:00'),
    dayOfWeek: weeklyDay('netflix_history_sync', 'sunday'),
    tz: 'America/Chicago',
    enabled: gate('netflix_history_sync'),
    concurrency: 'single',
    handler: scheduled('netflix_history_sync', async () => { await runNetflixHistorySync() }),
  })
  JOB_MANIFEST.push({ id: 'netflix_history_sync', type: 'weekly', schedule: `sunday ${weeklyTime('netflix_history_sync', '10:00')}` })

  // goal_proposal
  await ion.schedule.weekly({
    id: 'goal_proposal',
    time: weeklyTime('goal_proposal', '06:00'),
    dayOfWeek: weeklyDay('goal_proposal', 'monday'),
    tz: 'America/Chicago',
    enabled: gate('goal_proposal'),
    concurrency: 'single',
    handler: scheduled('goal_proposal', async () => { await runGoalProposal() }),
  })
  JOB_MANIFEST.push({ id: 'goal_proposal', type: 'weekly', schedule: `monday ${weeklyTime('goal_proposal', '06:00')}` })

  // projects_refresh
  await ion.schedule.weekly({
    id: 'projects_refresh',
    time: weeklyTime('projects_refresh', '06:00'),
    dayOfWeek: weeklyDay('projects_refresh', 'monday'),
    tz: 'America/Chicago',
    enabled: gate('projects_refresh'),
    concurrency: 'single',
    handler: scheduled('projects_refresh', async () => { await runProjectsRefresh() }),
  })
  JOB_MANIFEST.push({ id: 'projects_refresh', type: 'weekly', schedule: `monday ${weeklyTime('projects_refresh', '06:00')}` })

  // contacts_pulse
  await ion.schedule.weekly({
    id: 'contacts_pulse',
    time: weeklyTime('contacts_pulse', '08:30'),
    dayOfWeek: weeklyDay('contacts_pulse', 'monday'),
    tz: 'America/Chicago',
    enabled: gate('contacts_pulse'),
    concurrency: 'single',
    handler: scheduled('contacts_pulse', async () => { await runContactsPulse() }),
  })
  JOB_MANIFEST.push({ id: 'contacts_pulse', type: 'weekly', schedule: `monday ${weeklyTime('contacts_pulse', '08:30')}` })

  // home_maintenance_check
  await ion.schedule.weekly({
    id: 'home_maintenance_check',
    time: weeklyTime('home_maintenance_check', '09:30'),
    dayOfWeek: weeklyDay('home_maintenance_check', 'monday'),
    tz: 'America/Chicago',
    enabled: gate('home_maintenance_check'),
    concurrency: 'single',
    handler: scheduled('home_maintenance_check', async () => { await runHomeMaintenanceCheck() }),
  })
  JOB_MANIFEST.push({ id: 'home_maintenance_check', type: 'weekly', schedule: `monday ${weeklyTime('home_maintenance_check', '09:30')}` })

  // weekly_entertainment
  await ion.schedule.weekly({
    id: 'weekly_entertainment',
    time: weeklyTime('weekly_entertainment', '17:00'),
    dayOfWeek: weeklyDay('weekly_entertainment', 'friday'),
    tz: 'America/Chicago',
    enabled: gate('weekly_entertainment'),
    concurrency: 'single',
    handler: scheduled('weekly_entertainment', async () => { await runWeeklyEntertainment() }),
  })
  JOB_MANIFEST.push({ id: 'weekly_entertainment', type: 'weekly', schedule: `friday ${weeklyTime('weekly_entertainment', '17:00')}` })

  // commit_activity_summary
  await ion.schedule.weekly({
    id: 'commit_activity_summary',
    time: weeklyTime('commit_activity_summary', '10:00'),
    dayOfWeek: weeklyDay('commit_activity_summary', 'friday'),
    tz: 'America/Chicago',
    enabled: gate('commit_activity_summary'),
    concurrency: 'single',
    handler: scheduled('commit_activity_summary', async () => { await runCommitActivitySummary() }),
  })
  JOB_MANIFEST.push({ id: 'commit_activity_summary', type: 'weekly', schedule: `friday ${weeklyTime('commit_activity_summary', '10:00')}` })

  // weekly_doc_triage
  await ion.schedule.weekly({
    id: 'weekly_doc_triage',
    time: weeklyTime('weekly_doc_triage', '10:00'),
    dayOfWeek: weeklyDay('weekly_doc_triage', 'saturday'),
    tz: 'America/Chicago',
    enabled: gate('weekly_doc_triage'),
    concurrency: 'single',
    handler: scheduled('weekly_doc_triage', async () => { await runWeeklyDocTriage() }),
  })
  JOB_MANIFEST.push({ id: 'weekly_doc_triage', type: 'weekly', schedule: `saturday ${weeklyTime('weekly_doc_triage', '10:00')}` })

  // weekly_summary
  await ion.schedule.weekly({
    id: 'weekly_summary',
    time: weeklyTime('weekly_summary', '06:30'),
    dayOfWeek: weeklyDay('weekly_summary', 'monday'),
    tz: 'America/Chicago',
    enabled: gate('weekly_summary'),
    concurrency: 'single',
    handler: scheduled('weekly_summary', async () => { await runWeeklySummary() }),
  })
  JOB_MANIFEST.push({ id: 'weekly_summary', type: 'weekly', schedule: `monday ${weeklyTime('weekly_summary', '06:30')}` })

  // monthly_summary — registered weekly (monday 06:15); handler internally checks
  // if it's the first week of the month before doing real work.
  await ion.schedule.weekly({
    id: 'monthly_summary',
    time: weeklyTime('monthly_summary', '06:15'),
    dayOfWeek: weeklyDay('monthly_summary', 'monday'),
    tz: 'America/Chicago',
    enabled: gate('monthly_summary'),
    concurrency: 'single',
    handler: scheduled('monthly_summary', async () => { await runMonthlySummary() }),
  })
  JOB_MANIFEST.push({ id: 'monthly_summary', type: 'weekly', schedule: `monday ${weeklyTime('monthly_summary', '06:15')}` })

  // ------------------------------------------------------------------
  // Interval jobs
  // ------------------------------------------------------------------

  // self_improvement
  await ion.schedule.interval({
    id: 'self_improvement',
    intervalMs: intervalMs('self_improvement', 2880),
    enabled: gate('self_improvement'),
    concurrency: 'single',
    handler: scheduled('self_improvement', async () => { await runSelfImprovement() }),
  })
  JOB_MANIFEST.push({ id: 'self_improvement', type: 'interval', schedule: 'every 2880m' })

  // staff_tools_sync (#849) -- PR agent-created staff-tools/ files via a /tmp worktree.
  await ion.schedule.interval({
    id: 'staff_tools_sync',
    intervalMs: intervalMs('staff_tools_sync', 60),
    enabled: gate('staff_tools_sync'),
    concurrency: 'single',
    handler: scheduled('staff_tools_sync', async () => { await runStaffToolsSync() }),
  })
  JOB_MANIFEST.push({ id: 'staff_tools_sync', type: 'interval', schedule: 'every 60m' })

  // meeting_prep
  await ion.schedule.interval({
    id: 'meeting_prep',
    intervalMs: intervalMs('meeting_prep', 5),
    enabled: gate('meeting_prep'),
    concurrency: 'single',
    handler: scheduled('meeting_prep', async () => {
      await wrapWithGapProbe('meeting_prep', runMeetingPrep)()
    }),
  })
  JOB_MANIFEST.push({ id: 'meeting_prep', type: 'interval', schedule: 'every 5m' })

  // proactive_check
  await ion.schedule.interval({
    id: 'proactive_check',
    intervalMs: intervalMs('proactive_check', 5),
    enabled: gate('proactive_check'),
    concurrency: 'single',
    handler: scheduled('proactive_check', async () => { await runProactiveCheck() }),
  })
  JOB_MANIFEST.push({ id: 'proactive_check', type: 'interval', schedule: 'every 5m' })

  // comms_pulse
  await ion.schedule.interval({
    id: 'comms_pulse',
    intervalMs: intervalMs('comms_pulse', 15),
    enabled: gate('comms_pulse'),
    concurrency: 'single',
    timeoutMs: AGENT_DISPATCH_FIRE_TIMEOUT_MS,
    handler: scheduled('comms_pulse', async () => { await runCommsPulse() }),
  })
  JOB_MANIFEST.push({ id: 'comms_pulse', type: 'interval', schedule: 'every 15m' })

  // discord_pulse
  await ion.schedule.interval({
    id: 'discord_pulse',
    intervalMs: intervalMs('discord_pulse', 20),
    enabled: gate('discord_pulse'),
    concurrency: 'single',
    handler: scheduled('discord_pulse', async () => { await runDiscordPulse() }),
  })
  JOB_MANIFEST.push({ id: 'discord_pulse', type: 'interval', schedule: 'every 20m' })

  // rss_fetch
  await ion.schedule.interval({
    id: 'rss_fetch',
    intervalMs: intervalMs('rss_fetch', 360),
    enabled: gate('rss_fetch'),
    concurrency: 'single',
    handler: scheduled('rss_fetch', async () => { await runRssFetch() }),
  })
  JOB_MANIFEST.push({ id: 'rss_fetch', type: 'interval', schedule: 'every 360m' })

  // relay_health_check
  await ion.schedule.interval({
    id: 'relay_health_check',
    intervalMs: intervalMs('relay_health_check', 240),
    enabled: gate('relay_health_check'),
    concurrency: 'single',
    timeoutMs: AGENT_DISPATCH_FIRE_TIMEOUT_MS,
    handler: scheduled('relay_health_check', async () => { await runRelayHealthCheck() }),
  })
  JOB_MANIFEST.push({ id: 'relay_health_check', type: 'interval', schedule: 'every 240m' })

  // findings_dispatcher
  await ion.schedule.interval({
    id: 'findings_dispatcher',
    intervalMs: intervalMs('findings_dispatcher', 10),
    enabled: gate('findings_dispatcher'),
    concurrency: 'single',
    handler: scheduled('findings_dispatcher', async (ctx) => { await runFindingsDispatcher(ctx) }),
  })
  JOB_MANIFEST.push({ id: 'findings_dispatcher', type: 'interval', schedule: 'every 10m' })

  // log_patrol
  await ion.schedule.interval({
    id: 'log_patrol',
    intervalMs: intervalMs('log_patrol', 90),
    enabled: gate('log_patrol'),
    concurrency: 'single',
    handler: scheduled('log_patrol', async () => { await runLogPatrol() }),
  })
  JOB_MANIFEST.push({ id: 'log_patrol', type: 'interval', schedule: 'every 90m' })

  // commit_patrol
  await ion.schedule.interval({
    id: 'commit_patrol',
    intervalMs: intervalMs('commit_patrol', 94),
    enabled: gate('commit_patrol'),
    concurrency: 'single',
    handler: scheduled('commit_patrol', async () => { await runCommitPatrol() }),
  })
  JOB_MANIFEST.push({ id: 'commit_patrol', type: 'interval', schedule: 'every 94m' })

  // issue_patrol
  await ion.schedule.interval({
    id: 'issue_patrol',
    intervalMs: intervalMs('issue_patrol', 98),
    enabled: gate('issue_patrol'),
    concurrency: 'single',
    handler: scheduled('issue_patrol', async () => { await runIssuePatrol() }),
  })
  JOB_MANIFEST.push({ id: 'issue_patrol', type: 'interval', schedule: 'every 98m' })

  // improve_patrol
  await ion.schedule.interval({
    id: 'improve_patrol',
    intervalMs: intervalMs('improve_patrol', 102),
    enabled: gate('improve_patrol'),
    concurrency: 'single',
    handler: scheduled('improve_patrol', async () => { await runImprovePatrol() }),
  })
  JOB_MANIFEST.push({ id: 'improve_patrol', type: 'interval', schedule: 'every 102m' })

  // issue_resolver
  await ion.schedule.interval({
    id: 'issue_resolver',
    intervalMs: intervalMs('issue_resolver', 240),
    enabled: gate('issue_resolver'),
    concurrency: 'single',
    handler: scheduled('issue_resolver', async () => { await runIssueResolver() }),
  })
  JOB_MANIFEST.push({ id: 'issue_resolver', type: 'interval', schedule: 'every 240m' })

  // resolver_feedback_poll (ignore_quiet_hours: true)
  await ion.schedule.interval({
    id: 'resolver_feedback_poll',
    intervalMs: intervalMs('resolver_feedback_poll', 1),
    enabled: alwaysOn(),
    concurrency: 'single',
    handler: scheduled('resolver_feedback_poll', async () => { await pollResolverFeedback() }),
  })
  JOB_MANIFEST.push({ id: 'resolver_feedback_poll', type: 'interval', schedule: 'every 1m' })

  // _tick_reminders — internal infrastructure, replaces tick() rider
  await ion.schedule.interval({
    id: '_tick_reminders',
    intervalMs: 60_000,
    enabled: alwaysOn(),
    concurrency: 'single',
    handler: async (ctx) => { await tickReminders(ctx) },
  })
  JOB_MANIFEST.push({ id: '_tick_reminders', type: 'interval', schedule: 'every 1m' })

  // _evict_stale — internal infrastructure, replaces tick() rider
  await ion.schedule.interval({
    id: '_evict_stale',
    intervalMs: 3_600_000,
    enabled: alwaysOn(),
    concurrency: 'single',
    handler: async () => { evictStale(6) },
  })
  JOB_MANIFEST.push({ id: '_evict_stale', type: 'interval', schedule: 'every 60m' })

  // _pending_improve — fires pending self-improvement after complex sessions, once idle
  await ion.schedule.interval({
    id: '_pending_improve',
    intervalMs: 60_000,
    enabled: alwaysOn(),
    concurrency: 'single',
    handler: async () => {
      if (!hasPendingImprove() || !schedulerIsIdle() || !isEnabled('self_improvement')) return
      const hasBranch = await hasImproveBranchToday()
      clearPendingImprove()
      if (!hasBranch) {
        log.info('scheduler: firing pending_improve (complex session triggered)')
        await runSelfImprovement()
      } else {
        log.info('scheduler: pending_improve cleared -- daily cap already reached')
      }
    },
  })
  JOB_MANIFEST.push({ id: '_pending_improve', type: 'interval', schedule: 'every 1m' })

  log.info('scheduler: registered jobs via ion.schedule.*', { count: JOB_MANIFEST.length })
}
