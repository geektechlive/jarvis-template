# Identity and Persona

Jarvis's character is not hardcoded in application logic. It is defined in a stack of Markdown files that are concatenated into the system prompt on every turn, with hot-reload on change. This makes the persona editable as content, not code.

## The Identity Stack

At runtime, a loader (Python `harness/identity/loader.py`, mirrored by TypeScript `harness-ts/src/persona/soul.ts`) concatenates five Markdown files, in this exact order, into the system-prompt prefix:

1. `SOUL.md`: voice and character
2. `BEHAVIOR.md`: decision rules and operational logic
3. `MISSION.md`: purpose and mandate
4. `GOALS.md`: current operational targets
5. `PROJECTS.md`: git-tracked project context for routing

Note: `VALUES.md` exists as reference material (a set of tiebreaker principles like "accuracy over speed" and "memory as trust") but is NOT injected at runtime.

### Hot-Reload Mechanism

The loader stat()s each file on every call and compares modification times against a cache. If any file changed, the concatenated prefix is rebuilt and re-cached. No restart, no redeploy: editing an identity file changes Jarvis on the next turn. The combined text is prepended to the system prompt inside the `before_prompt` hook.

## What Each File Holds

| File | Purpose |
|------|---------|
| `SOUL.md` | Voice, character, and speaking rules. Defines Jarvis as British, precise, and unflappable, modeled on Paul Bettany's JARVIS from the MCU. Covers address conventions, wit cadence, hedge-phrase prohibition, ethical boundaries, and memory honesty. |
| `BEHAVIOR.md` | Decision rules, routing logic, exclusive staff domains, and tool governance. The definitive operational ruleset. |
| `MISSION.md` | Why Jarvis exists: manage information flow, delegate, remove friction. |
| `GOALS.md` | Current operational targets and priority statements. |
| `PROJECTS.md` | Git-tracked context so Jarvis routes work requests to the correct staff member or system. |

## Persona Enforcement

Voice rules are enforced mechanically, not by suggestion alone. `harness/config/persona.yaml` defines:

- `banned_tokens`: exclamation marks and em dashes
- `banned_phrases`: "certainly", "of course", "great question", "happy to help", "let's dive in", "as an AI", "I think maybe", "perhaps maybe", "absolutely", "sure thing"
- `permitted_moves`: one understated joke per longer exchange, gentle correction as a question, "if I may", defaulting to "sir or ma'am"

A function `bannedTokenEnforcement()` in `harness-ts/src/persona/audit.ts` turns these lists into a "Hard constraints" addendum appended to the system prompt, instructing the model to self-enforce. `persona.yaml` is authoritative; hardcoded arrays serve as fallback.

## Immutable Voice, Self-Improvable Everything Else

Jarvis can rewrite parts of itself through an autonomous self-improvement loop, but only within a strict allowlist. This design preserves core identity while permitting operational refinement.

### Improvable Files

Jarvis may edit (via `auto/improve-*` branches):
- `harness/config/models.yaml`, `staff.yaml`, `routines.yaml`
- `harness/identity/BEHAVIOR.md`, `MISSION.md`, `GOALS.md`, `PROJECTS.md`
- Any staff spec under `harness/agents/*.md`

### Immutable Files

Jarvis cannot touch:
- `harness/identity/SOUL.md`: core voice is immutable
- `harness/identity/VALUES.md`: tiebreaker principles
- `harness-ts/`: runtime engine code
- Test suites

Improvement changes land on `auto/improve-*` branches and require human approval via `/improve approve <branch>` before merging to main. They never touch main directly.

The principle: Jarvis may refine how it behaves, who is on staff, and what it pursues, but it can never edit its own voice or its own engine.

## Where to go next

- [`./concept.md`](./concept.md): the concept and intent behind Jarvis
- [`./memory.md`](./memory.md): how Jarvis remembers and learns
- [`./staff.md`](./staff.md): the team of delegated agents
- [`./integrations.md`](./integrations.md): external systems and calendars
- [`../README.md`](../README.md): project overview
