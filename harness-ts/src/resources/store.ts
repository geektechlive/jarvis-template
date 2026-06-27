// Shared resource backing store for finding, imessage, and reminder kinds.
// Each published item is persisted here so onQuery() can answer reconnect
// snapshots with the exact resourceId that was notified.
//
// Uses conversations.db (via the db() import from episodic) so no separate
// file or connection is needed. The resource_items table is append-only;
// rows older than 7 days are purged by purgeOldResourceItems().

import { db } from '../memory/episodic'
import { log } from 'ion-sdk'

const RETENTION_DAYS = 7

export interface ResourceItemRow {
  id: string
  kind: string
  title: string
  content: string
  created_at: string
}

// Called once at module init by each resource module to ensure the table exists.
export function ensureResourceItemsTable(): void {
  try {
    db().exec(`
      CREATE TABLE IF NOT EXISTS resource_items (
        id         TEXT PRIMARY KEY,
        kind       TEXT NOT NULL,
        title      TEXT NOT NULL DEFAULT '',
        content    TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS resource_items_kind_ts
        ON resource_items (kind, created_at DESC);
    `)
  } catch (err) {
    log.warn('resource-store: ensureResourceItemsTable failed', { err: String(err) })
  }
}

export function storeResourceItem(row: ResourceItemRow): void {
  try {
    db()
      .prepare(
        `INSERT OR IGNORE INTO resource_items (id, kind, title, content, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(row.id, row.kind, row.title, row.content, row.created_at)
  } catch (err) {
    log.warn('resource-store: storeResourceItem failed', { id: row.id, kind: row.kind, err: String(err) })
  }
}

export function fetchResourceItems(kind: string, limit = 50): ResourceItemRow[] {
  try {
    return db()
      .prepare(
        `SELECT id, kind, title, content, created_at
         FROM resource_items
         WHERE kind = ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(kind, limit) as ResourceItemRow[]
  } catch (err) {
    log.warn('resource-store: fetchResourceItems failed', { kind, err: String(err) })
    return []
  }
}

export function purgeOldResourceItems(): void {
  try {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000).toISOString()
    db().prepare(`DELETE FROM resource_items WHERE created_at < ?`).run(cutoff)
  } catch (err) {
    log.warn('resource-store: purgeOldResourceItems failed', { err: String(err) })
  }
}
