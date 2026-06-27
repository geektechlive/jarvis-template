// Tests for finding, imessage, and reminder resource modules.
// Verifies that the resourceId emitted by notify matches an item in the
// onQuery snapshot — the root bug this subsystem fixes.
//
// Each test:
//  1. Sets AGENT_DATA_DIR to an isolated tmpdir (conversations.db)
//  2. Wires a mock ResourceHandle so publish() calls are recorded
//  3. Calls the publish helper
//  4. Calls the onQuery fetch function
//  5. Asserts the snapshot contains an item whose id === the notified resourceId

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { join } from 'node:path'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { ResourceHandle, ResourceItem } from 'ion-sdk'

// Dynamic imports are used so AGENT_DATA_DIR is set before DB paths are captured.
const tmpDir = join(tmpdir(), `resources-test-${Date.now()}-${Math.trunc(Math.random() * 1e6)}`)

let findingMod: typeof import('./finding')
let imessageMod: typeof import('./imessage')
let reminderMod: typeof import('./reminder')

function makeMockHandle(): { handle: ResourceHandle; published: Array<{ op: string; item: ResourceItem }> } {
  const published: Array<{ op: string; item: ResourceItem }> = []
  const handle: ResourceHandle = {
    publish: vi.fn(async (op: string, item: ResourceItem) => {
      published.push({ op, item })
    }),
  }
  return { handle, published }
}

const mockCtx = {
  notify: vi.fn(async () => { /* noop */ }),
}

beforeAll(async () => {
  mkdirSync(tmpDir, { recursive: true })
  process.env['AGENT_DATA_DIR'] = tmpDir
  findingMod = await import('./finding')
  imessageMod = await import('./imessage')
  reminderMod = await import('./reminder')
})

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true })
  delete process.env['AGENT_DATA_DIR']
})

// ---------------------------------------------------------------------------
// finding
// ---------------------------------------------------------------------------

describe('finding resource', () => {
  it('finding_<id>: onQuery snapshot contains notified resourceId', async () => {
    const { handle, published } = makeMockHandle()
    findingMod.initFindingHandle(handle)

    const resourceId = 'finding_42'
    await findingMod.publishFinding(resourceId, 'Urgent', 'Critical content', 'short body', mockCtx as never)

    expect(published).toHaveLength(1)
    expect(published[0]?.item.id).toBe(resourceId)

    const snapshot = findingMod.fetchFindingsFromStore()
    const found = snapshot.find((r) => r.id === resourceId)
    expect(found).toBeDefined()
    expect(found?.kind).toBe('finding')
  })

  it('synthesis_<firstId>: onQuery snapshot contains notified resourceId', async () => {
    const resourceId = 'synthesis_7'
    await findingMod.publishFinding(resourceId, 'Intelligence Brief', 'Synthesized text', 'short body', mockCtx as never)

    const snapshot = findingMod.fetchFindingsFromStore()
    const found = snapshot.find((r) => r.id === resourceId)
    expect(found).toBeDefined()
    expect(found?.id).toBe(resourceId)
  })

  it('findings_important_<firstId>: onQuery snapshot contains notified resourceId', async () => {
    const resourceId = 'findings_important_99'
    await findingMod.publishFinding(resourceId, 'Jarvis — Findings', 'Bundle text', '3 items', mockCtx as never)

    const snapshot = findingMod.fetchFindingsFromStore()
    const found = snapshot.find((r) => r.id === resourceId)
    expect(found).toBeDefined()
    expect(found?.id).toBe(resourceId)
  })
})

// ---------------------------------------------------------------------------
// imessage
// ---------------------------------------------------------------------------

describe('imessage resource', () => {
  it('imessage_urgent_<guid>: onQuery snapshot contains notified resourceId', async () => {
    const { handle, published } = makeMockHandle()
    imessageMod.initImessageHandle(handle)

    const guid = 'ABCD-1234-EFGH'
    const resourceId = `imessage_urgent_${guid}`
    await imessageMod.publishUrgentImessage(guid, 'Alice', 'Call me now', mockCtx as never)

    expect(published).toHaveLength(1)
    expect(published[0]?.item.id).toBe(resourceId)

    const snapshot = imessageMod.fetchImessagesFromStore()
    const found = snapshot.find((r) => r.id === resourceId)
    expect(found).toBeDefined()
    expect(found?.kind).toBe('imessage')
    expect(found?.content).toBe('Call me now')
  })
})

// ---------------------------------------------------------------------------
// reminder
// ---------------------------------------------------------------------------

describe('reminder resource', () => {
  it('reminder_<id>: onQuery snapshot contains notified resourceId', async () => {
    const { handle, published } = makeMockHandle()
    reminderMod.initReminderHandle(handle)

    const id = 55
    const resourceId = `reminder_${id}`
    await reminderMod.publishReminder(id, 'Pick up dry cleaning', mockCtx as never)

    expect(published).toHaveLength(1)
    expect(published[0]?.item.id).toBe(resourceId)

    const snapshot = reminderMod.fetchRemindersFromStore()
    const found = snapshot.find((r) => r.id === resourceId)
    expect(found).toBeDefined()
    expect(found?.kind).toBe('reminder')
    expect(found?.content).toBe('Pick up dry cleaning')
  })
})
