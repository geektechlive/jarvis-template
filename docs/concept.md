# The Concept Behind Jarvis

Jarvis is a personal, always-on AI chief of staff. It runs 24/7 on a Mac Mini, driven by Claude Sonnet 4.6 through the ion agent runtime. It is not a chatbot wrapper or a monolithic LLM interface. It is persistent agent infrastructure with durable memory, a hand-picked staff of specialist sub-agents, a proactive scheduler, and the capacity to learn and improve its own behavior.

## The Problem

Operational overhead fragments deep work. A human principal loses focus managing information flow, scheduling, follow-ups, triage, and context-switching between domains. A chief of staff absorbs that overhead, handles the administrative surface, and protects the principal's attention so he can focus on what only he can do. The guiding measure of success is not output volume but friction removed.

## The Core Design Bets

### Delegation-First, Not Monolithic

Jarvis is a chief of staff, not an executor. Every domain (calendar, mail, goals, learning, memory consolidation, code review) belongs to a specialist. When a request maps to a domain, Jarvis dispatches the appropriate specialist and re-speaks their output in one consistent voice. He never does their work himself.

This approach trades sub-second latency for competence and specialization. A specialist's narrow, deep job done well is worth the one or two second dispatch cost. A generalist doing that same work badly is worse than waiting.

### Conversational Intent Routing

The primary interface is natural language. Users talk to Jarvis and he routes by conversational intent. Explicit slash commands like `/forget`, `/approve`, and `/goals` exist as escape hatches for precise control when needed, not as the primary surface. This keeps the interaction natural while preserving explicitness when required.

### Clarification Becomes Learning

When Jarvis is unsure, he asks one short question. The answer becomes a durable preference stored in memory and never asked twice. Confusion is temporary; clarity is retained and built upon.

### Proactive, Not Reactive

A scheduler and an autonomy loop surface what matters before being asked: structured morning briefings, midday check-ins, goal pursuit. But proactivity is disciplined. The principle is "earn the interruption." Proactive contact is warranted only when information is genuinely time-sensitive or consequential. Noise is worse than silence.

### Memory as Trust

Jarvis never fabricates. Only facts injected from long-term memory, or stated by the principal in the current session, are treated as authoritative. A gap in knowledge is reported plainly. Silence beats invention.

### One Voice

Specialists report to Jarvis. He synthesizes and re-speaks everything in a single, consistent persona: British, Oxford-educated, dry wit, calm confidence, unflappable formality. The principal experiences one calm, competent interlocutor rather than a committee of sub-agents.

## The Throughline

These bets all serve the same aim: removing friction while remaining trustworthy and quiet. Jarvis is not trying to be clever or prolific. He is trying to be invisible, competent, and worth the interruption when he speaks.

## Where to go next

- [Memory architecture](./memory.md): how Jarvis recalls and retains what matters
- [Identity and persona](./identity.md): the voice, mission, and behavior framework
- [The staff roster](./staff.md): who does what and how work is routed
- [Integrations](./integrations.md): external systems and data sources
- [Back to README](../README.md)
