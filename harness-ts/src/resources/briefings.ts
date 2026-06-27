// Resource module for the 'briefing' kind.
// Owned by this extension; engine stores nothing.
// publishBriefing() publishes a delta to all subscribers (Desktop + iOS)
// and fires a notify() doorbell. storePendingBrief() (episodic.ts) remains
// the backing store for the onQuery() handler.

import { log, type IonContext, type ResourceHandle, type ResourceItem } from 'ion-sdk'
import { getSchedulerCtx } from '../scheduler/ctx'

let _handle: ResourceHandle | null = null

export function initBriefingsHandle(handle: ResourceHandle): void {
  _handle = handle
}

export async function publishBriefing(
  content: string,
  title: string,
  ctx?: IonContext,
): Promise<void> {
  if (!_handle) {
    log.debug('briefings: handle not yet initialized, skipping publish')
    return
  }
  const id = `brief-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const item: ResourceItem = {
    id,
    kind: 'briefing',
    title: title.slice(0, 120),
    content,
    createdAt: new Date().toISOString(),
  }
  await _handle.publish('create', item)
  const notifyCtx = ctx ?? getSchedulerCtx()
  if (notifyCtx) {
    await notifyCtx.notify({
      kind: 'briefing',
      resourceId: id,
      title,
      body: 'Your brief is ready.',
    })
  }
}
