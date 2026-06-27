// Resource module for the 'imessage' kind.
// Owned by this extension; engine stores nothing.
//
// publishUrgentImessage() persists the item to resource_items (conversations.db)
// and publishes a delta to subscribers. onQuery answers reconnect snapshots.
//
// resourceId scheme (webhooks/imessage.ts):
//   imessage_urgent_<guid>

import { log, type IonContext, type ResourceHandle, type ResourceItem } from 'ion-sdk'
import { getSchedulerCtx } from '../scheduler/ctx'
import {
  ensureResourceItemsTable,
  storeResourceItem,
  fetchResourceItems,
} from './store'

let _handle: ResourceHandle | null = null

export function initImessageHandle(handle: ResourceHandle): void {
  ensureResourceItemsTable()
  _handle = handle
}

export async function publishUrgentImessage(
  guid: string,
  displayName: string,
  body: string,
  ctx?: IonContext,
): Promise<void> {
  const resourceId = `imessage_urgent_${guid}`
  const title = `Urgent: ${displayName}`
  const now = new Date().toISOString()

  // Always persist so onQuery can answer even if the handle is not yet ready.
  storeResourceItem({ id: resourceId, kind: 'imessage', title: title.slice(0, 120), content: body, created_at: now })

  if (_handle) {
    const item: ResourceItem = {
      id: resourceId,
      kind: 'imessage',
      title: title.slice(0, 120),
      content: body,
      createdAt: now,
    }
    try {
      await _handle.publish('create', item)
    } catch (err) {
      log.warn('imessage: resource publish failed', { resourceId, err: String(err) })
    }
  } else {
    log.debug('imessage: handle not yet initialized, skipping live publish')
  }

  const notifyCtx = ctx ?? getSchedulerCtx()
  if (notifyCtx) {
    await notifyCtx.notify({
      kind: 'imessage',
      title: 'Jarvis — Urgent Message',
      body: `From ${displayName}: ${body.slice(0, 100)}`,
      resourceId,
    })
  }
}

// onQuery handler — returns snapshot of recent urgent imessage resource items.
export function fetchImessagesFromStore(): ResourceItem[] {
  return fetchResourceItems('imessage', 50).map((row) => ({
    id: row.id,
    kind: row.kind,
    title: row.title,
    content: row.content,
    createdAt: row.created_at,
  }))
}
