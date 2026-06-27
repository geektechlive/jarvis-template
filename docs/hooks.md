---
title: Extension Hooks
description: All ion extension hooks registered by harness-ts — before_prompt injection sequence, turn lifecycle, tool pipeline, and the fire-and-forget async pattern.
sidebar_position: 5
---

# Ion Extension Hooks

Ion extension hooks are callbacks that fire at specific points in the conversation lifecycle. Jarvis registers hooks to inject context, process output, track tool use, and manage session state. They are the bridge between the ion engine (which executes the conversation) and the TypeScript extension (which decides what happens at each stage).

## What Are Hooks?

Hooks are asynchronous functions that ion invokes at predetermined moments:
- **Observe-only hooks** fire to let the extension monitor state (e.g., `session_start`, `turn_end`, `tool_end`).
- **Decision hooks** fire to let the extension modify behavior before ion proceeds (e.g., `before_prompt`, `permission_classify`).
- **Payload hooks** receive information about what just happened and decide the next action.

Hooks are registered in `/harness-ts/src/extension.ts` via the ion SDK: `ion.on('hook_name', (ctx, payload) => {...})`. They run synchronously or asynchronously depending on the hook type.

## Hook Lifecycle Map

The conversation flows through these hook moments:

```
[User sends message]
  ↓
before_prompt hook
  ├─ Log user message to episodic store
  ├─ Resolve pending clarifications
  ├─ Recall memories (vec-server parallel call, 10s timeout)
  ├─ Inject routing corrections, feedback, recent topics, working memory
  ├─ Audit persona constraints (banned tokens, em dash escalation)
  └─ Return system prompt addition
  ↓
[Ion sends prompt to Claude Sonnet 4.6]
  ↓
turn_end hook
  ├─ Log assistant reply to episodic store
  ├─ Audit reply for persona violations
  ├─ Invoke voice synthesis (fire-and-forget, 5s timeout)
  ├─ Ingest to knowledge graph (fire-and-forget, async)
  └─ Extract memories (fire-and-forget, chained async)
  ↓
[Tools execute (Agent dispatch, Calendar, Mail, etc.)]
  ├─ tool_start hook
  ├─ tool_call hook (detect Agent dispatch, resolve display name)
  └─ tool_end hook (watchdog for single-shot dispatches)
  ↓
turn_start hook (fires NEXT turn, AFTER all tools complete)
  ├─ Mark dispatched agents as done
  └─ Emit sidebar update
  ↓
[Loop: user sends follow-up, next before_prompt fires]
  ↓
session_end hook
  ├─ Extract facts from meetings
  ├─ Write session journal
  ├─ Queue self-improvement if conditions met
  └─ Clean up session state
```

## before_prompt: Context Injection

The `before_prompt` hook is the most important. It fires AFTER the user sends a message but BEFORE the prompt reaches Claude. This is Jarvis's opportunity to inject relevant context that will influence the response.

The hook receives the user's message and returns a `systemPrompt` string that gets prepended to the model's system prompt.

### Injection Blocks (in order)

**1. Date and Time Header**
- Current date/time in Chicago timezone, hostname, user context
- Why: The model needs to know the current moment and what machine it's running on (for file operations, relative date understanding)

**2. Routing Corrections (90-day window)**
- Past corrections applied to routing decisions, deduplicated keeping the most recent per correction type, capped at 50
- Why: Jarvis learns from corrections. If the user said "No, use admin for that," the next similar request should route correctly without re-asking

**3. Feedback Corrections and Preferences (90 days)**
- User-provided corrections to past replies, stated preferences, and satisfaction ratings (14-day mean)
- Why: These are durable learnings about tone, style, and behavior expectations

**4. Chain Hints (handoff patterns, 90 days)**
- When Agent A handles a request, Agent B is often needed next. Extracted from `chain_miner` events
- Why: Multi-step requests route faster when Jarvis anticipates the second step

**5. Session Journal (recent notes)**
- Jarvis's own reflections from prior conversations in this session
- Why: Session continuity—the model can reference its own prior context without the user repeating it

**6. Recent Conversation Topics (last 36 hours)**
- Raw snippets of user messages from substantive sessions, not semantic embeddings
- Why: When asked "what did we discuss last night?", Jarvis needs the actual conversation text, not a vector search that might miss the exact context

**7. Conversation Digest (daily/weekly)**
- Structured summary of yesterday's session or this week's topics
- Why: High-level continuity across days and weeks without consuming memory slots

**8. Other Claude Code Sessions (cross-tab awareness)**
- Digest of what other Claude Code sessions on this machine are working on
- Why: Prevents duplicate work and enables coordination across parallel sessions

**9. Working Memory (last 4 hours)**
- Hot context from active findings, if `working_memory_enabled` is true
- Why: Short-lived, relevant details that are too recent for long-term memory but too important to forget mid-session

**10. Open Threads**
- "Where were we?" continuity—unresolved topics from prior sessions
- Why: Prevents context loss when returning to long-running projects after days

**11. Recalled Memories**
- User profile (preferences, clarifications) — always injected
- Knowledge (high-confidence facts) — always injected
- Knowledge (low-confidence facts) — injected only if budget allows
- Procedural (skills learned from prior tool use)
- Knowledge graph relationships (entity facts)
- Why: These are the model's understanding of the user and the world. Profile and high-confidence facts are core identity; low-confidence and procedural are opportunistic "nice to have" if space permits

**12. Pending Brief (morning brief)**
- If a brief was scheduled but not yet delivered
- Why: Briefing is a proactive routine task that must interrupt the normal flow

**13. Pending Reminder (scheduled notification)**
- If a reminder fired during the session
- Why: Scheduled reminders take priority over normal conversation

**14. Decision Stakes Analysis**
- Injected when the user's message contains decision keywords ("should", "decide", "pick", "choose")
- Activates a Devil's Advocate lens to flag risks
- Why: High-stakes decisions benefit from explicit risk analysis rather than going with the first plausible answer

**15. Discord Bot Health Warning**
- Alerts if the Discord approval bot is offline and approvals are pending
- Why: Visibility into blocking infrastructure

**16. Health Warnings (tail of context)**
- Warns if vec-server or Ollama are unreachable
- Why: The model needs to know memory recall or local models may fail, so it can handle gracefully

**17. Persona Audit / Banned Token Enforcement**
- Two injections: one at the top (after soul), one at the tail as a `<reminder>` block
- Includes turn-aware em-dash escalation after turn 4 (when model attention has drifted)
- Why: Static early constraints lose salience as context grows. The tail reminder keeps persona compliance front-of-mind

### Why Parallel Recall?

Memory recall (`recallMeta` for user_profile, knowledge, procedural) runs in parallel via `Promise.all()`. This is intentional:
- User is waiting for a response. Sequential recalls would add latency.
- These four queries are independent; parallelism is safe.
- The hook has a 10-second overall timeout. Parallel saves time.

### Why Fire-and-Forget Gap Detection?

After assembling the system prompt, the hook spawns two async functions that run without blocking:
- `detectGapForMessage()` — identifies what the model might miss and queues a clarification for the next turn
- `detectRoutingCorrection()` — checks if this turn's message contradicts a prior routing decision and logs the correction

These don't block the return because:
- They're post-decision; the model won't read them this turn
- If they fail, the turn was still successful
- Errors are logged but don't fail the conversation

## turn_end: Post-Turn Processing

The `turn_end` hook fires AFTER the assistant reply is complete but BEFORE tools execute. This is the moment to capture and process the response.

**Sequence:**

1. **Log assistant reply to episodic store and session journal**
   - Why: Creates a persistent record of what was said for future recall and session journals

2. **Audit reply for persona violations**
   - Check for banned tokens, em dashes, "certainly", "of course", etc.
   - Log violations with turn number
   - Why: Drift detection. If violations appear, the persona enforcement is weakening and needs escalation

3. **Voice synthesis (fire-and-forget, 5s timeout)**
   - POST reply text to voice-tts server for Kokoro TTS
   - Why: Audio output for the UI. Non-blocking because voice playback doesn't affect the conversation outcome.

4. **Graph ingest (fire-and-forget, async)**
   - Extract entities and relationships from the user message and reply, store in Neo4j
   - Why: Build a knowledge graph for structured fact retrieval. Non-blocking because it enriches future context but doesn't change this turn's output.

5. **Memory correction → Extraction → Concrete values (fire-and-forget, chained async)**
   - `detectMemoryCorrection()` — if the reply contradicts a stored fact, archive the old fact
   - `extractAndStore()` — extract new facts and store them in ChromaDB with confidence scoring
   - `extractConcreteValues()` — a second pass that captures precise values (dates, amounts, names) the model mentioned
   - Why: These are the learning mechanisms. Running them async allows the turn to complete while memory ingestion happens in parallel.

### Why turn_end Before Tools?

The hook fires BEFORE tools execute in ion's runloop. This is crucial because:
- The assistant's reply text must be captured BEFORE tool results arrive and possibly change state
- If we waited for tool_end, the reply might be lost
- Tools depend on the conversation state being finalized first

## turn_start: Post-Tool Cleanup

The `turn_start` hook fires at the BEGINNING of the NEXT LLM call. This is AFTER all tools from the prior turn have finished executing.

**What it does:**

1. **Record turn number** so `before_prompt` can read it for escalating reminders
2. **Mark dispatched agents as done** in the session agent map
3. **Emit sidebar update** so the UI reflects that agents are complete

### Why turn_start for Agent Resolution?

Agent dispatch is fire-and-forget. When Jarvis calls `runClaudeAgent('admin', ...)`, that agent starts in a separate ion session and runs to completion. The original conversation doesn't wait.

The agent completion signal comes indirectly: when the user sends another message, `turn_start` fires for the next turn. At that point, all prior tools are done, so agents can be marked complete.

For single-shot dispatches (user sends a message, agent runs, user doesn't send a follow-up), a watchdog timer in the `tool_end` hook ensures agents are flipped to done after 2 seconds of inactivity.

## session_start / session_end

**session_start:**
- Log that the session began
- Clean stale subprocesses from prior crashes
- Discover available agents (staff and user-defined)
- Set scheduler context (needed by the proactive routines)

**session_end:**
- Extract facts from any meetings that occurred in this session
- Write the session journal (user-provided notes stored in episodic SQLite)
- Queue self-improvement if conditions are met:
  - Session was long (>8 messages)
  - Session was tool-heavy (>=5 tool calls)
  - A routing correction occurred (learning opportunity)
- Clean up session state

## Tool Pipeline Hooks

**tool_start:**
- Fires BEFORE tool execution
- Detects if the tool is the Agent tool (dispatching a staff member)
- Creates a placeholder entry in the agent sidebar with a generic display name
- Why: The UI needs visibility that an agent is running, even before we know which agent

**tool_call:**
- Fires AFTER the tool input is fully parsed
- Updates the placeholder entry with the actual agent name (staff member ID)
- Logs the dispatch to episodic events
- Why: By this point, ion has extracted the `subagent_type` from the input, so we can show the real name

**tool_end:**
- Fires after each tool result
- Checks if running agents exist and schedules a 2-second watchdog debounce
- Why: For single-shot dispatches, this is the safety net. If `turn_start` doesn't fire (user doesn't send a follow-up), the watchdog ensures agents aren't left in "running" state forever

**permission_classify:**
- Tool-permission hook that assigns tiers to tools
- Jarvis returns pre-configured tiers (e.g., `mail_send` is MODERATE, `run_shell` is HIGH)
- Why: ion uses these to decide whether to auto-allow, ask, or deny a tool call

**permission_denied:**
- Fires when a tool is denied by the permission system
- Logs the denial and sends a system message to the user
- Why: Transparency—the user knows why a tool was blocked

## The Fire-and-Forget Pattern

Many expensive operations in `turn_end` and `session_end` run asynchronously without blocking:
- Voice synthesis
- Graph ingest
- Memory extraction
- Meeting extraction
- Self-improvement queueing

**Why this pattern?**

1. **User is waiting** — synchronous processing adds perceived latency
2. **These operations are post-decision** — they enrich future context but don't change the current response
3. **Failure tolerance** — if voice fails, the conversation still succeeded. Errors are logged but don't cascade.
4. **Resource efficiency** — I/O operations (network, disk) can overlap instead of serializing

**Error handling:**
All fire-and-forget operations have `.catch((err) => log.warn(...))` to ensure errors are visible in logs without breaking the conversation.

## State Management Across Hooks

Hooks maintain shared state in TypeScript Maps to communicate across callback invocations:

**lastReply, lastUserMessage:**
- Cached in `turn_end` so `session_end` and other hooks can access them
- Why: These are ephemeral per-turn; caching avoids re-reading from the database

**sessionAgents:**
- Map of agent ID to agent state (name, display name, status: running/done)
- Updated by `tool_start` (create), `tool_call` (rename), `tool_end` watchdog (flip to done), and `turn_start` (flip to done)
- Emitted to the UI after each update
- Why: Sidebar UI needs real-time visibility of which agents are active

**sessionTurnNumber:**
- Incremented per turn, read in `before_prompt` to escalate persona enforcement after turn 4
- Why: Model attention drifts; later turns need stronger reminders about constraints

**clarificationManager:**
- Keyed by session, holds pending clarification questions
- Resolved in `before_prompt` when the user answers
- Why: Enables multi-turn clarification loops without user confusion

## Integration with Other Systems

Hooks do not own behavior. They are purely observational and injective:
- They inject context and collect telemetry into episodic/ChromaDB
- They call out to sub-systems (`vec-server`, voice-tts, graph ingestion) which own their own logic
- They never make routing, approval, or policy decisions
- Decision logic lives in separate modules (`learning.ts`, `scheduler/`, `improve/`)

For example, `turn_end` calls `extractAndStore()` which lives in `learning.ts`. The hook merely invokes it fire-and-forget; `learning.ts` owns the extraction algorithm and confidence scoring.
