import type { IonSDK } from 'ion-sdk'
import { logEvent } from '../../memory/episodic'
import { VEC_SERVER, VEC_TIMEOUT_MS } from '../../config/endpoints'

// UUID pattern: 8-4-4-4-12 hex chars
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface Matter {
  id: string
  name: string
  description: string
  created_at: string
  status: string
}

interface MatterItem {
  id: string
  item_type: string
  item_ref: string
  added_at: string
}

async function resolveMatter(nameOrId: string): Promise<Matter | null> {
  // Try by ID if it looks like a UUID, otherwise look up by name.
  if (UUID_RE.test(nameOrId)) {
    const res = await fetch(`${VEC_SERVER}/matters/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ matter_id: nameOrId }),
      signal: AbortSignal.timeout(VEC_TIMEOUT_MS),
    })
    if (res.ok) {
      const data = (await res.json()) as { matter: Matter }
      return data.matter
    }
    return null
  }
  // Name lookup: list open matters and find by name (case-insensitive)
  const res = await fetch(`${VEC_SERVER}/matters/list`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'open' }),
    signal: AbortSignal.timeout(VEC_TIMEOUT_MS),
  })
  if (!res.ok) return null
  const data = (await res.json()) as { matters: Matter[] }
  return data.matters.find((m) => m.name.toLowerCase() === nameOrId.toLowerCase()) ?? null
}

// Slash commands: /matter <subcommand> and /matters (list)
export function registerMattersCommands(ion: IonSDK): void {
  // /matter create <name> [-- description]
  // /matter show <name-or-id>
  // /matter add <name-or-id> <item_ref>
  // /matter close <name-or-id>
  ion.registerCommand('matter', {
    description:
      'Manage matters (named concerns). Subcommands: create <name> [-- description], show <name-or-id>, add <name-or-id> <item_ref>, close <name-or-id>',
    execute: async (args) => {
      const trimmed = args.trim()
      const spaceIdx = trimmed.indexOf(' ')
      const sub = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)
      const rest = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim()

      if (!sub) {
        logEvent('matters', 'inbox_item', {
          routine: 'matters',
          text: 'Usage: /matter create|show|add|close',
        })
        return
      }

      if (sub === 'create') {
        // Split on first " -- " to separate name from description
        const sepIdx = rest.indexOf(' -- ')
        const name = sepIdx === -1 ? rest : rest.slice(0, sepIdx).trim()
        const description = sepIdx === -1 ? '' : rest.slice(sepIdx + 4).trim()
        if (!name) {
          logEvent('matters', 'inbox_item', {
            routine: 'matters',
            text: 'Usage: /matter create <name> [-- description]',
          })
          return
        }
        try {
          const res = await fetch(`${VEC_SERVER}/matters/create`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, description }),
            signal: AbortSignal.timeout(VEC_TIMEOUT_MS),
          })
          const data = (await res.json()) as { id?: string; name?: string; error?: string }
          if (data.error) {
            logEvent('matters', 'inbox_item', {
              routine: 'matters',
              text: `Failed to create matter: ${data.error}`,
            })
          } else {
            logEvent('matters', 'inbox_item', {
              routine: 'matters',
              text: `Matter created: "${data.name}" (id: ${data.id})`,
            })
          }
        } catch (err: unknown) {
          logEvent('matters', 'inbox_item', {
            routine: 'matters',
            text: `Matters unavailable (vec server not running?): ${String(err)}`,
          })
        }
        return
      }

      if (sub === 'show') {
        if (!rest) {
          logEvent('matters', 'inbox_item', {
            routine: 'matters',
            text: 'Usage: /matter show <name-or-id>',
          })
          return
        }
        try {
          const matter = await resolveMatter(rest)
          if (!matter) {
            logEvent('matters', 'inbox_item', {
              routine: 'matters',
              text: `No matter found: "${rest}"`,
            })
            return
          }
          const itemsRes = await fetch(`${VEC_SERVER}/matters/show`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ matter_id: matter.id }),
            signal: AbortSignal.timeout(VEC_TIMEOUT_MS),
          })
          const itemsData = (await itemsRes.json()) as { matter: Matter; items: MatterItem[]; error?: string }
          if (itemsData.error) {
            logEvent('matters', 'inbox_item', {
              routine: 'matters',
              text: `Show failed: ${itemsData.error}`,
            })
            return
          }
          const lines: string[] = [
            `Matter: ${itemsData.matter.name} [${itemsData.matter.status}]`,
            `ID: ${itemsData.matter.id}`,
            `Created: ${itemsData.matter.created_at.slice(0, 10)}`,
          ]
          if (itemsData.matter.description) {
            lines.push(`Description: ${itemsData.matter.description}`)
          }
          if (itemsData.items.length === 0) {
            lines.push('No items yet.')
          } else {
            lines.push(`Items (${itemsData.items.length}):`)
            for (const item of itemsData.items) {
              lines.push(`  [${item.item_type}] ${item.item_ref}  (${item.added_at.slice(0, 10)})`)
            }
          }
          logEvent('matters', 'inbox_item', {
            routine: 'matters',
            text: lines.join('\n'),
          })
        } catch (err: unknown) {
          logEvent('matters', 'inbox_item', {
            routine: 'matters',
            text: `Matters unavailable (vec server not running?): ${String(err)}`,
          })
        }
        return
      }

      if (sub === 'add') {
        // First whitespace-delimited token is name-or-id; rest is item_ref
        const addSpaceIdx = rest.indexOf(' ')
        if (addSpaceIdx === -1) {
          logEvent('matters', 'inbox_item', {
            routine: 'matters',
            text: 'Usage: /matter add <name-or-id> <item_ref>',
          })
          return
        }
        const nameOrId = rest.slice(0, addSpaceIdx).trim()
        const itemRef = rest.slice(addSpaceIdx + 1).trim()
        if (!nameOrId || !itemRef) {
          logEvent('matters', 'inbox_item', {
            routine: 'matters',
            text: 'Usage: /matter add <name-or-id> <item_ref>',
          })
          return
        }
        try {
          const matter = await resolveMatter(nameOrId)
          if (!matter) {
            logEvent('matters', 'inbox_item', {
              routine: 'matters',
              text: `No matter found: "${nameOrId}"`,
            })
            return
          }
          const res = await fetch(`${VEC_SERVER}/matters/add-item`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ matter_id: matter.id, item_type: 'note', item_ref: itemRef }),
            signal: AbortSignal.timeout(VEC_TIMEOUT_MS),
          })
          const data = (await res.json()) as { id?: string; error?: string }
          if (data.error) {
            logEvent('matters', 'inbox_item', {
              routine: 'matters',
              text: `Add failed: ${data.error}`,
            })
          } else {
            logEvent('matters', 'inbox_item', {
              routine: 'matters',
              text: `Added note to "${matter.name}": ${itemRef.slice(0, 120)}`,
            })
          }
        } catch (err: unknown) {
          logEvent('matters', 'inbox_item', {
            routine: 'matters',
            text: `Matters unavailable (vec server not running?): ${String(err)}`,
          })
        }
        return
      }

      if (sub === 'close') {
        if (!rest) {
          logEvent('matters', 'inbox_item', {
            routine: 'matters',
            text: 'Usage: /matter close <name-or-id>',
          })
          return
        }
        try {
          const matter = await resolveMatter(rest)
          if (!matter) {
            logEvent('matters', 'inbox_item', {
              routine: 'matters',
              text: `No open matter found: "${rest}"`,
            })
            return
          }
          // Re-use the show endpoint to get the matter, then call add-item style close.
          // Close is done via a dedicated matters/close endpoint (to be added) or we
          // can use the episodic function. For now, call vec-server matters/close.
          const res = await fetch(`${VEC_SERVER}/matters/close`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ matter_id: matter.id }),
            signal: AbortSignal.timeout(VEC_TIMEOUT_MS),
          })
          const data = (await res.json()) as { closed?: boolean; error?: string }
          if (data.error) {
            logEvent('matters', 'inbox_item', {
              routine: 'matters',
              text: `Close failed: ${data.error}`,
            })
          } else if (data.closed) {
            logEvent('matters', 'inbox_item', {
              routine: 'matters',
              text: `Closed matter: "${matter.name}"`,
            })
          } else {
            logEvent('matters', 'inbox_item', {
              routine: 'matters',
              text: `Matter "${matter.name}" was not open or could not be closed.`,
            })
          }
        } catch (err: unknown) {
          logEvent('matters', 'inbox_item', {
            routine: 'matters',
            text: `Matters unavailable (vec server not running?): ${String(err)}`,
          })
        }
        return
      }

      logEvent('matters', 'inbox_item', {
        routine: 'matters',
        text: `Unknown subcommand: "${sub}". Usage: /matter create|show|add|close`,
      })
    },
  })

  // /matters -- list all open matters
  ion.registerCommand('matters', {
    description: 'List all open matters.',
    execute: async () => {
      try {
        const res = await fetch(`${VEC_SERVER}/matters/list`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'open' }),
          signal: AbortSignal.timeout(VEC_TIMEOUT_MS),
        })
        const data = (await res.json()) as { matters?: Matter[]; error?: string }
        if (data.error) {
          logEvent('matters', 'inbox_item', {
            routine: 'matters',
            text: `List failed: ${data.error}`,
          })
          return
        }
        const matters = data.matters ?? []
        if (matters.length === 0) {
          logEvent('matters', 'inbox_item', { routine: 'matters', text: 'No open matters.' })
          return
        }
        const lines = matters.map(
          (m) => `[${m.created_at.slice(0, 10)}] ${m.name} (${m.id.slice(0, 8)}...)`,
        )
        logEvent('matters', 'inbox_item', {
          routine: 'matters',
          text: `Open matters (${matters.length}):\n${lines.join('\n')}`,
        })
      } catch (err: unknown) {
        logEvent('matters', 'inbox_item', {
          routine: 'matters',
          text: `Matters unavailable (vec server not running?): ${String(err)}`,
        })
      }
    },
  })
}
