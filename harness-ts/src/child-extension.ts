// Tools-only child extension.
//
// Loaded by dispatched staff agents (via dispatchStaff → ctx.dispatchAgent's
// extensionDir) so they have the harness's custom tools in their child
// sessions: recall_memory, remember_fact, calendar, mail_send, spotlight_search,
// reminders, etc.
//
// Deliberately does NOT import or start the scheduler, autonomy loop, or webhook
// server. Those live in extension.ts and must run exactly once, in the root
// session. Loading the full extension per child would spawn duplicate loops and
// a second webhook server racing the same port — which is why this is a separate
// entry point rather than a flag on the main extension.

import { createIon, log } from 'ion-sdk'
import { registerTools } from './registrations/tools'
import { bannedTokenEnforcement } from './persona/audit'
import { EXECUTION_CONTEXT_PREAMBLE } from './persona/executionContext'
import { TOOL_TIERS } from './hooks/state'

const ion = createIon()

// Utility tools for staff sub-agents dispatched with this child extension.
registerTools(ion)

// Permission tiers — mirror the main extension so staff tool calls in child
// sessions get the same classification rather than ion's bare default.
ion.on('permission_classify', (_ctx, info) => {
  return TOOL_TIERS[info?.tool_name ?? ''] ?? null
})

// Chain-of-command + banned-token constraints for anything spawned inside a
// staff child session. The specialist persona itself arrives via the
// systemPrompt passed to ctx.dispatchAgent, so this only adds the reporting
// preamble and tone rules — it does not re-inject a persona.
ion.on('before_agent_start', (_ctx, _info) => {
  return {
    systemPrompt:
      `You report to Jarvis, the principal's chief of staff. ` +
      `He will re-speak your output. Be precise; tone is his job, not yours.` +
      EXECUTION_CONTEXT_PREAMBLE +
      bannedTokenEnforcement(),
  }
})

log.info('jarvis: child extension loaded (tools-only)')
