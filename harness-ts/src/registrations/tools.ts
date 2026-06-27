import type { IonSDK } from 'ion-sdk'
import { registerMemoryToolsR1, registerMemoryToolsR7, registerMemoryToolsR11 } from './tools/memory'
import { registerCalendarToolsR2, registerCalendarToolsR4, registerCalendarToolsR8 } from './tools/calendar'
import { registerCommsToolsR5, registerCommsToolsR10 } from './tools/comms'
import { registerSystemToolsR3, registerSystemToolsR6, registerSystemToolsR9, registerSystemToolsR12 } from './tools/system'
import { registerHabitToolsR13 } from './tools/habits'

// All ion.registerTool() calls -- the LLM-facing utility tool surface for Jarvis.
// Interactive staff DISPATCH is registered separately in registrations/dispatchTools.ts
// (dispatch_agent / dispatch_specialist / request_consultant / recall_agent /
// check_agent_status / convene_meeting), which route through the ControlRoom. The
// CliBackend ToolServer race that once made tool-driven dispatch unsafe
// (dsswift/ion#183) is fixed (ctxStack, e5c4dbe), present in our ion submodule.
//
// Sub-registrar layout (12 runs across 4 files; run order reproduces exact
// original registration sequence — positions 1–39):
//
//   R1  memory.ts    recall_memory, get_safari_activity, remember_fact, ingest_item          (pos 1–4)
//   R2  calendar.ts  get_today_events, get_week_events, get_upcoming_events                  (pos 5–7)
//   R3  system.ts    spotlight_search, git_diff, git_apply_patch                             (pos 8–10)
//   R4  calendar.ts  calendar_create_event, calendar_delete_event, calendar_update_event     (pos 11–13)
//   R5  comms.ts     mail_send, surface_to_inbox, queue_for_brief, send_to_chat_channel,
//                    create_reminder, send_imessage, discord_send, lookup_contact            (pos 14–21)
//   R6  system.ts    jina_fetch                                                              (pos 22)
//   R7  memory.ts    create_matter                                                           (pos 23)
//   R8  calendar.ts  reminder_list, reminder_create, reminder_complete                       (pos 24–26)
//   R9  system.ts    notes_read, notes_create, get_health_data                               (pos 27–29)
//   R10 comms.ts     bluesky_post, bluesky_reply, bluesky_repost, bluesky_like,
//                    bluesky_resolve_post, bluesky_get_notifications, bluesky_search_posts,
//                    bluesky_get_timeline                                                     (pos 30–37)
//   R11 memory.ts    add_to_matter, list_matters, get_matter, close_matter                  (pos 38–41)
//   R12 system.ts    get_routine_status                                                      (pos 42)
//   R13 habits.ts    create_habit, log_habit, get_habits, habit_stats                       (pos 43–46)
//
// Grouping-vs-order conflict: create_reminder (pos 18) sits between comms tools
// and was kept in comms.ts (R5) rather than calendar.ts so original order is
// preserved. Order wins over domain purity per design decision in tools.ts split.
export function registerTools(ion: IonSDK): void {
  registerMemoryToolsR1(ion)    // pos 1–4
  registerCalendarToolsR2(ion)  // pos 5–7
  registerSystemToolsR3(ion)    // pos 8–10
  registerCalendarToolsR4(ion)  // pos 11–13
  registerCommsToolsR5(ion)     // pos 14–21
  registerSystemToolsR6(ion)    // pos 22
  registerMemoryToolsR7(ion)    // pos 23
  registerCalendarToolsR8(ion)  // pos 24–26
  registerSystemToolsR9(ion)    // pos 27–29
  registerCommsToolsR10(ion)    // pos 30–37
  registerMemoryToolsR11(ion)   // pos 38–41
  registerSystemToolsR12(ion)   // pos 42
  registerHabitToolsR13(ion)    // pos 43–46
}
