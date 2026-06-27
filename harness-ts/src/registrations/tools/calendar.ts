import type { IonSDK } from 'ion-sdk'
import { getTodayEventsStr, getWeekEventsStr, getUpcomingEvents, createCalendarEvent, deleteCalendarEvent, updateCalendarEvent } from '../../tools/calendar'
import { reminderList, reminderCreate, reminderComplete } from '../../tools/reminders'
import { sanitizeUntrusted } from '../../memory/sanitize'

// R2: calendar read tools (original positions 5–7)
export function registerCalendarToolsR2(ion: IonSDK): void {
  ion.registerTool({
    name: 'get_today_events',
    description: "Get today's calendar events from iCloud CalDAV. Returns sorted time — title lines. Each line includes [uid:<uid>] at the end; pass that uid to calendar_delete_event or calendar_update_event.",
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => {
      return { content: sanitizeUntrusted(await getTodayEventsStr()) }
    },
  })

  ion.registerTool({
    name: 'get_week_events',
    description: "Get this week's calendar events from iCloud CalDAV. Returns sorted date time — title lines. Each line includes [uid:<uid>] at the end; pass that uid to calendar_delete_event or calendar_update_event.",
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => {
      return { content: sanitizeUntrusted(await getWeekEventsStr()) }
    },
  })

  ion.registerTool({
    name: 'get_upcoming_events',
    description: 'Get upcoming calendar events within a specified time window (in minutes). Returns title, start time, end time, location, and uid. Pass uid to calendar_delete_event or calendar_update_event.',
    parameters: {
      type: 'object',
      properties: {
        window_minutes: {
          type: 'number',
          description: 'Time window in minutes to look ahead (default 120, i.e. 2 hours).',
        },
      },
      required: [],
    },
    execute: async (params) => {
      const windowMinutes = Math.max(Number((params['window_minutes'] as number | undefined) ?? 120), 1)
      const events = await getUpcomingEvents(windowMinutes)
      if (events.length === 0) {
        return { content: '[No upcoming events in this window]' }
      }
      const lines = events.map((e) => {
        const endStr = e.end_time ? ` - ${e.end_time}` : ''
        const locStr = e.location ? ` at ${sanitizeUntrusted(e.location)}` : ''
        return `${e.start_time}${endStr} — ${sanitizeUntrusted(e.title)}${locStr} [uid:${e.uid}]`
      })
      return { content: lines.join('\n') }
    },
  })
}

// R4: calendar write tools (original positions 11–13)
export function registerCalendarToolsR4(ion: IonSDK): void {
  ion.registerTool({
    name: 'calendar_create_event',
    description: 'Create a calendar event in iCloud via CalDAV.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Event title (summary).' },
        start_time: { type: 'string', description: 'Start date/time in ISO 8601 format (e.g. 2026-05-15T14:00:00), or YYYY-MM-DD for all-day events.' },
        end_time: { type: 'string', description: 'End date/time in ISO 8601 format (e.g. 2026-05-15T15:00:00), or YYYY-MM-DD for all-day events.' },
        notes: { type: 'string', description: 'Optional event notes / description.' },
        location: { type: 'string', description: 'Physical location or meeting URL for the event.' },
        calendar_name: { type: 'string', description: 'Optional calendar name to create in. Defaults to first available.' },
        all_day: { type: 'boolean', description: 'Set to true to create an all-day event. When true, start_time and end_time are inclusive dates (YYYY-MM-DD); a single-day event has start_time == end_time. The iCal DATE value is used and DTEND is computed as end_time + 1 day (exclusive per iCal spec).' },
      },
      required: ['title', 'start_time', 'end_time'],
    },
    execute: async (params) => {
      const result = await createCalendarEvent(
        params['title'] as string,
        params['start_time'] as string,
        params['end_time'] as string,
        (params['notes'] as string | undefined) ?? '',
        (params['calendar_name'] as string | undefined),
        (params['location'] as string | undefined) ?? '',
        (params['all_day'] as boolean | undefined) ?? false,
      )
      return { content: result }
    },
  })

  ion.registerTool({
    name: 'calendar_delete_event',
    description: 'Delete a calendar event from iCloud via CalDAV.',
    parameters: {
      type: 'object',
      properties: {
        uid: { type: 'string', description: 'Event UID (unique identifier) to delete.' },
      },
      required: ['uid'],
    },
    execute: async (params) => {
      const result = await deleteCalendarEvent(params['uid'] as string)
      return { content: result.message, isError: !result.ok }
    },
  })

  ion.registerTool({
    name: 'calendar_update_event',
    description: 'Update an existing calendar event in iCloud via CalDAV. Only supply fields you want to change — omitted fields are preserved from the existing event.',
    parameters: {
      type: 'object',
      properties: {
        uid: { type: 'string', description: 'Event UID (unique identifier) to update.' },
        title: { type: 'string', description: 'Updated event title (summary). Omit to keep existing.' },
        start_time: { type: 'string', description: 'Updated start date/time in ISO 8601 format. Omit to keep existing.' },
        end_time: { type: 'string', description: 'Updated end date/time in ISO 8601 format. Omit to keep existing.' },
        notes: { type: 'string', description: 'Updated event notes / description. Omit to keep existing.' },
        location: { type: 'string', description: 'Updated physical location or meeting URL. Omit to keep existing.' },
      },
      required: ['uid'],
    },
    execute: async (params) => {
      const result = await updateCalendarEvent(
        params['uid'] as string,
        (params['title'] as string | undefined),
        (params['start_time'] as string | undefined),
        (params['end_time'] as string | undefined),
        (params['notes'] as string | undefined),
        (params['location'] as string | undefined),
      )
      return { content: result.message, isError: !result.ok }
    },
  })
}

// R8: CalDAV reminder tools (original positions 24–26)
export function registerCalendarToolsR8(ion: IonSDK): void {
  ion.registerTool({
    name: 'reminder_list',
    description:
      'List reminders from iCloud Reminders via CalDAV. Returns incomplete reminders by default. ' +
      'Use to check what reminders Alex has set, before creating duplicates.',
    parameters: {
      type: 'object',
      properties: {
        list: { type: 'string', description: 'Optional Reminders list name to filter by (substring match).' },
        include_completed: { type: 'boolean', description: 'If true, include completed reminders (default: false).' },
      },
      required: [],
    },
    execute: async (params) => ({
      content: await reminderList(
        (params['list'] as string | undefined) ?? undefined,
        (params['include_completed'] as boolean | undefined) ?? false,
      ),
    }),
  })

  ion.registerTool({
    name: 'reminder_create',
    description:
      'Create a reminder in iCloud Reminders via CalDAV. ' +
      'Use when Alex asks to be reminded about something (non-time-critical). ' +
      'For time-sensitive reminders that need push notification, use create_reminder instead.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Reminder title / description.' },
        list: { type: 'string', description: 'Optional Reminders list name (e.g. "Reminders", "Work"). Defaults to first available list.' },
        due_date: { type: 'string', description: 'Optional due date: YYYY-MM-DD or "YYYY-MM-DD HH:MM" (local Chicago time).' },
      },
      required: ['title'],
    },
    execute: async (params) => ({
      content: await reminderCreate(
        params['title'] as string,
        (params['list'] as string | undefined) ?? undefined,
        (params['due_date'] as string | undefined) ?? undefined,
      ),
    }),
  })

  ion.registerTool({
    name: 'reminder_complete',
    description:
      'Mark a reminder complete in iCloud Reminders via CalDAV. ' +
      'Matches by title substring (case-insensitive) or exact UID.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Title substring or exact UID of the reminder to complete.' },
        list: { type: 'string', description: 'Optional Reminders list name to narrow the search.' },
      },
      required: ['title'],
    },
    execute: async (params) => ({
      content: await reminderComplete(
        params['title'] as string,
        (params['list'] as string | undefined) ?? undefined,
      ),
    }),
  })
}
