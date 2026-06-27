// Jarvis TypeScript ion extension -- entry point.
// Registers hooks, tools, and commands. All orchestration logic lives in
// sub-modules imported here; this file is wiring only.

import { createIon, log } from 'ion-sdk'
import { wireHooks } from './hooks'
import { registerTools } from './registrations/tools'
import { registerCommands } from './registrations/commands'
import { wireShutdown } from './shutdown'
import { registerScheduledJobs } from './scheduler/register'
import { registerAutonomyJob } from './autonomy'
import { handleUnifiWebhook } from './webhooks/unifi'
import { handleImessageWebhook } from './webhooks/imessage'
import { initBriefingsHandle } from './resources/briefings'
import { initFindingHandle, fetchFindingsFromStore } from './resources/finding'
import { initImessageHandle, fetchImessagesFromStore } from './resources/imessage'
import { initReminderHandle, fetchRemindersFromStore } from './resources/reminder'
import { fetchBriefingsFromDb, recordError } from './memory/episodic'
import { registerDispatchTools } from './registrations/dispatchTools'

// Suppress DEP0169 (url.parse) emitted by rss-parser dependency at import time.
// No WHATWG-compatible replacement is available without patching the library.
process.on('warning', (warning) => {
  if ((warning as NodeJS.ErrnoException).code === 'DEP0169') return
})

const ion = createIon()

// Declare the 'briefing' resource kind so Desktop + iOS receive briefing deltas
// via the engine's resource subsystem. onQuery answers reconnect snapshots from
// the agent_events backing store. initBriefingsHandle wires the handle into the
// resources/briefings module so scheduler jobs can call briefings.publish().
void ion.resources.declare({ kind: 'briefing' }).then((handle) => {
  initBriefingsHandle(handle)
  log.info('jarvis: briefings resource declared')
}).catch((err: unknown) => {
  log.warn('jarvis: failed to declare briefings resource', { err: String(err) })
  recordError('extension_init', err)
})
ion.resources.onQuery('briefing', () => fetchBriefingsFromDb())

// Declare the 'finding' resource kind so Desktop + iOS can deep-link to
// individual findings, syntheses, and important bundles via their resourceId.
void ion.resources.declare({ kind: 'finding' }).then((handle) => {
  initFindingHandle(handle)
  log.info('jarvis: finding resource declared')
}).catch((err: unknown) => {
  log.warn('jarvis: failed to declare finding resource', { err: String(err) })
  recordError('extension_init', err)
})
ion.resources.onQuery('finding', () => fetchFindingsFromStore())

// Declare the 'imessage' resource kind so urgent iMessage notifications
// deep-link to the correct conversation thread on iOS.
void ion.resources.declare({ kind: 'imessage' }).then((handle) => {
  initImessageHandle(handle)
  log.info('jarvis: imessage resource declared')
}).catch((err: unknown) => {
  log.warn('jarvis: failed to declare imessage resource', { err: String(err) })
  recordError('extension_init', err)
})
ion.resources.onQuery('imessage', () => fetchImessagesFromStore())

// Declare the 'reminder' resource kind so reminder notifications deep-link
// to the specific reminder on Desktop + iOS.
void ion.resources.declare({ kind: 'reminder' }).then((handle) => {
  initReminderHandle(handle)
  log.info('jarvis: reminder resource declared')
}).catch((err: unknown) => {
  log.warn('jarvis: failed to declare reminder resource', { err: String(err) })
  recordError('extension_init', err)
})
ion.resources.onQuery('reminder', () => fetchRemindersFromStore())

// Register the ControlRoom dispatch tools: dispatch_agent, dispatch_specialist,
// request_consultant, recall_agent, check_agent_status, convene_meeting.
// These replace the engine's generic Agent tool (suppressed at session_start
// via initializeControlRoom). The ControlRoom is populated by initializeControlRoom
// called from the session_start hook. ion#183 (CliBackend dispatch race) is fixed
// in our ion submodule at e5c4dbe.
registerDispatchTools(ion)

// Register scheduled jobs and autonomy at module init — concurrency:'single' on
// every job ensures the engine deduplicates fires across all open Ion Desktop tabs.
void registerScheduledJobs(ion).catch((err: unknown) => {
  log.warn('jarvis: registerScheduledJobs failed', { err: String(err) })
  recordError('extension_init', err)
})
registerAutonomyJob(ion)
void ion.webhooks.register({
  path: '/webhook/unifi',
  method: 'POST',
  concurrency: 'single',
  auth: { kind: 'bearer', token: () => process.env['UNIFI_WEBHOOK_TOKEN'] ?? '' },
  handler: handleUnifiWebhook,
}).catch((err: unknown) => {
  log.warn('jarvis: failed to register unifi webhook', { err: String(err) })
  recordError('extension_init', err)
})
void ion.webhooks.register({
  path: '/webhook/imessage',
  method: 'POST',
  concurrency: 'single',
  auth: { kind: 'bearer', token: () => process.env['IMESSAGE_WEBHOOK_TOKEN'] ?? '' },
  handler: handleImessageWebhook,
}).catch((err: unknown) => {
  log.warn('jarvis: failed to register imessage webhook', { err: String(err) })
  recordError('extension_init', err)
})

wireHooks(ion)
registerTools(ion)
registerCommands(ion)
wireShutdown()

// Startup validation: if session dir contains old username, warn (#373)
const sessionDir = process.env['ION_SESSION_DIR'] || process.env['HOME'] || ''
if (sessionDir.includes('<username>')) {
  log.warn('jarvis: session dir contains old username (<username>); verify on Mini username is <username>')
}

log.info('jarvis: extension loaded')
