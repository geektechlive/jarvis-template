import { describe, it, expect, vi, beforeEach } from 'vitest'

// Hoist mocks before any imports so vi.mock() is fully hoisted
vi.mock('../memory/episodic', () => ({
  dueReminders: vi.fn(),
  markReminderFired: vi.fn(),
  requeueReminder: vi.fn(),
  escalateReminder: vi.fn(),
  storePendingReminder: vi.fn(),
  lastMessageTs: vi.fn(),
}))

// ion-sdk is imported transitively by tick.ts; provide a stub so tests don't
// require the actual runtime.
vi.mock('ion-sdk', () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

// Mock the reminder resource module so tick.test.ts doesn't need a DB.
// The real publishReminder persists to SQLite and calls ctx.notify internally.
// Here we delegate directly to ctx.notify so the test assertions remain valid.
vi.mock('../resources/reminder', () => ({
  publishReminder: vi.fn(async (id: number, message: string, ctx: { notify: (opts: unknown) => Promise<void> }) => {
    await ctx.notify({ kind: 'reminder', title: 'Reminder', body: message, resourceId: `reminder_${id}` })
  }),
}))

import { tickReminders } from './tick'
import {
  dueReminders,
  markReminderFired,
  requeueReminder,
  escalateReminder,
  storePendingReminder,
  lastMessageTs,
} from '../memory/episodic'
import type { IonContext } from 'ion-sdk'
import type { ReminderRow } from '../memory/episodic'

const dueRemindersMock = vi.mocked(dueReminders)
const markReminderFiredMock = vi.mocked(markReminderFired)
const requeueReminderMock = vi.mocked(requeueReminder)
const escalateReminderMock = vi.mocked(escalateReminder)
const storePendingReminderMock = vi.mocked(storePendingReminder)
const lastMessageTsMock = vi.mocked(lastMessageTs)

function makeCtx(): { notify: ReturnType<typeof vi.fn> } & Pick<IonContext, 'notify'> {
  return { notify: vi.fn().mockResolvedValue(undefined) }
}

const SAMPLE_ROW: ReminderRow = {
  id: 1,
  user_text: 'remind me in 1 hour to call dentist',
  fire_at: new Date(Date.now() - 1000).toISOString(),
  message: 'call dentist',
  status: 'pending',
  attempts: 0,
  escalation_level: 0,
  escalation_cap: 0,
  next_remind_at: null,
  created_at: new Date().toISOString(),
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('tickReminders', () => {
  it('does nothing when there are no due reminders', async () => {
    dueRemindersMock.mockReturnValue([])
    const ctx = makeCtx()

    await tickReminders(ctx as unknown as IonContext)

    expect(markReminderFiredMock).not.toHaveBeenCalled()
    expect(storePendingReminderMock).not.toHaveBeenCalled()
    expect(ctx.notify).not.toHaveBeenCalled()
  })

  it('stores pending reminder when session is active (recent message < 5 min)', async () => {
    dueRemindersMock.mockReturnValue([SAMPLE_ROW])
    markReminderFiredMock.mockReturnValue(true)
    // lastMessageTs returns a timestamp 30 seconds ago → active session
    lastMessageTsMock.mockReturnValue(new Date(Date.now() - 30_000).toISOString())
    const ctx = makeCtx()

    await tickReminders(ctx as unknown as IonContext)

    expect(markReminderFiredMock).toHaveBeenCalledWith(1)
    expect(storePendingReminderMock).toHaveBeenCalledWith('call dentist')
    expect(ctx.notify).not.toHaveBeenCalled()
  })

  it('pushes to phone when session is idle (last message > 5 min ago)', async () => {
    dueRemindersMock.mockReturnValue([SAMPLE_ROW])
    markReminderFiredMock.mockReturnValue(true)
    // lastMessageTs returns a timestamp 10 minutes ago → idle session
    lastMessageTsMock.mockReturnValue(new Date(Date.now() - 10 * 60_000).toISOString())
    const ctx = makeCtx()

    await tickReminders(ctx as unknown as IonContext)

    expect(markReminderFiredMock).toHaveBeenCalledWith(1)
    expect(ctx.notify).toHaveBeenCalledWith({ kind: 'reminder', title: 'Reminder', body: 'call dentist', resourceId: 'reminder_1' })
    expect(storePendingReminderMock).not.toHaveBeenCalled()
  })

  it('skips delivery when markReminderFired returns false (CAS miss)', async () => {
    dueRemindersMock.mockReturnValue([SAMPLE_ROW])
    markReminderFiredMock.mockReturnValue(false)
    lastMessageTsMock.mockReturnValue(new Date(Date.now() - 30_000).toISOString())
    const ctx = makeCtx()

    await tickReminders(ctx as unknown as IonContext)

    expect(storePendingReminderMock).not.toHaveBeenCalled()
    expect(ctx.notify).not.toHaveBeenCalled()
  })

  it('does not throw when delivery throws an error', async () => {
    dueRemindersMock.mockReturnValue([SAMPLE_ROW])
    markReminderFiredMock.mockReturnValue(true)
    lastMessageTsMock.mockReturnValue(new Date(Date.now() - 30_000).toISOString())
    requeueReminderMock.mockReturnValue('requeued')
    storePendingReminderMock.mockImplementation(() => {
      throw new Error('DB write failed')
    })
    const ctx = makeCtx()

    await expect(tickReminders(ctx as unknown as IonContext)).resolves.toBeUndefined()
  })

  it('calls requeueReminder when delivery throws', async () => {
    dueRemindersMock.mockReturnValue([SAMPLE_ROW])
    markReminderFiredMock.mockReturnValue(true)
    lastMessageTsMock.mockReturnValue(new Date(Date.now() - 30_000).toISOString())
    requeueReminderMock.mockReturnValue('requeued')
    storePendingReminderMock.mockImplementation(() => {
      throw new Error('transient failure')
    })
    const ctx = makeCtx()

    await tickReminders(ctx as unknown as IonContext)

    expect(requeueReminderMock).toHaveBeenCalledWith(SAMPLE_ROW.id)
  })

  it('emits log.error (not log.warn) when requeueReminder returns failed', async () => {
    const { log } = await import('ion-sdk')
    dueRemindersMock.mockReturnValue([SAMPLE_ROW])
    markReminderFiredMock.mockReturnValue(true)
    lastMessageTsMock.mockReturnValue(new Date(Date.now() - 30_000).toISOString())
    requeueReminderMock.mockReturnValue('failed')
    storePendingReminderMock.mockImplementation(() => {
      throw new Error('persistent failure')
    })
    const ctx = makeCtx()

    await tickReminders(ctx as unknown as IonContext)

    expect(vi.mocked(log.error)).toHaveBeenCalledWith(
      'reminders: delivery permanently failed after max attempts',
      expect.objectContaining({ id: SAMPLE_ROW.id }),
    )
    expect(vi.mocked(log.warn)).not.toHaveBeenCalled()
  })

  // #542: escalation re-queue after successful delivery.
  describe('escalation', () => {
    it('re-queues an escalating reminder that is under its cap', async () => {
      const row: ReminderRow = {
        ...SAMPLE_ROW,
        escalation_cap: 10,
        escalation_level: 0,
        // 2h lead -> CRITICAL tier.
        created_at: new Date(Date.now() - 2 * 3600_000).toISOString(),
        fire_at: new Date(Date.now() - 1000).toISOString(),
      }
      dueRemindersMock.mockReturnValue([row])
      markReminderFiredMock.mockReturnValue(true)
      lastMessageTsMock.mockReturnValue(null) // idle -> push path

      await tickReminders(makeCtx() as unknown as IonContext)

      expect(escalateReminderMock).toHaveBeenCalledTimes(1)
      expect(escalateReminderMock).toHaveBeenCalledWith(1, expect.any(Date))
    })

    it('does not escalate a one-shot reminder (cap 0)', async () => {
      dueRemindersMock.mockReturnValue([SAMPLE_ROW]) // escalation_cap: 0
      markReminderFiredMock.mockReturnValue(true)
      lastMessageTsMock.mockReturnValue(null)

      await tickReminders(makeCtx() as unknown as IonContext)

      expect(escalateReminderMock).not.toHaveBeenCalled()
    })

    it('stops escalating once the level reaches the cap', async () => {
      const row: ReminderRow = { ...SAMPLE_ROW, escalation_cap: 3, escalation_level: 3 }
      dueRemindersMock.mockReturnValue([row])
      markReminderFiredMock.mockReturnValue(true)
      lastMessageTsMock.mockReturnValue(null)

      await tickReminders(makeCtx() as unknown as IonContext)

      expect(escalateReminderMock).not.toHaveBeenCalled()
    })

    it('does not escalate when delivery fails (requeue handles retry instead)', async () => {
      const row: ReminderRow = { ...SAMPLE_ROW, escalation_cap: 10, escalation_level: 0 }
      dueRemindersMock.mockReturnValue([row])
      markReminderFiredMock.mockReturnValue(true)
      lastMessageTsMock.mockReturnValue(null)
      requeueReminderMock.mockReturnValue('requeued')
      const ctx = makeCtx()
      ctx.notify.mockRejectedValueOnce(new Error('push failed'))

      await tickReminders(ctx as unknown as IonContext)

      expect(escalateReminderMock).not.toHaveBeenCalled()
      expect(requeueReminderMock).toHaveBeenCalledWith(1)
    })

    it('does not requeue when escalation persistence throws after a successful delivery', async () => {
      // An escalateReminder failure must NOT be mistaken for a delivery failure
      // (which would wrongly increment attempts and re-deliver). The reminder was
      // already delivered this cycle.
      const row: ReminderRow = { ...SAMPLE_ROW, escalation_cap: 10, escalation_level: 0 }
      dueRemindersMock.mockReturnValue([row])
      markReminderFiredMock.mockReturnValue(true)
      lastMessageTsMock.mockReturnValue(null)
      escalateReminderMock.mockImplementation(() => { throw new Error('db busy') })

      await tickReminders(makeCtx() as unknown as IonContext)

      expect(escalateReminderMock).toHaveBeenCalledTimes(1)
      expect(requeueReminderMock).not.toHaveBeenCalled()
    })
  })
})
