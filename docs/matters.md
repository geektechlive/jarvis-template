# Matters

A Matter is a named, persistent collection of items that groups related facts, decisions, or artifacts under a topic. Matters function as project buckets or topic threads that Jarvis can add to over time and close when the topic is resolved. Each item in a matter carries a type (memory, email, task, note) and a reference (a vector ID, email thread ID, task description, or arbitrary string).

## Use cases

- **Home renovation or repair project** — collect quotes, contractor notes, measured dimensions, and decision history in a single bucket
- **Vendor evaluation** — group research threads, pricing proposals, and technical comparisons for a single procurement decision
- **Health or wellness concern** — stage notes, appointment results, and medication adjustments under a named medical situation
- **Ongoing personal project** — track progress, blockers, and resource links for a goal or hobby spanning weeks or months
- **Recurring life concern** — aggregate notes on tax planning, insurance decisions, or family logistics before a major deadline

## Data model

Matters are stored in two SQLite tables:

### `matters` table

| Column | Type | Description |
|---|---|---|
| `id` | TEXT PRIMARY KEY | UUID for the matter |
| `name` | TEXT NOT NULL | Short human-readable name (e.g., "house-move", "tax-2026") |
| `description` | TEXT DEFAULT '' | Optional longer description of the scope |
| `created_at` | TEXT NOT NULL | ISO 8601 timestamp of creation |
| `status` | TEXT DEFAULT 'open' | Either 'open' or 'closed'; only open matters accept new items |

### `matter_items` table

| Column | Type | Description |
|---|---|---|
| `id` | TEXT PRIMARY KEY | UUID for the item |
| `matter_id` | TEXT NOT NULL | Foreign key to `matters(id)` |
| `item_type` | TEXT NOT NULL | Item category: 'memory', 'email', 'task', or 'note' |
| `item_ref` | TEXT NOT NULL | Reference string (chroma ID, email thread ID, task description, or freeform text) |
| `added_at` | TEXT NOT NULL | ISO 8601 timestamp when the item was added |

An index on `matter_id` enables fast per-matter item queries.

## Ion tools

Tools are registered in `harness-ts/src/registrations/tools.ts` and callable via the LLM:

| Tool | Purpose |
|---|---|
| `create_matter` | Create a new named matter with optional description. Returns the matter ID. |
| `add_to_matter` | Add an item to an existing matter. Requires matter ID, item type ('memory', 'email', 'task', 'note'), and item reference (a chroma ID, email thread ID, task description, or arbitrary reference string). |
| `list_matters` | List all open matters by default. Pass `status='closed'` to show closed matters. Returns the full set of matters with metadata. |
| `get_matter` | Retrieve a matter and all its items by ID. Returns matter metadata and the full list of linked items. |
| `close_matter` | Close an open matter by ID. Use when a concern or project is resolved. Closed matters no longer accept new items but remain queryable. |

## Slash commands

Slash commands are registered in `harness-ts/src/registrations/commands/matters.ts`:

| Command | Subcommands | Purpose |
|---|---|---|
| `/matter` | `create <name> [-- description]` | Create a new matter with optional description. |
| | `show <name-or-id>` | Display a matter and all its items. Lookup is by ID or by name (case-insensitive). |
| | `add <name-or-id> <item_ref>` | Add a note-type item to a matter. Item reference is truncated to 120 chars in feedback. |
| | `close <name-or-id>` | Close an open matter. Fails silently if the matter is already closed or not found. |
| `/matters` | (none) | List all open matters. |

## HTTP endpoints (vec-server, port 9876)

The vec-server at `127.0.0.1:9876` exposes five matter endpoints:

| Endpoint | Method | Body | Response | Purpose |
|---|---|---|---|---|
| `/matters/create` | POST | `{ name: string, description?: string }` | `{ id: string, name: string }` | Create a new matter. Name is required. |
| `/matters/list` | POST | `{ status?: 'open' \| 'closed' }` | `{ matters: Array<Matter> }` | List matters, optionally filtered by status. |
| `/matters/show` | POST | `{ matter_id: string }` | `{ matter: Matter, items: Array<MatterItem> }` | Retrieve a matter and its items. |
| `/matters/add-item` | POST | `{ matter_id: string, item_type: string, item_ref: string }` | `{ id: string }` | Add an item to a matter. Returns the item ID. |
| `/matters/close` | POST | `{ matter_id: string }` | `{ closed: boolean }` | Close a matter. Returns false if already closed or not found. |

## Lifecycle

1. **Open**: A matter is created with a name and optional description. It starts in the 'open' status.
2. **Items added**: Any number of items (memories, emails, tasks, notes) are added incrementally via `/matters/add-item` or `/matter add`.
3. **Closed**: When the topic is resolved, the matter is closed via `/matters/close` or `/matter close`. Closed matters no longer accept new items.
4. **Archived**: Closed matters remain in the database indefinitely and remain queryable. They are not hard-deleted.

## Relationship to autonomy

Matters can serve as context for active goals. When a goal is running, it may reference a matter by ID or name to pull in relevant background items and decision history. This allows Jarvis to tie goal execution to the broader context of a personal project or concern.

## Source of truth

The matters system is implemented in:

- `harness/memory/episodic.py`: `matters` and `matter_items` table schema, and CRUD functions
- `tools-py/vector-store/server.py`: HTTP endpoint handlers for all matter operations
- `harness-ts/src/registrations/tools.ts`: Ion tool registrations for `create_matter`, `add_to_matter`, `list_matters`, `get_matter`, `close_matter`
- `harness-ts/src/registrations/commands/matters.ts`: Slash command handlers for `/matter` and `/matters`
