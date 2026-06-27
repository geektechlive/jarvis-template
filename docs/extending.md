---
title: Extending Jarvis
description: Step-by-step guides for adding tools, slash commands, staff agents, and scheduled routines.
sidebar_position: 19
---

# Extending Jarvis

This guide walks you through the four primary ways to extend Jarvis: adding ion tools (LLM-callable functions), slash commands (typed `/command` triggers), staff agents (domain specialists), and scheduled routines (proactive tasks).

Every example is extracted from the working codebase.

---

## Guide 1: Adding an Ion Tool

An **ion tool** is a function the LLM can call from within a Jarvis session. Tools are the bridge between reasoning and action.

**Key rule: scripts-first.** For most capabilities, write a script in `scripts/` and call it from the tool's execute function. Only add a tool if you need LLM-callable access to parameterized logic. See the `registerTools()` comment at the top of `harness-ts/src/registrations/tools.ts` for why.

### Step 1: Write the function

Create a new file in `harness-ts/src/tools/mytool.ts`:

```typescript
// harness-ts/src/tools/mytool.ts
export async function myToolLogic(param: string): Promise<string> {
  // Your implementation here
  return `Result: ${param}`
}
```

### Step 2: Register it

Add the tool to `harness-ts/src/registrations/tools.ts`:

```typescript
import { myToolLogic } from '../tools/mytool'

export function registerTools(ion: IonSDK): void {
  // ... existing tools ...

  ion.registerTool({
    name: 'my_tool_name',
    description: 'What this tool does and when to use it.',
    parameters: {
      type: 'object',
      properties: {
        param: { type: 'string', description: 'Input parameter description.' },
      },
      required: ['param'],
    },
    execute: async (params) => {
      const result = await myToolLogic(params['param'] as string)
      return { content: result }
    },
  })
}
```

Tools registered here follow the pattern from `recall_memory` (line 34-56):
- `name`: kebab-case identifier
- `description`: one sentence explaining when to use it
- `parameters`: JSON Schema describing inputs
- `execute`: async function that receives params and returns `{ content: string }`

### Step 3: Deploy

```bash
make deploy-jarvis
```

### Step 4: Test

In a Jarvis session:

```
Use my_tool_name to do something with "test input".
```

Jarvis will call the tool. Monitor `/var/log/system.log` on Mini for any errors:

```bash
ssh mini "tail -f ~/.ion/engine.log | grep -i my_tool"
```

---

## Guide 2: Adding a Slash Command

A **slash command** is a typed `/command` trigger that executes custom logic. Unlike ion tools, slash commands are dispatched only from Ion Desktop or iOS, not from the CLI.

### Step 1: Create a command file

Create `harness-ts/src/registrations/commands/mycommand.ts`:

```typescript
// harness-ts/src/registrations/commands/mycommand.ts
import type { IonSDK } from '../../../vendor/ion-sdk'
import { logEvent } from '../../memory/episodic'

export function registerMyCommands(ion: IonSDK): void {
  ion.registerCommand('my-command', {
    description: 'What /my-command does. Usage: /my-command <args>',
    execute: async (args) => {
      const text = args.trim()
      if (!text) {
        logEvent('my-command', 'inbox_item', { 
          routine: 'my-command', 
          text: 'Usage: /my-command <args>' 
        })
        return
      }
      // Your logic here
      const result = `Processed: ${text}`
      logEvent('my-command', 'inbox_item', { 
        routine: 'my-command', 
        text: result 
      })
    },
  })
}
```

This pattern is from `harness-ts/src/registrations/commands/memory.ts` (lines 7-48):
- `ion.registerCommand(name, { description, execute })`
- `execute` receives the trailing text after the command (e.g., `/my-command foo bar` → `args = "foo bar"`)
- Use `logEvent(name, 'inbox_item', ...)` to write results to the inbox so they appear in Ion Desktop/iOS

### Step 2: Add to the command registry

Edit `harness-ts/src/registrations/commands/index.ts`:

```typescript
import { registerMyCommands } from './mycommand'

export function registerAllCommands(ion: IonSDK): void {
  registerMemoryCommands(ion)
  registerWorkflowCommands(ion)
  registerMyCommands(ion)  // Add this line
  // ... other command registrations ...
}
```

### Step 3: Deploy

```bash
make deploy-jarvis
```

### Step 4: Test

Open Ion Desktop or the iOS app and type:

```
/my-command test input
```

The result will appear in your inbox. Note: `ion prompt` CLI does NOT dispatch slash commands. Use Ion Desktop or iOS.

---

## Guide 3: Adding a Staff Agent

A **staff agent** is a domain specialist that Jarvis delegates work to. Staff agents have their own specs, model assignments, and tool access. They appear in `/list-staff` and are routable via intent matching in `harness/identity/BEHAVIOR.md`.

### Step 1: Write the agent spec

Create `harness/agents/my-agent.md`:

```markdown
---
name: my-agent
description: Agent title and one-line mission.
tools: Read, Bash, WebSearch
model: claude-haiku-4-5-20251001
color: blue
---

You are the Domain Specialist on Jarvis's staff. Jarvis is the Chief of Staff and your boss.

## Position summary

Who you are and what you own. One paragraph.

## Responsibilities

- Task area 1
- Task area 2
- Task area 3

## Typical tasks

- "What would a user ask you to do?"
- "Another task example"

## What good looks like

- Concrete criteria for a good outcome
- Specificity over vagueness
- Quantifiable if possible

## Anti-patterns (do not)

- What not to do
- Boundaries you respect
```

This format follows `harness/agents/admin.md` (lines 1-43):
- Frontmatter: `name`, `description`, `tools`, `model`, `color`
- Sections: Position summary, Responsibilities, Typical tasks, What good looks like, Anti-patterns

### Step 2: Add to staff.yaml

Edit `harness/config/staff.yaml` and add an entry:

```yaml
  - id: my-agent
    title: Domain Specialist
    status: active
    specialties:
      - area 1
      - area 2
    when_to_call:
      - "task example 1"
      - "task example 2"
    model_key: haiku  # or another model_key from models.yaml
    color: blue
    tools:
      - read_file
      - web_search
    system_prompt_template: |
      You are the Domain Specialist on Jarvis's staff.
      [Agent instructions...]
```

The `model_key` must exist in `harness/config/models.yaml`. Common values: `haiku`, `sonnet_cli`, `research`. The `tools` are MCP tools (e.g., `read_file`, `web_search`) and ion-registered tools (e.g., `mcp__ion-extensions__recall_memory`).

### Step 3: Deploy

```bash
make deploy-jarvis
```

This copies your agent spec to `~/.claude/agents/` on Mini so Claude Code can load it.

### Step 4: Test

Verify the agent appears:

```
/list-staff
```

You should see your agent in the roster. To test delegation, add an intent rule to `harness/identity/BEHAVIOR.md` that routes to your agent, then trigger a matching prompt in Jarvis.

---

## Guide 4: Adding a Scheduled Routine

A **routine** is a proactive task that runs on a schedule (daily, weekly, or at an interval). Routines fire at specified times and deliver their output to the inbox or Discord.

### Step 1: Add to routines.yaml

Edit `harness/config/routines.yaml` and add a new routine entry:

```yaml
routines:
  my_daily_routine:
    enabled: true
    ephemeral: true
    time: "14:30"  # 2:30 PM CT
    deliver_to: [tui]  # or [discord], [tui, discord]
    description: "What this routine does"
    prompt: "Ask Jarvis to do this thing every day at 2:30pm"

  my_weekly_routine:
    enabled: true
    ephemeral: true
    day: monday
    time: "08:00"
    deliver_to: [tui]
    description: "Weekly task"
    prompt: "What to do every Monday at 8am"

  my_interval_routine:
    enabled: true
    ephemeral: false
    interval_minutes: 30
    deliver_to: [discord]
    ignore_quiet_hours: true  # Fire even during quiet hours
    description: "Runs every 30 minutes"
    prompt: "What to run every 30 minutes"
```

Routine types from `harness/config/routines.yaml` (lines 20-50):

- **Daily**: `time` only. Fires at that time every day.
- **Weekly**: `day` and `time`. Fires on that day at that time.
- **Interval**: `interval_minutes`. Fires every N minutes (respects quiet hours unless `ignore_quiet_hours: true`).

Key fields:
- `enabled: true` — must be true to activate
- `ephemeral: true` — extractions go to task_memory instead of knowledge
- `deliver_to: [tui]` — inbox delivery; `[discord]` posts to Discord; `[tui, discord]` does both
- `prompt: "..."` — the exact text sent to Jarvis at trigger time

### Step 2: Deploy

```bash
make deploy-jarvis
```

The scheduler reads `routines.yaml` on each turn.

### Step 3: Test

For immediate testing, fire a routine on-demand:

```
/run-now my_daily_routine
```

Or check the scheduler logs:

```bash
ssh mini "tail -f ~/.ion/engine.log | grep my_daily_routine"
```

---

## Troubleshooting

### Tool not callable by LLM

- Verify the tool is registered in `harness-ts/src/registrations/tools.ts`
- Run `make deploy-jarvis`
- Check `~/.ion/engine.log` on Mini for errors during extension startup
- Tools work only from Claude Sonnet sessions (not CLI `ion prompt`)

### Slash command not dispatching

- Slash commands only work in Ion Desktop or iOS app, never in `ion prompt` CLI
- Verify the command is registered in `harness-ts/src/registrations/commands/index.ts`
- Check that `logEvent()` is called with `'inbox_item'` type so output appears in the inbox

### Staff agent doesn't appear in /list-staff

- Verify the spec file exists at `harness/agents/my-agent.md` with correct frontmatter
- Run `make deploy-jarvis` to copy specs to `~/.claude/agents/` on Mini
- Check that `status: active` in `staff.yaml`
- Verify `model_key` exists in `harness/config/models.yaml`

### Routine not firing

- Check that `enabled: true` in `routines.yaml`
- Verify the time/day/interval syntax is correct
- Check if you're in quiet hours (default 23:00 to 06:00) — interval routines skip unless `ignore_quiet_hours: true`
- Monitor the scheduler: `ssh mini "tail -f ~/.ion/engine.log | grep scheduler"`

---

## Next Steps

- Read `harness/identity/BEHAVIOR.md` to understand intent routing and when to add delegation rules
- Check `harness/config/models.yaml` to see available models and their role assignments
- Review `harness/agents/` for examples of agent specs with different focus areas
- Explore `harness-ts/src/tools/` to see how existing tools are implemented
