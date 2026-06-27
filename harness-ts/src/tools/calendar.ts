// Calendar tool -- reads/writes events via CalDAV (iCloud).
// Credentials: icloud_user + icloud_app_password in macOS Keychain (com.example.jarvis).
// Fallback: ICLOUD_USER + ICLOUD_APP_PASSWORD from ~/.jarvis-mail-creds (legacy).

import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import jsYaml from 'js-yaml'
import { log } from 'ion-sdk'
import { getSecret } from '../secrets'
import { HARNESS_DIR } from '../config'

const CALDAV_BASE = 'https://caldav.icloud.com'

interface Creds { user: string; pass: string }
interface CalInfo { href: string; name: string; displayName?: string }

interface CalendarConfig {
  excludeCalendarNames: string[]
}

let _creds: Creds | null = null
let _calendars: CalInfo[] | null = null
let _calsLastFetch: number = 0
let _calendarConfig: CalendarConfig | null = null

const CALENDAR_CACHE_TTL_MS = 10 * 60 * 1000
const DISCOVERY_DEADLINE_MS = 15_000

// Short-lived cache of the raw upcoming-events fetch. The meeting_prep routine
// (10-min window) and the meetingCountdown proactive trigger (45-min window)
// both poll the calendar every 5 minutes; without this they each fire an
// independent CalDAV query. The cache lets them share one fetch per cycle.
// Reused only while fresh AND the cached horizon covers the requested window;
// invalidated on any create/update/delete so interactive reads stay correct.
type RawCalEvent = { title: string; start: Date; end: Date | null; location: string | null; uid: string; href: string }
const EVENTS_CACHE_TTL_MS = 120_000
const EVENTS_FETCH_LOOKBACK_MS = 4 * 60 * 60 * 1000
// Always cache at least this far ahead so the 10-min and 45-min pollers share a
// single fetch regardless of which fires first.
const EVENTS_MIN_HORIZON_MS = 60 * 60 * 1000
let _eventsCache: { fetchedAt: number; horizonEnd: number; events: RawCalEvent[] } | null = null

function invalidateEventsCache(): void {
  _eventsCache = null
}

// Export for testing only
export function __clearCache(): void {
  _calendars = null
  _creds = null
  _calsLastFetch = 0
  _eventsCache = null
}

function loadCalendarConfig(): CalendarConfig {
  if (_calendarConfig) return _calendarConfig

  try {
    const content = readFileSync(
      join(HARNESS_DIR, 'harness/config/integrations.yaml'),
      'utf8',
    )
    const doc = jsYaml.load(content) as { calendar?: { exclude_calendar_names?: string[] } } | null
    const cal = doc?.calendar ?? {}
    const excludeCalendarNames = Array.isArray(cal.exclude_calendar_names) ? cal.exclude_calendar_names : []
    _calendarConfig = { excludeCalendarNames }
    return _calendarConfig
  } catch {
    _calendarConfig = { excludeCalendarNames: [] }
    return _calendarConfig
  }
}

function loadCreds(): Creds {
  if (_creds) return _creds

  // Try Keychain first.
  const user = getSecret('icloud_user')
  const pass = getSecret('icloud_app_password')
  if (user && pass) {
    _creds = { user, pass }
    return _creds
  }

  // Legacy fallback: ~/.jarvis-mail-creds
  const credsPath = join(homedir(), '.jarvis-mail-creds')
  const credMsg =
    'iCloud credentials unavailable -- calendar events cannot be created.\n' +
    'To restore on the Mini:\n' +
    '  security add-generic-password -U -s com.example.jarvis -a icloud_user -w YOUR_APPLE_ID\n' +
    '  security add-generic-password -U -s com.example.jarvis -a icloud_app_password -w YOUR_APP_PASSWORD\n' +
    'Or recreate ~/.jarvis-mail-creds with ICLOUD_USER= and ICLOUD_APP_PASSWORD= lines.'
  if (!existsSync(credsPath)) throw new Error(credMsg)
  const lines = readFileSync(credsPath, 'utf8').split('\n')
  const kv: Record<string, string> = {}
  for (const ln of lines) {
    const i = ln.indexOf('=')
    if (i > 0) kv[ln.slice(0, i).trim()] = ln.slice(i + 1).trim()
  }
  if (!kv['ICLOUD_USER'] || !kv['ICLOUD_APP_PASSWORD']) {
    throw new Error(credMsg)
  }
  _creds = { user: kv['ICLOUD_USER'], pass: kv['ICLOUD_APP_PASSWORD'] }
  return _creds
}

function authHeader(): string {
  const c = loadCreds()
  return 'Basic ' + Buffer.from(`${c.user}:${c.pass}`).toString('base64')
}

// Strip all CDATA sections from a string, replacing each with its raw content.
// Iterates until no CDATA remains to handle split-CDATA sequences Apple uses
// to escape ']]>' inside element content.
function stripCdata(s: string): string {
  let out = s
  while (out.includes('<![CDATA[')) {
    out = out.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  }
  return out
}

// Namespace-agnostic: matches <ns:tag> or <tag>, returns inner content.
// Strips CDATA wrappers so callers receive plain text regardless of how
// Apple encodes the element content.
function xmlGet(xml: string, localName: string): string | null {
  const re = new RegExp(
    `<[\\w-]*:?${localName}(?:\\s[^>]*)?>([\\s\\S]*?)</[\\w-]*:?${localName}>`,
    'i',
  )
  const raw = re.exec(xml)?.[1]?.trim() ?? null
  return raw != null ? stripCdata(raw).trim() : null
}

function xmlGetAll(xml: string, localName: string): string[] {
  const re = new RegExp(
    `<[\\w-]*:?${localName}(?:\\s[^>]*)?>([\\s\\S]*?)</[\\w-]*:?${localName}>`,
    'gi',
  )
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) out.push(stripCdata((m[1] ?? '').trim()).trim())
  return out
}

function escapeIcalText(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n')
}

const CALDAV_TIMEOUT_MS = 10_000

async function doPropfind(url: string, depth: string, body: string): Promise<string> {
  const r = await fetch(url, {
    method: 'PROPFIND',
    headers: {
      Authorization: authHeader(),
      'Content-Type': 'application/xml; charset=utf-8',
      Depth: depth,
    },
    body,
    signal: AbortSignal.timeout(CALDAV_TIMEOUT_MS),
  })
  if (r.status !== 207 && !r.ok) throw new Error(`PROPFIND ${url} -> ${r.status}`)
  return r.text()
}

export async function discoverCalendars(): Promise<CalInfo[]> {
  if (_calendars && Date.now() - _calsLastFetch <= CALENDAR_CACHE_TTL_MS) {
    return _calendars
  }

  const work = (async () => {
    const xml1 = await doPropfind(
      CALDAV_BASE,
      '0',
      `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>`,
    )
    const principalBlock = xmlGet(xml1, 'current-user-principal') ?? ''
    let principalHref = xmlGet(principalBlock, 'href') ?? ''
    if (!principalHref) throw new Error('caldav: no current-user-principal href')
    if (!principalHref.startsWith('http')) principalHref = CALDAV_BASE + principalHref

    const xml2 = await doPropfind(
      principalHref,
      '0',
      `<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-home-set/></d:prop></d:propfind>`,
    )
    const homeBlock = xmlGet(xml2, 'calendar-home-set') ?? ''
    let homeHref = xmlGet(homeBlock, 'href') ?? ''
    if (!homeHref) throw new Error('caldav: no calendar-home-set href')
    if (!homeHref.startsWith('http')) homeHref = CALDAV_BASE + homeHref

    const xml3 = await doPropfind(
      homeHref,
      '1',
      `<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:displayname/><d:resourcetype/></d:prop></d:propfind>`,
    )
    const cals: CalInfo[] = []
    for (const resp of xmlGetAll(xml3, 'response')) {
      const rt = xmlGet(resp, 'resourcetype') ?? ''
      if (!rt.includes('calendar')) continue
      let href = xmlGet(resp, 'href') ?? ''
      if (!href) continue
      if (!href.startsWith('http')) href = CALDAV_BASE + href
      const displayName = xmlGet(resp, 'displayname') ?? 'Calendar'
      const name = href.split('/').filter(s => s).at(-1) ?? 'calendar'
      cals.push({ href, name, displayName })
    }

    const cfg = loadCalendarConfig()
    const filtered = cals.filter((cal) => {
      const displayLower = (cal.displayName ?? '').toLowerCase()
      const nameLower = cal.name.toLowerCase()
      return !cfg.excludeCalendarNames.some(
        (exc) => displayLower === exc.toLowerCase() || nameLower === exc.toLowerCase()
      )
    })

    _calendars = filtered
    _calsLastFetch = Date.now()
    return filtered
  })()

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('CalDAV discovery timed out after 15s')), DISCOVERY_DEADLINE_MS),
  )
  return Promise.race([work, timeout])
}

function fmtUtc(d: Date): string {
  return d.toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z'
}

function unfold(ical: string): string {
  return ical.replace(/\r?\n[ \t]/g, '')
}

function parseDt(val: string, tzid: string | null = null): Date {
  val = val.trim()
  if (val.includes('T')) {
    const y = +val.slice(0, 4), mo = +val.slice(4, 6) - 1, d = +val.slice(6, 8)
    const h = +val.slice(9, 11), mi = +val.slice(11, 13), s = +val.slice(13, 15)
    if (val.endsWith('Z')) {
      return new Date(Date.UTC(y, mo, d, h, mi, s))
    }
    if (!tzid) {
      return new Date(y, mo, d, h, mi, s)
    }
    // Named timezone: use Intl to resolve the offset at this instant
    const naiveUTC = Date.UTC(y, mo, d, h, mi, s)
    try {
      const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: tzid,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      })
      const parts = Object.fromEntries(
        fmt
          .formatToParts(new Date(naiveUTC))
          .filter(p => p.type !== 'literal')
          .map(p => [p.type, p.value])
      )
      const hour = +String(parts.hour)
      const tzWallUTC = Date.UTC(
        +String(parts.year),
        +String(parts.month) - 1,
        +String(parts.day),
        hour === 24 ? 0 : hour,
        +String(parts.minute),
        +String(parts.second)
      )
      const offset = naiveUTC - tzWallUTC
      return new Date(naiveUTC + offset)
    } catch {
      log.warn('calendar: unrecognized TZID, falling back to local time', { tzid })
      return new Date(y, mo, d, h, mi, s)
    }
  }
  return new Date(+val.slice(0, 4), +val.slice(4, 6) - 1, +val.slice(6, 8))
}

async function fetchEvents(
  start: Date,
  end: Date,
): Promise<Array<{ title: string; start: Date; end: Date | null; location: string | null; uid: string; href: string }>> {
  const cals = await discoverCalendars()
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:getetag/><c:calendar-data/></d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">
        <c:time-range start="${fmtUtc(start)}" end="${fmtUtc(end)}"/>
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`

  const results = await Promise.all(
    cals.map(async cal => {
      try {
        const r = await fetch(cal.href, {
          method: 'REPORT',
          headers: {
            Authorization: authHeader(),
            'Content-Type': 'application/xml; charset=utf-8',
            Depth: '1',
          },
          body,
          signal: AbortSignal.timeout(CALDAV_TIMEOUT_MS),
        })
        return r.status === 207 ? { cal, text: await r.text() } : { cal, text: '' }
      } catch (err) {
        log.warn('calendar: REPORT failed', { calendar: cal.href, err: String(err) })
        return { cal, text: '' }
      }
    })
  )

  const events: Array<{ title: string; start: Date; end: Date | null; location: string | null; uid: string; href: string }> = []
  for (const { cal, text } of results) {
    if (!text) continue
    for (const data of xmlGetAll(text, 'calendar-data')) {
      const unfolded = unfold(data)
      const veRe = /BEGIN:VEVENT([\s\S]*?)END:VEVENT/g
      let m: RegExpExecArray | null
      while ((m = veRe.exec(unfolded)) !== null) {
        const ve = m[1] ?? ''
        const summary = /^SUMMARY:(.+)$/m.exec(ve)?.[1]?.trim() ?? '(No Title)'
        const dtLine = /^DTSTART(;[^:]+)?:(.+)$/m.exec(ve)
        const tzid = dtLine?.[1]?.match(/TZID=([^;]+)/)?.[1] ?? null
        const dtval = dtLine?.[2]?.trim() ?? ''
        const uid = /^UID:(.+)$/m.exec(ve)?.[1]?.trim() ?? ''
        if (!dtval) continue
        const dtEndLine = /^DTEND(;[^:]+)?:(.+)$/m.exec(ve)
        const endTzid = dtEndLine?.[1]?.match(/TZID=([^;]+)/)?.[1] ?? null
        const dtEndVal = dtEndLine?.[2]?.trim() ?? ''
        const eventEnd = dtEndVal ? parseDt(dtEndVal, endTzid) : null
        const locationRaw = /^LOCATION:(.+)$/m.exec(ve)?.[1]?.trim() ?? ''
        const location = locationRaw || null
        const eventHref = cal.href.replace(/\/$/, '') + '/' + encodeURIComponent(uid) + '.ics'
        events.push({ title: summary, start: parseDt(dtval, tzid), end: eventEnd, location, uid, href: eventHref })
      }
    }
  }
  return events
}

export async function getTodayEventsStr(): Promise<string> {
  try {
    const now = new Date()
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
    const events = await fetchEvents(start, end)
    if (!events.length) return 'No events today.'
    const seen = new Set<string>()
    const unique = events
      .sort((a, b) => a.start.getTime() - b.start.getTime())
      .filter(e => {
        // Client-side date guard: Reminders calendar ignores server time-range and
        // returns all past-due recurring occurrences; filter to today only.
        if (e.start < start || e.start >= end) return false
        // Key on local date+time+title so timezone-variant duplicates
        // (same recurring event returned from Family and Family ⚠️ calendars)
        // are always caught regardless of UTC vs local parsing differences.
        const key = `${e.title}|${e.start.getFullYear()}-${e.start.getMonth()}-${e.start.getDate()}|${e.start.getHours()}:${e.start.getMinutes()}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
    return unique
      .map((e) => {
        const timeOpts: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit', hour12: true }
        const startStr = e.start.toLocaleTimeString('en-US', timeOpts)
        const timeStr = e.end
          ? `${startStr}–${e.end.toLocaleTimeString('en-US', timeOpts)}`
          : startStr
        const locStr = e.location ? ` [${e.location}]` : ''
        return `${timeStr} -- ${e.title}${locStr} [uid:${e.uid}]`
      })
      .join('\n')
  } catch (err) {
    return `Calendar error: ${err}`
  }
}

export async function getWeekEventsStr(): Promise<string> {
  try {
    const now = new Date()
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7)
    const events = await fetchEvents(start, end)
    if (!events.length) return 'No events this week.'
    const seen = new Set<string>()
    const unique = events
      .sort((a, b) => a.start.getTime() - b.start.getTime())
      .filter(e => {
        // Client-side date guard: Reminders calendar ignores server time-range.
        if (e.start < start || e.start >= end) return false
        const key = `${e.title}|${e.start.getFullYear()}-${e.start.getMonth()}-${e.start.getDate()}|${e.start.getHours()}:${e.start.getMinutes()}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
    return unique
      .map((e) => {
        const dateStr = e.start.toLocaleDateString('en-US', {
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric',
        })
        const timeOpts: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit', hour12: true }
        const startStr = e.start.toLocaleTimeString('en-US', timeOpts)
        const timeStr = e.end
          ? `${startStr}–${e.end.toLocaleTimeString('en-US', timeOpts)}`
          : startStr
        const locStr = e.location ? ` [${e.location}]` : ''
        return `${dateStr} ${timeStr} -- ${e.title}${locStr} [uid:${e.uid}]`
      })
      .join('\n')
  } catch (err) {
    return `Calendar error: ${err}`
  }
}

function fmtDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}${m}${day}`
}

function addOneDay(d: Date): Date {
  // Use local y/m/d components so month/year boundaries normalise correctly.
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)
}

function buildEventIcal(
  uid: string,
  title: string,
  start: Date,
  end: Date,
  notes = '',
  location = '',
  allDay = false,
): string {
  const dtStart = allDay
    ? `DTSTART;VALUE=DATE:${fmtDate(start)}`
    : `DTSTART:${fmtUtc(start)}`
  const dtEnd = allDay
    ? (() => {
        // iCal all-day DTEND is exclusive; the user passes inclusive end.
        // Guard: if end < start (or missing), fall back to start so a single-day
        // event still produces DTEND = start+1 (one day).
        const allDayEnd = end >= start ? end : start
        return `DTEND;VALUE=DATE:${fmtDate(addOneDay(allDayEnd))}`
      })()
    : `DTEND:${fmtUtc(end)}`
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Jarvis//EN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${fmtUtc(new Date())}`,
    dtStart,
    dtEnd,
    `SUMMARY:${escapeIcalText(title)}`,
  ]
  if (notes) lines.push(`DESCRIPTION:${escapeIcalText(notes)}`)
  if (location) lines.push(`LOCATION:${escapeIcalText(location)}`)
  lines.push('END:VEVENT', 'END:VCALENDAR')
  return lines.join('\r\n') + '\r\n'
}

function parseExistingVEvent(text: string): string | null {
  const match = /BEGIN:VEVENT([\s\S]*?)END:VEVENT/i.exec(text)
  if (!match) return null
  return 'BEGIN:VEVENT' + match[1] + 'END:VEVENT'
}

function mutateVEventLine(vevent: string, propertyName: string, newLine: string): string {
  const lineRegex = new RegExp(`^${propertyName}(;[^:]*)?:.*$`, 'm')
  if (lineRegex.test(vevent)) {
    return vevent.replace(lineRegex, newLine)
  }
  const endMatch = /END:VEVENT/.exec(vevent)
  if (!endMatch) return vevent
  const before = vevent.slice(0, endMatch.index)
  return before + newLine + '\r\n' + vevent.slice(endMatch.index)
}

/** Parse an ISO date/datetime string, treating bare YYYY-MM-DD as local midnight. */
function parseLocalDate(iso: string): Date {
  // Bare date (no T) would otherwise parse as UTC 00:00Z, landing on the previous
  // calendar day in negative UTC-offset timezones (CDT, PST, etc.).
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    const [y, m, d] = iso.split('-').map(Number)
    return new Date(y!, m! - 1, d)
  }
  return new Date(iso)
}

export async function createCalendarEvent(
  title: string,
  startIso: string,
  endIso: string,
  notes = '',
  calendarName?: string,
  location = '',
  allDay = false,
): Promise<string> {
  try {
    const start = parseLocalDate(startIso)
    const end = parseLocalDate(endIso)
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return `Error: invalid ISO date: start=${startIso}, end=${endIso}`
    }
    const cals = await discoverCalendars()
    if (!cals.length) return 'Error: no calendars found'

    const uid = randomUUID()
    const ical = buildEventIcal(uid, title, start, end, notes, location, allDay)

    let targetCals = cals
    if (calendarName) {
      const matched = cals.find(
        c =>
          c.displayName?.toLowerCase() === calendarName.toLowerCase() ||
          c.name.toLowerCase() === calendarName.toLowerCase()
      )
      if (matched) {
        targetCals = [matched]
      } else {
        log.info('calendar: calendar name not found, trying all calendars', { calendarName })
      }
    }

    for (const cal of targetCals) {
      const eventUrl = cal.href.replace(/\/$/, '') + '/' + uid + '.ics'
      try {
        const r = await fetch(eventUrl, {
          method: 'PUT',
          headers: {
            Authorization: authHeader(),
            'Content-Type': 'text/calendar; charset=utf-8',
          },
          body: ical,
          signal: AbortSignal.timeout(CALDAV_TIMEOUT_MS),
        })
        if (r.ok) { invalidateEventsCache(); return `Event created in ${cal.displayName ?? cal.name}: ${title} (${startIso} - ${endIso})` }
        if (r.status === 401) return (
          'Calendar authentication failed (HTTP 401). ' +
          'iCloud credentials may be stale -- update with:\n' +
          '  security add-generic-password -U -s com.example.jarvis -a icloud_user -w YOUR_APPLE_ID\n' +
          '  security add-generic-password -U -s com.example.jarvis -a icloud_app_password -w YOUR_APP_PASSWORD'
        )
        if (r.status === 403 || r.status === 409 || r.status >= 500) continue
        return `Error creating event: HTTP ${r.status}`
      } catch (err) {
        log.warn('calendar: PUT failed', { eventUrl, err: String(err) })
        continue
      }
    }
    return `Error: could not create event in any calendar (tried ${targetCals.length})`
  } catch (err) {
    return `Calendar error: ${err}`
  }
}

export async function deleteCalendarEvent(uid: string): Promise<{ ok: boolean; message: string }> {
  try {
    const cals = await discoverCalendars()
    for (const cal of cals) {
      const eventUrl = cal.href.replace(/\/$/, '') + '/' + encodeURIComponent(uid) + '.ics'
      try {
        const r = await fetch(eventUrl, {
          method: 'DELETE',
          headers: { Authorization: authHeader() },
          signal: AbortSignal.timeout(CALDAV_TIMEOUT_MS),
        })
        if (r.status === 204) {
          invalidateEventsCache()
          return { ok: true, message: `Deleted ${uid} from ${cal.href}` }
        }
        if (r.status === 404) continue
        log.warn('calendar: DELETE unexpected status', { eventUrl, status: r.status })
      } catch (err) {
        log.warn('calendar: DELETE failed', { eventUrl, err: String(err) })
      }
    }
    return { ok: false, message: `Event ${uid} not found in any calendar` }
  } catch (err) {
    return { ok: false, message: `Calendar error: ${err}` }
  }
}

export async function updateCalendarEvent(
  uid: string,
  title?: string,
  startIso?: string,
  endIso?: string,
  notes?: string,
  location?: string,
): Promise<{ ok: boolean; message: string }> {
  try {
    let start: Date | undefined
    let end: Date | undefined
    if (startIso !== undefined) {
      start = parseLocalDate(startIso)
      if (isNaN(start.getTime())) {
        return { ok: false, message: `Invalid ISO date: start=${startIso}` }
      }
    }
    if (endIso !== undefined) {
      end = parseLocalDate(endIso)
      if (isNaN(end.getTime())) {
        return { ok: false, message: `Invalid ISO date: end=${endIso}` }
      }
    }
    const cals = await discoverCalendars()

    for (const cal of cals) {
      const eventUrl = cal.href.replace(/\/$/, '') + '/' + encodeURIComponent(uid) + '.ics'
      let existingVEvent: string | null = null

      // Fetch existing event
      try {
        const getRes = await fetch(eventUrl, {
          method: 'GET',
          headers: { Authorization: authHeader() },
          signal: AbortSignal.timeout(CALDAV_TIMEOUT_MS),
        })
        if (getRes.ok) {
          const existing = await getRes.text()
          existingVEvent = parseExistingVEvent(existing)
        }
        // If 404, existingVEvent stays null and we fall through to fallback iCal
      } catch (err) {
        log.warn('calendar: GET existing event failed, trying fallback', { eventUrl, err: String(err) })
      }

      let ical: string
      if (existingVEvent) {
        // Detect all-day from the existing event.
        // VALUE=DATE-TIME is a superset string, so anchor the match at the colon or semicolon
        // to avoid a false positive (e.g. VALUE=DATE-TIME must NOT match).
        const isAllDay = /^DTSTART[^\r\n]*;VALUE=DATE(?=[:;])/im.test(existingVEvent)

        // Merge-PUT: preserve RRULE, VALARM, ATTENDEE, etc.
        let merged = existingVEvent
        merged = mutateVEventLine(merged, 'DTSTAMP', `DTSTAMP:${fmtUtc(new Date())}`)
        if (start !== undefined) {
          const dtStartLine = isAllDay
            ? `DTSTART;VALUE=DATE:${fmtDate(start)}`
            : `DTSTART:${fmtUtc(start)}`
          merged = mutateVEventLine(merged, 'DTSTART', dtStartLine)
        }
        if (end !== undefined) {
          const dtEndLine = isAllDay
            ? `DTEND;VALUE=DATE:${fmtDate(addOneDay(end))}`
            : `DTEND:${fmtUtc(end)}`
          merged = mutateVEventLine(merged, 'DTEND', dtEndLine)
        }
        if (title !== undefined) {
          merged = mutateVEventLine(merged, 'SUMMARY', `SUMMARY:${escapeIcalText(title)}`)
        }
        if (notes !== undefined) {
          merged = mutateVEventLine(merged, 'DESCRIPTION', `DESCRIPTION:${escapeIcalText(notes)}`)
        }
        if (location !== undefined) {
          merged = mutateVEventLine(merged, 'LOCATION', `LOCATION:${escapeIcalText(location)}`)
        }
        // Bump SEQUENCE
        const seqMatch = /^SEQUENCE:(\d+)$/m.exec(merged)
        const newSeq = seqMatch ? String(Number(seqMatch[1]!) + 1) : '1'
        if (seqMatch) {
          merged = merged.replace(/^SEQUENCE:\d+$/m, `SEQUENCE:${newSeq}`)
        } else {
          merged = mutateVEventLine(merged, 'SEQUENCE', `SEQUENCE:${newSeq}`)
        }
        ical = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Jarvis//EN\r\n${merged}\r\nEND:VCALENDAR\r\n`
      } else {
        // Fallback: can only rebuild if all required fields are present.
        if (title === undefined || start === undefined || end === undefined) {
          return {
            ok: false,
            message: `Event ${uid} not found and title/start_time/end_time are required to create it from scratch`,
          }
        }
        log.warn('calendar: updateCalendarEvent: could not fetch existing event, falling back to minimal iCal overwrite', { uid })
        ical = buildEventIcal(uid, title, start, end, notes ?? '', location ?? '')
      }

      try {
        const r = await fetch(eventUrl, {
          method: 'PUT',
          headers: {
            Authorization: authHeader(),
            'Content-Type': 'text/calendar; charset=utf-8',
            'If-Match': '*',
          },
          body: ical,
          signal: AbortSignal.timeout(CALDAV_TIMEOUT_MS),
        })
        if (r.status === 204 || r.status === 201) {
          invalidateEventsCache()
          return { ok: true, message: `Updated ${uid}` }
        }
        if (r.status === 404) continue
        log.warn('calendar: PUT unexpected status', { eventUrl, status: r.status })
      } catch (err) {
        log.warn('calendar: PUT failed', { eventUrl, err: String(err) })
      }
    }
    return { ok: false, message: `Event ${uid} not found in any calendar` }
  } catch (err) {
    return { ok: false, message: `Calendar error: ${err}` }
  }
}

// Returns raw upcoming events from the shared short-TTL cache, fetching from
// CalDAV only when the cache is stale or its horizon does not cover `windowEnd`.
// Always fetches from 4h ago so in-progress meetings are included, and extends
// the horizon to at least EVENTS_MIN_HORIZON_MS so concurrent pollers share it.
async function fetchUpcomingCached(now: Date, windowEnd: Date): Promise<RawCalEvent[]> {
  const cached = _eventsCache
  if (
    cached &&
    now.getTime() - cached.fetchedAt < EVENTS_CACHE_TTL_MS &&
    cached.horizonEnd >= windowEnd.getTime()
  ) {
    return cached.events
  }
  const horizonEnd = new Date(Math.max(windowEnd.getTime(), now.getTime() + EVENTS_MIN_HORIZON_MS))
  const fetchStart = new Date(now.getTime() - EVENTS_FETCH_LOOKBACK_MS)
  const events = await fetchEvents(fetchStart, horizonEnd)
  _eventsCache = { fetchedAt: now.getTime(), horizonEnd: horizonEnd.getTime(), events }
  return events
}

export async function getUpcomingEvents(
  windowMinutes: number,
): Promise<Array<{ title: string; start_time: string; end_time: string | null; location: string | null; uid: string }>> {
  try {
    const now = new Date()
    const end = new Date(now.getTime() + windowMinutes * 60000)
    const events = await fetchUpcomingCached(now, end)
    const seen = new Set<string>()
    return events
      // Cache may span a wider horizon than this caller's window, so bound by
      // `end` here. Keep in-progress meetings (start in the past, end ahead).
      .filter((e) => (e.end === null || e.end > now) && e.start <= end)
      .sort((a, b) => a.start.getTime() - b.start.getTime())
      .map((e) => ({
        title: e.title,
        start_time: e.start.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }),
        end_time: e.end ? e.end.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }) : null,
        location: e.location,
        uid: e.uid,
      }))
      .filter((e) => {
        const key = `${e.title}|${e.start_time}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
  } catch (err) {
    log.warn('calendar: getUpcomingEvents error', { err: String(err) })
    return []
  }
}
