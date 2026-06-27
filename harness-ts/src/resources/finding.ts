// Resource module for the 'finding' kind.
// Owned by this extension; engine stores nothing.
//
// publishFinding() persists the item to resource_items (conversations.db) and
// publishes a delta to all subscribers. onQuery answers reconnect snapshots
// from that backing store.
//
// resourceId schemes used by findings dispatcher (dispatcher.ts):
//   finding_<id>         — single critical finding
//   synthesis_<firstId>  — entity-synthesized bundle
//   findings_important_<firstId> — important bundle

import { log, type IonContext, type ResourceHandle, type ResourceItem } from 'ion-sdk'
import { getSchedulerCtx } from '../scheduler/ctx'
import {
  ensureResourceItemsTable,
  storeResourceItem,
  fetchResourceItems,
} from './store'

let _handle: ResourceHandle | null = null

export function initFindingHandle(handle: ResourceHandle): void {
  ensureResourceItemsTable()
  _handle = handle
}

export async function publishFinding(
  resourceId: string,
  title: string,
  content: string,
  notifyBody: string,
  ctx?: IonContext,
): Promise<void> {
  const now = new Date().toISOString()

  // Always persist so onQuery can answer even if the handle is not yet ready.
  storeResourceItem({ id: resourceId, kind: 'finding', title: title.slice(0, 120), content, created_at: now })

  if (_handle) {
    const item: ResourceItem = {
      id: resourceId,
      kind: 'finding',
      title: title.slice(0, 120),
      content,
      createdAt: now,
    }
    try {
      await _handle.publish('create', item)
    } catch (err) {
      log.warn('finding: resource publish failed', { resourceId, err: String(err) })
    }
  } else {
    log.debug('finding: handle not yet initialized, skipping live publish')
  }

  const notifyCtx = ctx ?? getSchedulerCtx()
  if (notifyCtx) {
    await notifyCtx.notify({ kind: 'finding', title, body: notifyBody, resourceId })
  }
}

// onQuery handler — returns snapshot of recent finding resource items.
export function fetchFindingsFromStore(): ResourceItem[] {
  return fetchResourceItems('finding', 50).map((row) => ({
    id: row.id,
    kind: row.kind,
    title: row.title,
    content: row.content,
    createdAt: row.created_at,
  }))
}
