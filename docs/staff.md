---
title: Staff System
description: 27-member specialist roster with intent-based dispatch. How routing works, why automatic routing is not used, and the architecture of staff agents versus workers.
sidebar_position: 7
---

# Staff System

Jarvis is a chief of staff, not a do-everything assistant. Every domain belongs to a specialist. When the principal makes a request that maps to a domain, Jarvis dispatches that specialist, then re-speaks their output in his own voice. To the principal, it still feels like one calm interlocutor, because Jarvis synthesizes everything before responding. The dispatch latency is treated as a feature: a specialist's job done badly by a generalist is worse than dispatching and waiting.

## Why Routing Is Not Automatic

This is the most important section. **Routing is intent-based reasoning by Jarvis, not a hardcoded keyword matcher.** The `when_to_call` field in `staff.yaml` is documentation for `/list-staff`, not trigger conditions.

**Why?** An automatic router using `staff.yaml` as a configuration file would add a classification layer to every message. A lightweight classifier (LLM or heuristic) would run first, decide who to route to, then dispatch that agent. This adds latency and decision-making to a path that should be as fast as possible.

Instead, Jarvis (running on Claude Sonnet 4.6) interprets the incoming request directly and decides who to call. Claude is vastly better at contextual routing than a lightweight classifier. When Jarvis answers something himself that should have gone to a specialist, a routing-correction signal is logged, and future turns receive a hint to dispatch the right specialist next time. This feedback loop is more effective than hardcoded rules.

**Routing rules live in `BEHAVIOR.md`.** That file defines hard delegation rules and is injected into Jarvis's system prompt at session start. It is the source of truth for when Jarvis must dispatch, when he may answer directly, and what constitutes domain encroachment.

## The 27-Member Roster

All staff members are listed in `harness/config/staff.yaml` (source of truth for the roster). Each has a full behavioral spec in `harness/agents/*.md`. Status can be `active` (routable) or `draft` (excluded from routing).

| ID | Title | Model | Specialties |
|:---|:------|:------|:-----------|
| `researcher` | Research Analyst | Haiku | Research, fact-finding, topic briefs, source analysis, image lookup, package tracking |
| `writer` | Communications Writer | Haiku | Drafting emails, blog posts, summaries, content creation |
| `eng_lead` | Engineering Lead | Sonnet | Architecture, code review, technical decisions, engineering routing |
| `dev_backend` | Backend Developer | Sonnet | Python, Node.js, APIs, databases, server-side systems |
| `dev_frontend` | Frontend Developer | Sonnet | React, Astro, CSS, TypeScript, web UI components |
| `dev_infra` | Infra Developer | Sonnet | Deployment, daemons, shell scripting, CI/CD, launchd |
| `news_desk` | News Desk | Haiku | Current events, headlines, news digests |
| `repo_steward` | Repo Steward | Haiku | GitHub repositories, PRs, issues, branch hygiene |
| `tech_advisor` | Technology Advisor | Sonnet | Vendor evaluation, X-vs-Y decisions, architecture tradeoffs |
| `reflection_analyst` | Reflection Analyst | Sonnet | Memory curation, pattern detection, gap detection, user profile commitment |
| `admin` | Administrative Assistant | Haiku | Calendar, scheduling, daily briefs, file lookups, task tracking |
| `chief_of_communications` | Chief of Communications | Sonnet | Mail triage, outbound review, iMessage, Bluesky, voice fidelity, escalation |
| `observability_watcher` | Observability Watcher | Default (Haiku) | Mini service health, daemon status, log analysis, routine verification |
| `knowledge_curator` | Knowledge Curator | Default (Haiku) | Memory hygiene, duplicate detection, contradiction surfacing |
| `personal_cfo` | Personal CFO | Default (Haiku) | Subscriptions, recurring bills, spending, expense categorization, order confirmations |
| `security_analyst` | Security Analyst | Sonnet | Breach monitoring, dependency CVEs, secret leak detection, OSINT |
| `security_advisor` | Security Advisor | Sonnet | Security architecture review, threat modeling, prompt-injection and trust-boundary review, security tooling |
| `wellness_coach` | Wellness Coach | Default (Haiku) | Wellbeing check-ins, calendar density, mood/energy signals, health data |
| `entertainment_advisor` | Entertainment Advisor | Haiku | Media recommendations, taste profile, TV/film/music/books/comics |
| `devils_advocate` | Devil's Advocate | Default (Haiku) | Pre-commit critique, failure-mode analysis, assumption surfacing |
| `chief_of_strategy` | Chief of Strategy | Sonnet | Convening multi-specialty panels, shared-transcript discussion, synthesis |
| `portfolio_manager` | Portfolio Manager | Sonnet | Investing, stock research, buy/sell/hold calls, holdings tracking |
| `doc_steward` | Document Steward | Default (Haiku) | File search, Downloads triage, iCloud Drive state, organization |
| `contacts_manager` | Contacts & Relationships Manager | Haiku | Relationship context, contact notes, interaction history |
| `systems_engineer` | Systems & Network Engineer | Default (Haiku) | Home network, Cloudflare zones, UniFi, firewall, site uptime |
| `legal_reviewer` | Legal Reviewer | Sonnet | Contract review, NDA review, clause analysis, obligation summary |
| `home_property` | Home/Property Manager | Sonnet | Appliance inventory, maintenance scheduling, service history |

## Model Assignment Rationale

**Sonnet roles (complex decisions, significant consequences):**
- Engineering: `eng_lead`, `dev_backend`, `dev_frontend`, `dev_infra` — architectural decisions and code production have downstream impact on user-facing reliability.
- Strategy: `chief_of_strategy`, `chief_of_communications`, `reflection_analyst` — domain routing and memory commit decisions shape long-term Jarvis behavior.
- Legal, financial, health: `legal_reviewer`, `portfolio_manager`, `home_property` — consequences of bad advice are material.
- Security: `security_analyst`, `security_advisor` — breach remediation, threat calibration, and trust-boundary review require frontier-model judgment.
- Specialist opinion: `tech_advisor` — vendor decisions compound over years.

**Haiku roles (research, production, review, drafts):**
- Research and writing: `researcher`, `writer`, `entertainment_advisor`, `contacts_manager` — produce draft material Jarvis reviews before acting.
- Operations: `admin`, `repo_steward`, `news_desk` — summarize existing state with high precision and low inference.
- Archive: `doc_steward`, `observability_watcher`, `wellness_coach`, `knowledge_curator`, `personal_cfo`, `devils_advocate` — log review, health checkups, contrarian analysis, duplicate detection.

**Trade-off:** Haiku at ~4 tokens per second is sufficient for draft material and summaries. Sonnet at ~20 tokens per second is worth the cost for decisions that compound.

## Special Cases

**The Devil's Advocate.** Her output is NOT re-spoken by Jarvis in his voice. When she surfaces failure modes or stress-tests a decision, Jarvis surfaces her as a deliberately distinct dissenting voice so the principal can weigh her concerns separately.

**The Chief of Strategy.** Unlike other staff who are dispatched in parallel isolation, the Chief of Strategy convenes 2-5 specialists into a shared markdown transcript when a question genuinely crosses domains and those staff would benefit from actually conferring — independent positions in round 1, peer review in round 2, synthesis in round 3. Sequential dispatch within a round; Edit conflicts are resolved by Jarvis before moving to the next round.

**The Reflection Analyst.** She is the sole authorized writer to the `user_profile` collection (contact facts, preferences, personal patterns about Alex). When a user profile fact surfaces mid-conversation, Jarvis says so in one line and hands it off: "Sam's contact is updated. The Reflection Analyst will commit this to memory." Jarvis does not call `remember_fact` for user profile facts himself — that is not his role.

## Staff vs. Workers (Two Tiers)

**Staff (27 active members)** are people-facing specialists in `harness/agents/` that handle requests with judgment. Each has domain authority and makes decisions within their specialty. They are routable by Jarvis directly.

**Workers (16 second-tier agents)** live in `harness/workers/` and are execution tools that staff dispatch for specific technical sub-tasks. Workers include: `code-reviewer`, `validator`, `test-writer`, `codebase-explorer`, `copy-editor`, `git-hygiene`, `research-worker`, `nextjs-worker`, `react-worker`, `swiftui-worker`, `typescript-worker`, `astro-supabase-worker`, `project-worker`, `orchestrator-planner`, `seo-specialist`, `ui-ux-reviewer`.

Workers are not routed to directly by Jarvis. They do not have domain authority. They are the hand tools staff pick up to execute. Example: the Engineering Lead might dispatch the `code-reviewer` worker to assess a pull request, but only the Engineering Lead decides whether to act on that review.

## Staff Findings Queue

Staff agents report findings back to Jarvis through a separate SQLite database called `findings.db` (stored at `~/.jarvis/findings.db`, not in the main `conversations.db`). This queue is the canonical channel for staff to surface information that requires Jarvis's decision-making or the principal's immediate attention.

**Why a separate database.** The `agent_events` table is a high-volume append-only event log. Findings need different semantics: each finding must be delivered exactly once, and only after a delivery decision has been made. A separate table with claim fields (`claim_id`, `claim_at`, `attempt_count`, `blocked`) supports safe deduplication and retry logic without cluttering the event stream.

**Three criticality levels:**
- **CRITICAL** (e.g., security breach, payment failed, system outage) — routed immediately to phone push; requires synchronous delivery.
- **IMPORTANT** (e.g., CVE in a dependency, meeting in 30 minutes, contract issue) — queued for the next brief or pending_briefings batch; async delivery is acceptable.
- **INFORMATIONAL** (e.g., weekly health check passed, code style audit complete, subscription renewed) — accumulated and delivered in the daily evening journal or next morning brief.

This split respects urgency without saturating the principal with notifications.

**Claim semantics for reliability.** When the dispatcher routine picks up a finding to deliver, it atomically claims it with `atomicClaim()`. If delivery succeeds, the finding is marked processed. If the dispatcher crashes mid-delivery, `reclaimStale()` recovers the claim after 5 minutes, allowing another dispatcher run to retry. After 3 failed attempts, the finding is auto-blocked and logged for manual review.

**How staff use it.** Staff agents call the `surface_to_inbox` tool (which invokes `addFinding()` under the hood) to deposit findings. The dispatcher routine (`harness-ts/src/inbox/`) drains pending findings every 60 seconds and routes by criticality to either immediate push or the next available brief window.

This architecture ensures staff can report without knowing delivery details, and Jarvis has a reliable channel to aggregate and route specialist intelligence.

## Agent Spec Format

Each staff agent has a markdown spec at `harness/agents/{id}.md` following this structure:

```markdown
---
name: admin
description: Administrative Assistant. Dispatch for calendar...
tools: Read, Bash, WebSearch, calendar_create_event
model: claude-haiku-4-5-20251001
color: white
---

## Position summary
## Responsibilities
## Typical tasks
## What good looks like
## Anti-patterns (do not)
## Method
## Reporting to Jarvis
```

The spec tells Claude Code:
- **Position summary:** What is this role in the org.
- **Responsibilities:** Hard domain boundaries.
- **Typical tasks:** Examples Jarvis will recognize and dispatch on.
- **What good looks like:** Quality bar and output format.
- **Anti-patterns:** Common mistakes to avoid (e.g., the Admin tries to run mail-check himself).
- **Method:** How to use tools, precedence rules, decision trees.
- **Reporting:** How to talk to Jarvis (be precise; tone is his job).

**Why specs are Markdown, not YAML config.** YAML can express tool lists and model assignments, but not the narrative reasoning, context sensitivity, and failure-handling logic that makes an agent actually work. Markdown specs are human-readable narrative (for code review and onboarding) and machine-readable headings (Claude Code can parse them reliably). They live in git alongside the orchestration code.

## Deployment: How Specs Reach Claude Code

Specs live in the repo at `harness/agents/` and `harness/workers/`. The `make deploy-jarvis` target copies them to `~/.claude/agents/` on the Mini:

```bash
# Inside make deploy-jarvis:
cp -f harness/agents/*.md ~/.claude/agents/
cp -f harness/workers/*.md ~/.claude/agents/
```

**Why this copy step is critical.** Claude Code reads agent specs from `~/.claude/agents/`, not from the repo directly. If you edit `harness/agents/admin.md` locally and `git push` but forget to run `make deploy-jarvis`, Claude Code on the Mini is still using the old spec. Symptom: staff agent runs with stale behavior (e.g. trying to use a tool that no longer exists). Always deploy after agent spec changes.

## The BEHAVIOR.md Dispatch Rules

`harness/identity/BEHAVIOR.md` is the source of truth for when Jarvis must dispatch, when he may answer directly, and what constitutes domain encroachment. Key rules:

- **Calendar, scheduling, daily briefs, task lists, action items** → Administrative Assistant (Jarvis does not query Calendar.app directly).
- **Mail, email, iMessage, SMS, Bluesky** (read, search, draft, send, summarize, urgent escalation) → Chief of Communications (Jarvis does not call IMAP or `send_imessage` directly even though it's in his toolbox).
- **File management, document search, Downloads, iCloud Drive** → Document Steward (Jarvis does not run Bash for file queries).
- **Research, fact-finding, briefs, source analysis, image/photo search** (any domain) → Research Analyst (Jarvis does not run WebSearch himself for a research question).
- **Drafting copy, editing, writing emails or blog posts** → Communications Writer (Jarvis does not write polished prose himself).
- **Architecture, code review, engineering routing** → Engineering Lead.
- **Backend/frontend/infra code** → dev specialists (routed via Engineering Lead).
- **News, current events, headlines** → News Desk (Jarvis does not summarize news himself).
- **GitHub repo state, PRs, issues** → Repo Steward (Jarvis does not run `gh` himself).
- **Vendor evaluation, X-vs-Y decisions, technology tradeoffs** → Technology Advisor (scope: cloud services, developer platforms, CI/CD tooling, databases-as-a-service only).
- **User profile facts** (contact info, preferences, personal patterns) → Reflection Analyst (Jarvis does not call `remember_fact` for user profile himself).
- **Mini service health, daemon status, log analysis** → Observability Watcher.
- **Memory hygiene** (duplicates, contradictions, staleness) → Knowledge Curator.
- **Subscriptions, bills, spending, receipts, order confirmations** → Personal CFO.
- **Breach monitoring, CVE scanning, secret leaks** → Security Analyst.
- **Wellbeing, calendar density, health data** → Wellness Coach (Jarvis does not interpret health data himself).
- **Pre-commit critique, stress-testing** → Devil's Advocate (surface as a distinct voice).
- **Cross-specialty panels** → Chief of Strategy (convenes 2-5 staff into a shared transcript).
- **Entertainment and media** (recommendations, taste, watchlist) → Entertainment Advisor (Jarvis does not recommend media himself).
- **Investing, portfolio, buy/sell/hold** → Portfolio Manager (Personal CFO is his peer for spending; separate domains).
- **Contact lookup, relationship context** → Contacts & Relationships Manager.
- **Home network, cloud infrastructure, device connectivity** → Systems & Network Engineer (home IT, not dev deployment work).
- **Contract review, legal red-flags, NDA analysis** → Legal Reviewer (Jarvis does not opine on legal text himself).
- **Home maintenance, property, appliances** → Home/Property Manager.

When in doubt: delegate. A specialist's careful answer is worth the wait.

## Where to Go Next

- `./concept.md` — Conceptual overview of Jarvis's architecture.
- `./memory.md` — How Jarvis stores and recalls information.
- `./identity.md` — The Jarvis persona and communication style.
- `./integrations.md` — Connected systems (mail, calendar, GitHub, etc.).
- `../README.md` — Project root and getting started.
