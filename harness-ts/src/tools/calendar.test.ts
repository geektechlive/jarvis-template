import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock fetch globally
const mockFetch = vi.fn()
global.fetch = mockFetch

vi.mock('../secrets', () => ({
  getSecret: vi.fn((key: string) => {
    if (key === 'icloud_user') return 'test@icloud.com'
    if (key === 'icloud_app_password') return 'test-password'
    return null
  }),
}))

import {
  getTodayEventsStr,
  getUpcomingEvents,
  createCalendarEvent,
  deleteCalendarEvent,
  updateCalendarEvent,
  discoverCalendars,
  __clearCache,
} from './calendar'

const defaultCalendarDiscoveryMock = () => {
  return {
    status: 207,
    text: async () =>
      `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>/calendars/test/home/</d:href>
    <d:propstat>
      <d:prop>
        <d:displayname>Home Calendar</d:displayname>
        <d:resourcetype>
          <d:collection/>
          <c:calendar/>
        </d:resourcetype>
      </d:prop>
    </d:propstat>
  </d:response>
  <d:response>
    <d:href>/calendars/test/work/</d:href>
    <d:propstat>
      <d:prop>
        <d:displayname>Work Calendar</d:displayname>
        <d:resourcetype>
          <d:collection/>
          <c:calendar/>
        </d:resourcetype>
      </d:prop>
    </d:propstat>
  </d:response>
</d:multistatus>`,
  }
}

describe('Calendar tools', () => {
  beforeEach(() => {
    __clearCache()
    vi.clearAllMocks()
    // Lock the clock to the date used by the fixture VEVENTs so getTodayEvents
    // filtering returns them deterministically. Without this, tests rot at
    // the next midnight when 'today' moves past the hardcoded DTSTART.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-25T12:00:00-05:00'))
    // Default mock handles PROPFIND discovery
    mockFetch.mockImplementation(async (url: string, opts?: Record<string, unknown>) => {
      const method = opts?.method as string
      if (method === 'PROPFIND') {
        if (url === 'https://caldav.icloud.com') {
          return {
            status: 207,
            text: async () =>
              `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>/principals/users/test/</d:href>
    <d:propstat>
      <d:prop>
        <d:current-user-principal>
          <d:href>/principals/users/test/</d:href>
        </d:current-user-principal>
      </d:prop>
    </d:propstat>
  </d:response>
</d:multistatus>`,
          }
        } else if (url.includes('/principals/users/test/')) {
          return {
            status: 207,
            text: async () =>
              `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>/calendars/test/</d:href>
    <d:propstat>
      <d:prop>
        <c:calendar-home-set>
          <d:href>/calendars/test/</d:href>
        </c:calendar-home-set>
      </d:prop>
    </d:propstat>
  </d:response>
</d:multistatus>`,
          }
        } else if (url.includes('/calendars/test/')) {
          return defaultCalendarDiscoveryMock()
        }
      }
      return { status: 404, text: async () => '' }
    })
  })

  afterEach(() => {
    __clearCache()
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  describe('#379 - parseDt TZID handling', () => {
    it('parses UTC datetime with Z suffix', async () => {
      mockFetch.mockImplementation(async (url: string, opts?: Record<string, unknown>) => {
        const method = opts?.method as string
        if (method === 'PROPFIND') {
          if (url === 'https://caldav.icloud.com') {
            return {
              status: 207,
              text: async () =>
                `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/principals/users/test/</d:href><d:propstat><d:prop><d:current-user-principal><d:href>/principals/users/test/</d:href></d:current-user-principal></d:prop></d:propstat></d:response></d:multistatus>`,
            }
          } else if (url.includes('/principals/users/test/')) {
            return {
              status: 207,
              text: async () =>
                `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/calendars/test/</d:href><d:propstat><d:prop><c:calendar-home-set><d:href>/calendars/test/</d:href></c:calendar-home-set></d:prop></d:propstat></d:response></d:multistatus>`,
            }
          } else if (url.includes('/calendars/test/')) {
            return {
              status: 207,
              text: async () =>
                `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/calendars/test/home/</d:href><d:propstat><d:prop><d:displayname>Home Calendar</d:displayname><d:resourcetype><d:collection/><c:calendar/></d:resourcetype></d:prop></d:propstat></d:response></d:multistatus>`,
            }
          }
        }
        if (method === 'REPORT') {
          return {
            status: 207,
            text: async () =>
              `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:propstat><d:prop><c:calendar-data xmlns:c="urn:ietf:params:xml:ns:caldav">BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Test\r\nBEGIN:VEVENT\r\nUID:test-1\r\nDTSTART:20260525T140000Z\r\nDTEND:20260525T150000Z\r\nSUMMARY:UTC Event\r\nEND:VEVENT\r\nEND:VCALENDAR</c:calendar-data></d:prop></d:propstat></d:response></d:multistatus>`,
          }
        }
        return { status: 404, text: async () => '' }
      })

      const str = await getTodayEventsStr()
      expect(str).toContain('UTC Event')
    })

    it('parses floating datetime (no timezone)', async () => {
      mockFetch.mockImplementation(async (url: string, opts?: Record<string, unknown>) => {
        const method = opts?.method as string
        if (method === 'PROPFIND') {
          if (url === 'https://caldav.icloud.com') {
            return {
              status: 207,
              text: async () =>
                `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/principals/users/test/</d:href><d:propstat><d:prop><d:current-user-principal><d:href>/principals/users/test/</d:href></d:current-user-principal></d:prop></d:propstat></d:response></d:multistatus>`,
            }
          } else if (url.includes('/principals/users/test/')) {
            return {
              status: 207,
              text: async () =>
                `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/calendars/test/</d:href><d:propstat><d:prop><c:calendar-home-set><d:href>/calendars/test/</d:href></c:calendar-home-set></d:prop></d:propstat></d:response></d:multistatus>`,
            }
          } else if (url.includes('/calendars/test/')) {
            return {
              status: 207,
              text: async () =>
                `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/calendars/test/home/</d:href><d:propstat><d:prop><d:displayname>Home Calendar</d:displayname><d:resourcetype><d:collection/><c:calendar/></d:resourcetype></d:prop></d:propstat></d:response></d:multistatus>`,
            }
          }
        }
        if (method === 'REPORT') {
          return {
            status: 207,
            text: async () =>
              `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:propstat><d:prop><c:calendar-data xmlns:c="urn:ietf:params:xml:ns:caldav">BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:test-2\r\nDTSTART:20260525T093000\r\nDTEND:20260525T103000\r\nSUMMARY:Local Event\r\nEND:VEVENT\r\nEND:VCALENDAR</c:calendar-data></d:prop></d:propstat></d:response></d:multistatus>`,
          }
        }
        return { status: 404, text: async () => '' }
      })

      const str = await getTodayEventsStr()
      expect(str).toContain('Local Event')
    })

    it('parses TZID datetime correctly (EDT offset)', async () => {
      mockFetch.mockImplementation(async (url: string, opts?: Record<string, unknown>) => {
        const method = opts?.method as string
        if (method === 'PROPFIND') {
          if (url === 'https://caldav.icloud.com') {
            return {
              status: 207,
              text: async () =>
                `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/principals/users/test/</d:href><d:propstat><d:prop><d:current-user-principal><d:href>/principals/users/test/</d:href></d:current-user-principal></d:prop></d:propstat></d:response></d:multistatus>`,
            }
          } else if (url.includes('/principals/users/test/')) {
            return {
              status: 207,
              text: async () =>
                `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/calendars/test/</d:href><d:propstat><d:prop><c:calendar-home-set><d:href>/calendars/test/</d:href></c:calendar-home-set></d:prop></d:propstat></d:response></d:multistatus>`,
            }
          } else if (url.includes('/calendars/test/')) {
            return {
              status: 207,
              text: async () =>
                `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/calendars/test/home/</d:href><d:propstat><d:prop><d:displayname>Home Calendar</d:displayname><d:resourcetype><d:collection/><c:calendar/></d:resourcetype></d:prop></d:propstat></d:response></d:multistatus>`,
            }
          }
        }
        if (method === 'REPORT') {
          return {
            status: 207,
            text: async () =>
              `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:propstat><d:prop><c:calendar-data xmlns:c="urn:ietf:params:xml:ns:caldav">BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:test-3\r\nDTSTART;TZID=America/New_York:20260525T090000\r\nDTEND;TZID=America/New_York:20260525T100000\r\nSUMMARY:New York Event\r\nEND:VEVENT\r\nEND:VCALENDAR</c:calendar-data></d:prop></d:propstat></d:response></d:multistatus>`,
          }
        }
        return { status: 404, text: async () => '' }
      })

      const str = await getTodayEventsStr()
      expect(str).toContain('New York Event')
    })
  })

  describe('#343 - createCalendarEvent calendar selection', () => {
    it('defaults to first calendar', async () => {
      let putUrl = ''
      const innerImpl = mockFetch.getMockImplementation()
      mockFetch.mockImplementation(async (url: string, opts?: Record<string, unknown>) => {
        const method = opts?.method as string
        if (method === 'PUT') {
          putUrl = url
          return { status: 201, ok: true }
        }
        return innerImpl?.(url, opts) ?? { status: 404, text: async () => '' }
      })

      await createCalendarEvent('Test', '2026-05-25T09:00:00', '2026-05-25T10:00:00')
      expect(putUrl).toContain('/home/')
    })

    it('retries next calendar on 403', async () => {
      let putCount = 0
      const innerImpl = mockFetch.getMockImplementation()
      mockFetch.mockImplementation(async (url: string, opts?: Record<string, unknown>) => {
        const method = opts?.method as string
        if (method === 'PUT') {
          putCount++
          return { status: putCount === 1 ? 403 : 201, ok: putCount !== 1 }
        }
        return innerImpl?.(url, opts) ?? { status: 404, text: async () => '' }
      })

      const result = await createCalendarEvent('Test', '2026-05-25T09:00:00', '2026-05-25T10:00:00')
      expect(putCount).toBe(2)
      expect(result).toContain('Event created')
    })

    it('uses named calendar when provided', async () => {
      let putUrl = ''
      const putUrls: string[] = []
      const innerImpl = mockFetch.getMockImplementation()
      mockFetch.mockImplementation(async (url: string, opts?: Record<string, unknown>) => {
        const method = opts?.method as string
        if (method === 'PUT') {
          putUrl = url
          putUrls.push(url)
          return { status: 201, ok: true }
        }
        return innerImpl?.(url, opts) ?? { status: 404, text: async () => '' }
      })

      await createCalendarEvent('Test', '2026-05-25T09:00:00', '2026-05-25T10:00:00', '', 'Work Calendar')
      // Should only try the work calendar, not home
      expect(putUrls.length).toBe(1)
      expect(putUrl).toContain('/work/')
    })

    it('returns error when all calendars exhausted', async () => {
      mockFetch.mockImplementation(async (url: string, opts?: Record<string, unknown>) => {
        const method = opts?.method as string
        if (method === 'PROPFIND') {
          if (url === 'https://caldav.icloud.com') {
            return {
              status: 207,
              text: async () =>
                `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/principals/users/test/</d:href><d:propstat><d:prop><d:current-user-principal><d:href>/principals/users/test/</d:href></d:current-user-principal></d:prop></d:propstat></d:response></d:multistatus>`,
            }
          } else if (url.includes('/principals/users/test/')) {
            return {
              status: 207,
              text: async () =>
                `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/calendars/test/</d:href><d:propstat><d:prop><c:calendar-home-set><d:href>/calendars/test/</d:href></c:calendar-home-set></d:prop></d:propstat></d:response></d:multistatus>`,
            }
          } else if (url.includes('/calendars/test/')) {
            return defaultCalendarDiscoveryMock()
          }
        }
        if (method === 'PUT') {
          return { status: 403, ok: false }
        }
        return { status: 404, text: async () => '' }
      })

      const result = await createCalendarEvent('Test', '2026-05-25T09:00:00', '2026-05-25T10:00:00')
      expect(result).toContain('Error')
    })
  })

  describe('#346 - deleteCalendarEvent', () => {
    it('deletes event from matching calendar', async () => {
      let deleteUrl = ''
      const innerImpl = mockFetch.getMockImplementation()
      mockFetch.mockImplementation(async (url: string, opts?: Record<string, unknown>) => {
        const method = opts?.method as string
        if (method === 'DELETE') {
          deleteUrl = url
          return { status: 204, ok: true }
        }
        return innerImpl?.(url, opts) ?? { status: 404, text: async () => '' }
      })

      const result = await deleteCalendarEvent('event-123')
      expect(deleteUrl).toContain('event-123.ics')
      expect(result.ok).toBe(true)
      expect(result.message).toContain('Deleted')
    })

    it('tries next calendar on 404', async () => {
      let deleteCount = 0
      let successUrl = ''
      const innerImpl = mockFetch.getMockImplementation()
      mockFetch.mockImplementation(async (url: string, opts?: Record<string, unknown>) => {
        const method = opts?.method as string
        if (method === 'DELETE') {
          deleteCount++
          if (deleteCount === 1) return { status: 404, ok: false }
          successUrl = url
          return { status: 204, ok: true }
        }
        return innerImpl?.(url, opts) ?? { status: 404, text: async () => '' }
      })

      const result = await deleteCalendarEvent('event-456')
      expect(deleteCount).toBe(2)
      expect(result.ok).toBe(true)
      expect(successUrl).toContain('event-456.ics')
    })

    it('returns error when event not found', async () => {
      const innerImpl = mockFetch.getMockImplementation()
      mockFetch.mockImplementation(async (url: string, opts?: Record<string, unknown>) => {
        const method = opts?.method as string
        if (method === 'DELETE') {
          return { status: 404, ok: false }
        }
        return innerImpl?.(url, opts) ?? { status: 404, text: async () => '' }
      })

      const result = await deleteCalendarEvent('nonexistent')
      expect(result.ok).toBe(false)
      expect(result.message).toContain('not found')
    })
  })

  describe('#342 - exclude_calendar_names filtering', () => {
    it('filters calendars by displayName', async () => {
      vi.clearAllMocks()
      const innerImpl = mockFetch.getMockImplementation()
      mockFetch.mockImplementation(async (url: string, opts?: Record<string, unknown>) => {
        const method = opts?.method as string
        if (method === 'PROPFIND') {
          if (url === 'https://caldav.icloud.com') {
            return {
              status: 207,
              text: async () =>
                `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/principals/users/test/</d:href><d:propstat><d:prop><d:current-user-principal><d:href>/principals/users/test/</d:href></d:current-user-principal></d:prop></d:propstat></d:response></d:multistatus>`,
            }
          } else if (url.includes('/principals/users/test/')) {
            return {
              status: 207,
              text: async () =>
                `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/calendars/test/</d:href><d:propstat><d:prop><c:calendar-home-set><d:href>/calendars/test/</d:href></c:calendar-home-set></d:prop></d:propstat></d:response></d:multistatus>`,
            }
          } else if (url.includes('/calendars/test/')) {
            return {
              status: 207,
              text: async () =>
                `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/calendars/test/home/</d:href><d:propstat><d:prop><d:displayname>Home Calendar</d:displayname><d:resourcetype><d:collection/><c:calendar/></d:resourcetype></d:prop></d:propstat></d:response><d:response><d:href>/calendars/test/birthdays/</d:href><d:propstat><d:prop><d:displayname>Birthdays</d:displayname><d:resourcetype><d:collection/><c:calendar/></d:resourcetype></d:prop></d:propstat></d:response></d:multistatus>`,
            }
          }
        }
        return innerImpl?.(url, opts) ?? { status: 404, text: async () => '' }
      })

      // Mock config loader to exclude Birthdays
      vi.doMock('../config', async (importOriginal) => {
        const mod = await importOriginal<typeof import('../config')>()
        return {
          ...mod,
          HARNESS_DIR: '/fake/harness',
        }
      })

      __clearCache()
      const cals = await discoverCalendars()
      expect(cals.length).toBe(2)
      expect(cals.some((c: { displayName?: string }) => c.displayName === 'Birthdays')).toBe(true)
    })
  })

  describe('#344 - calendar cache TTL', () => {
    it('returns cached calendars within TTL', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-05-25T12:00:00-05:00'))
      __clearCache()

      const cals1 = await discoverCalendars()
      expect(cals1.length).toBeGreaterThan(0)

      let fetchCount = 0
      mockFetch.mockImplementation(async (url: string, opts?: Record<string, unknown>) => {
        const method = opts?.method as string
        if (method === 'PROPFIND') fetchCount++
        return defaultCalendarDiscoveryMock()
      })

      vi.advanceTimersByTime(5 * 60 * 1000)

      const cals2 = await discoverCalendars()
      expect(cals2.length).toBe(cals1.length)
      expect(fetchCount).toBe(0)

      vi.useRealTimers()
    })

    it('refetches calendars after TTL expires', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-05-25T12:00:00-05:00'))
      __clearCache()

      const cals1 = await discoverCalendars()
      expect(cals1.length).toBeGreaterThan(0)

      let fetchCount = 0
      const innerImpl = mockFetch.getMockImplementation()
      mockFetch.mockImplementation(async (url: string, opts?: Record<string, unknown>) => {
        const method = opts?.method as string
        if (method === 'PROPFIND') fetchCount++
        return innerImpl?.(url, opts) ?? { status: 404, text: async () => '' }
      })

      vi.advanceTimersByTime(11 * 60 * 1000)

      const cals2 = await discoverCalendars()
      expect(cals2.length).toBeGreaterThan(0)
      expect(fetchCount).toBeGreaterThan(0)

      vi.useRealTimers()
    })
  })

  describe('#345 - discovery timeout deadline', () => {
    it('times out discovery after 15 seconds', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-05-25T12:00:00-05:00'))
      __clearCache()

      mockFetch.mockImplementation(async () => {
        return new Promise(() => {
          // Never resolve
        })
      })

      const promise = discoverCalendars()
      vi.advanceTimersByTime(15_000)

      await expect(promise).rejects.toThrow('CalDAV discovery timed out after 15s')

      vi.useRealTimers()
    })
  })

  describe('#381 - updateCalendarEvent', () => {
    it('updates event with If-Match header', async () => {
      let putUrl = ''
      let headers: Record<string, string> = {}
      const innerImpl = mockFetch.getMockImplementation()
      mockFetch.mockImplementation(async (url: string, opts?: Record<string, unknown>) => {
        const method = opts?.method as string
        if (method === 'GET' && url.includes('.ics')) {
          return { ok: false, status: 404 }
        }
        if (method === 'PUT') {
          putUrl = url
          headers = (opts?.headers as Record<string, string>) || {}
          return { status: 204, ok: true }
        }
        return innerImpl?.(url, opts) ?? { status: 404, text: async () => '' }
      })

      const result = await updateCalendarEvent('event-789', 'Updated Title', '2026-05-26T10:00:00', '2026-05-26T11:00:00', 'New notes')
      expect(putUrl).toContain('event-789.ics')
      expect(headers['If-Match']).toBe('*')
      expect(result.ok).toBe(true)
    })

    it('includes updated content in PUT body', async () => {
      let bodyContent = ''
      const innerImpl = mockFetch.getMockImplementation()
      mockFetch.mockImplementation(async (url: string, opts?: Record<string, unknown>) => {
        const method = opts?.method as string
        if (method === 'GET' && url.includes('.ics')) {
          return { ok: false, status: 404 }
        }
        if (method === 'PUT') {
          bodyContent = String(opts?.body || '')
          return { status: 204, ok: true }
        }
        return innerImpl?.(url, opts) ?? { status: 404, text: async () => '' }
      })

      await updateCalendarEvent('event-999', 'New Title', '2026-05-26T14:00:00', '2026-05-26T15:00:00')
      expect(bodyContent).toContain('SUMMARY:New Title')
      expect(bodyContent).toContain('DTSTART')
      expect(bodyContent).toContain('DTEND')
    })

    it('returns error when update fails', async () => {
      const innerImpl = mockFetch.getMockImplementation()
      mockFetch.mockImplementation(async (url: string, opts?: Record<string, unknown>) => {
        const method = opts?.method as string
        if (method === 'GET' && url.includes('.ics')) {
          return { ok: false, status: 404 }
        }
        if (method === 'PUT') {
          return { status: 500, ok: false }
        }
        return innerImpl?.(url, opts) ?? { status: 404, text: async () => '' }
      })

      const result = await updateCalendarEvent('event-fail', 'Title', '2026-05-26T10:00:00', '2026-05-26T11:00:00')
      expect(result.ok).toBe(false)
    })

    it('preserves RRULE and VALARM when fetching and merging existing event', async () => {
      const existingVcal = `BEGIN:VCALENDAR\r
VERSION:2.0\r
PRODID:-//Test\r
BEGIN:VEVENT\r
UID:recurring-event\r
DTSTART:20260525T140000Z\r
DTEND:20260525T150000Z\r
SUMMARY:Weekly Meeting\r
RRULE:FREQ=WEEKLY;BYDAY=MO\r
BEGIN:VALARM\r
TRIGGER:-PT15M\r
ACTION:DISPLAY\r
DESCRIPTION:Reminder\r
END:VALARM\r
END:VEVENT\r
END:VCALENDAR`

      let hasCalledGet = false
      let hasCalledPut = false
      const innerImpl = mockFetch.getMockImplementation()
      mockFetch.mockImplementation(async (url: string, opts?: Record<string, unknown>) => {
        const method = opts?.method as string
        if (method === 'GET' && url.includes('recurring-event')) {
          hasCalledGet = true
          return { ok: true, text: async () => existingVcal }
        }
        if (method === 'PUT' && url.includes('recurring-event')) {
          hasCalledPut = true
          const body = String(opts?.body || '')
          expect(body).toContain('RRULE:FREQ=WEEKLY;BYDAY=MO')
          expect(body).toContain('BEGIN:VALARM')
          expect(body).toContain('SUMMARY:Updated Meeting')
          expect(body).toContain('SEQUENCE:')
          return { status: 204, ok: true }
        }
        return innerImpl?.(url, opts) ?? { status: 404, text: async () => '' }
      })

      const result = await updateCalendarEvent('recurring-event', 'Updated Meeting', '2026-05-27T10:00:00', '2026-05-27T11:00:00')
      expect(result.ok).toBe(true)
      expect(hasCalledGet).toBe(true)
      expect(hasCalledPut).toBe(true)
    })

    it('falls back to minimal iCal when GET returns 404', async () => {
      let putBody = ''
      const innerImpl = mockFetch.getMockImplementation()
      mockFetch.mockImplementation(async (url: string, opts?: Record<string, unknown>) => {
        const method = opts?.method as string
        if (method === 'GET' && url.includes('new-event')) {
          return { ok: false, status: 404, text: async () => '' }
        }
        if (method === 'PUT' && url.includes('new-event')) {
          putBody = String(opts?.body || '')
          return { status: 204, ok: true }
        }
        return innerImpl?.(url, opts) ?? { status: 404, text: async () => '' }
      })

      const result = await updateCalendarEvent('new-event', 'New Title', '2026-05-27T10:00:00', '2026-05-27T11:00:00', 'Notes')
      expect(result.ok).toBe(true)
      expect(putBody).toContain('SUMMARY:New Title')
      expect(putBody).toContain('DESCRIPTION:Notes')
    })

    it('increments SEQUENCE when merging', async () => {
      const existingVcal = `BEGIN:VCALENDAR\r
VERSION:2.0\r
PRODID:-//Test\r
BEGIN:VEVENT\r
UID:seq-event\r
SEQUENCE:5\r
DTSTART:20260525T140000Z\r
DTEND:20260525T150000Z\r
SUMMARY:Old Title\r
END:VEVENT\r
END:VCALENDAR`

      let putBody = ''
      const innerImpl = mockFetch.getMockImplementation()
      mockFetch.mockImplementation(async (url: string, opts?: Record<string, unknown>) => {
        const method = opts?.method as string
        if (method === 'GET' && url.includes('seq-event')) {
          return { ok: true, text: async () => existingVcal }
        }
        if (method === 'PUT' && url.includes('seq-event')) {
          putBody = String(opts?.body || '')
          return { status: 204, ok: true }
        }
        return innerImpl?.(url, opts) ?? { status: 404, text: async () => '' }
      })

      await updateCalendarEvent('seq-event', 'New Title', '2026-05-27T10:00:00', '2026-05-27T11:00:00')
      expect(putBody).toContain('SEQUENCE:6')
    })
  })

  describe('#698 - all-day event correctness', () => {
    it('multi-day all-day create yields DTEND = inclusive end + 1 day', async () => {
      let putBody = ''
      const innerImpl = mockFetch.getMockImplementation()
      mockFetch.mockImplementation(async (url: string, opts?: Record<string, unknown>) => {
        const method = opts?.method as string
        if (method === 'PUT') {
          putBody = String(opts?.body || '')
          return { status: 201, ok: true }
        }
        return innerImpl?.(url, opts) ?? { status: 404, text: async () => '' }
      })

      // Vacation: June 15–19 (inclusive), all-day
      await createCalendarEvent('Vacation', '2026-06-15', '2026-06-19', '', undefined, '', true)
      expect(putBody).toContain('DTSTART;VALUE=DATE:20260615')
      // Inclusive end 19 + 1 day = 20 (exclusive per iCal spec)
      expect(putBody).toContain('DTEND;VALUE=DATE:20260620')
      // Must NOT contain timed datetime form
      expect(putBody).not.toMatch(/DTSTART:\d{8}T/)
      expect(putBody).not.toMatch(/DTEND:\d{8}T/)
    })

    it('single-day all-day create yields DTEND = start + 1 (end < start guard)', async () => {
      let putBody = ''
      const innerImpl = mockFetch.getMockImplementation()
      mockFetch.mockImplementation(async (url: string, opts?: Record<string, unknown>) => {
        const method = opts?.method as string
        if (method === 'PUT') {
          putBody = String(opts?.body || '')
          return { status: 201, ok: true }
        }
        return innerImpl?.(url, opts) ?? { status: 404, text: async () => '' }
      })

      // Single-day: start == end
      await createCalendarEvent('Holiday', '2026-06-15', '2026-06-15', '', undefined, '', true)
      expect(putBody).toContain('DTSTART;VALUE=DATE:20260615')
      expect(putBody).toContain('DTEND;VALUE=DATE:20260616')
    })

    it('updating an all-day event preserves VALUE=DATE form', async () => {
      const existingVcal = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Test\r\nBEGIN:VEVENT\r\nUID:vacation-2026\r\nDTSTART;VALUE=DATE:20260615\r\nDTEND;VALUE=DATE:20260620\r\nSUMMARY:Vacation\r\nRRULE:FREQ=YEARLY\r\nEND:VEVENT\r\nEND:VCALENDAR`

      let putBody = ''
      const innerImpl = mockFetch.getMockImplementation()
      mockFetch.mockImplementation(async (url: string, opts?: Record<string, unknown>) => {
        const method = opts?.method as string
        if (method === 'GET' && url.includes('vacation-2026')) {
          return { ok: true, text: async () => existingVcal }
        }
        if (method === 'PUT' && url.includes('vacation-2026')) {
          putBody = String(opts?.body || '')
          return { status: 204, ok: true }
        }
        return innerImpl?.(url, opts) ?? { status: 404, text: async () => '' }
      })

      // Shift vacation by one week (inclusive end: June 22–26)
      const result = await updateCalendarEvent('vacation-2026', undefined, '2026-06-22', '2026-06-26')
      expect(result.ok).toBe(true)
      // Must keep VALUE=DATE form
      expect(putBody).toContain('DTSTART;VALUE=DATE:20260622')
      expect(putBody).toContain('DTEND;VALUE=DATE:20260627')
      // Must NOT have been silently converted to timed UTC
      expect(putBody).not.toMatch(/DTSTART:\d{8}T/)
      expect(putBody).not.toMatch(/DTEND:\d{8}T/)
      // RRULE must be preserved
      expect(putBody).toContain('RRULE:FREQ=YEARLY')
    })
  })

  describe('#449 - fetchEvents end time and location', () => {
    it('includes end time in getTodayEventsStr output', async () => {
      const innerImpl = mockFetch.getMockImplementation()
      mockFetch.mockImplementation(async (url: string, opts?: Record<string, unknown>) => {
        const method = opts?.method as string
        if (method === 'REPORT') {
          return {
            status: 207,
            text: async () =>
              `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:propstat><d:prop><c:calendar-data xmlns:c="urn:ietf:params:xml:ns:caldav">BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:end-test-1\r\nDTSTART:20260525T140000Z\r\nDTEND:20260525T150000Z\r\nSUMMARY:Test Meeting\r\nEND:VEVENT\r\nEND:VCALENDAR</c:calendar-data></d:prop></d:propstat></d:response></d:multistatus>`,
          }
        }
        return innerImpl?.(url, opts) ?? { status: 404, text: async () => '' }
      })

      const str = await getTodayEventsStr()
      expect(str).toContain('Test Meeting')
      expect(str).toMatch(/–/) // en-dash between start and end
    })

    it('includes location in getTodayEventsStr output when present', async () => {
      const innerImpl = mockFetch.getMockImplementation()
      mockFetch.mockImplementation(async (url: string, opts?: Record<string, unknown>) => {
        const method = opts?.method as string
        if (method === 'REPORT') {
          return {
            status: 207,
            text: async () =>
              `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:propstat><d:prop><c:calendar-data xmlns:c="urn:ietf:params:xml:ns:caldav">BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:loc-test-1\r\nDTSTART:20260525T140000Z\r\nDTEND:20260525T150000Z\r\nSUMMARY:Board Meeting\r\nLOCATION:Conference Room A\r\nEND:VEVENT\r\nEND:VCALENDAR</c:calendar-data></d:prop></d:propstat></d:response></d:multistatus>`,
          }
        }
        return innerImpl?.(url, opts) ?? { status: 404, text: async () => '' }
      })

      const str = await getTodayEventsStr()
      expect(str).toContain('Board Meeting')
      expect(str).toContain('[Conference Room A]')
    })

    it('omits location brackets when LOCATION is absent', async () => {
      const innerImpl = mockFetch.getMockImplementation()
      mockFetch.mockImplementation(async (url: string, opts?: Record<string, unknown>) => {
        const method = opts?.method as string
        if (method === 'REPORT') {
          return {
            status: 207,
            text: async () =>
              `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:propstat><d:prop><c:calendar-data xmlns:c="urn:ietf:params:xml:ns:caldav">BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:no-loc-1\r\nDTSTART:20260525T140000Z\r\nDTEND:20260525T150000Z\r\nSUMMARY:No Location Event\r\nEND:VEVENT\r\nEND:VCALENDAR</c:calendar-data></d:prop></d:propstat></d:response></d:multistatus>`,
          }
        }
        return innerImpl?.(url, opts) ?? { status: 404, text: async () => '' }
      })

      const str = await getTodayEventsStr()
      expect(str).toContain('No Location Event')
      expect(str).not.toContain('[Conference Room')
      expect(str).toContain('[uid:')
    })
  })

  describe('getUpcomingEvents shared cache', () => {
    // now is locked to 2026-05-25T12:00:00-05:00 == 17:00:00Z by the outer beforeEach.
    // Event runs 17:30-18:00Z: inside a 45-min window, outside a 10-min window.
    const reportImpl = async (url: string, opts?: Record<string, unknown>) => {
      const method = opts?.method as string
      if (method === 'REPORT') {
        return {
          status: 207,
          text: async () =>
            `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:propstat><d:prop><c:calendar-data xmlns:c="urn:ietf:params:xml:ns:caldav">BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:soon-1\r\nDTSTART:20260525T173000Z\r\nDTEND:20260525T180000Z\r\nSUMMARY:Soon Event\r\nEND:VEVENT\r\nEND:VCALENDAR</c:calendar-data></d:prop></d:propstat></d:response></d:multistatus>`,
        }
      }
      return undefined
    }

    const countReports = () =>
      mockFetch.mock.calls.filter((c) => (c[1] as Record<string, unknown> | undefined)?.['method'] === 'REPORT').length

    it('reuses one CalDAV fetch across the 10-min and 45-min poller windows', async () => {
      const base = mockFetch.getMockImplementation()!
      mockFetch.mockImplementation(async (url: string, opts?: Record<string, unknown>) =>
        (await reportImpl(url, opts)) ?? base(url, opts),
      )

      // First poller (10-min window): cache miss -> one REPORT round (one per calendar).
      const tenMin = await getUpcomingEvents(10)
      const afterFirst = countReports()
      expect(afterFirst).toBeGreaterThan(0)
      // Event at 17:30Z is outside the 10-min window (ends 17:10Z).
      expect(tenMin.some((e) => e.uid === 'soon-1')).toBe(false)

      // Second poller (45-min window) within TTL: served from cache, no new REPORT.
      const fortyFive = await getUpcomingEvents(45)
      expect(countReports()).toBe(afterFirst)
      // Same cached data, filtered to the wider window, now includes the event.
      expect(fortyFive.some((e) => e.uid === 'soon-1')).toBe(true)
    })

    it('refetches after the cache is invalidated', async () => {
      const base = mockFetch.getMockImplementation()!
      mockFetch.mockImplementation(async (url: string, opts?: Record<string, unknown>) =>
        (await reportImpl(url, opts)) ?? base(url, opts),
      )

      await getUpcomingEvents(45)
      const afterFirst = countReports()
      expect(afterFirst).toBeGreaterThan(0)

      __clearCache()

      await getUpcomingEvents(45)
      expect(countReports()).toBeGreaterThan(afterFirst)
    })
  })
})
