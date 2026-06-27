// Resource module for the 'reminder' kind.
// Owned by this extension; engine stores nothing.
//
// publishReminder() persists the item to resource_items (conversations.db) and
// publishes a delta to subscribers. onQuery answers reconnect snapshots.
//
// resourceId scheme (reminders/tick.ts):
//   reminder_<id>
//
// Note: the operational reminders table (reminders in conversations.db) marks
// rows 'fired' after delivery, so dueReminders() returns nothing for already-
// delivered items. The resource_items table is a separate snapshot store for
// the resource subsystem, and answers onQuery regardless of fired status.

import { log, type IonContext, type ResourceHandle, type ResourceItem } from 'ion-sdk'
import { getSchedulerCtx } from '../scheduler/ctx'
import {
  ensureResourceItemsTable,
  storeResourceItem,
  fetchResourceItems,
} from './store'

let _handle: ResourceHandle | null = null

export function initReminderHandle(handle: ResourceHandle): void {
  ensureResourceItemsTable()
  _handle = handle
}

export async function publishReminder(
  id: number,
  message: string,
  ctx?: IonContext,
): Promise<void> {
  const resourceId = `reminder_${id}`
  const title = 'Reminder'
  const now = new Date().toISOString()

  // Always persist so onQuery can answer even if the handle is not yet ready.
  storeResourceItem({ id: resourceId, kind: 'reminder', title, content: message, created_at: now })

  if (_handle) {
    const item: ResourceItem = {
      id: resourceId,
      kind: 'reminder',
      title,
      content: message,
      createdAt: now,
    }
    try {
      await _handle.publish('create', item)
    } catch (err) {
      log.warn('reminder: resource publish failed', { resourceId, err: String(err) })
    }
  } else {
    log.debug('reminder: handle not yet initialized, skipping live publish')
  }

  const notifyCtx = ctx ?? getSchedulerCtx()
  if (notifyCtx) {
    await notifyCtx.notify({ kind: 'reminder', title, body: message, resourceId })
  }
}

// onQuery handler — returns snapshot of recent reminder resource items.
export function fetchRemindersFromStore(): ResourceItem[] {
  return fetchResourceItems('reminder', 50).map((row) => ({
    id: row.id,
    kind: row.kind,
    title: row.title,
    content: row.content,
    createdAt: row.created_at,
  }))
}
