# docflow — Document-Driven Kanban for Pi

A pi extension that combines document-first-wf's **document generation & linking** with **session tracking & kanban boards** — no phase gates, no ceremony, lightweight and automatic.

---

## Why Pi Changes Everything

Both source tools depend on **Pi coding agent hooks** (SessionStart, SessionEnd, etc.) which pi doesn't have. But pi's event system gives us better primitives:

| Source tool feature / document-first-wf | pi equivalent |
|-----------------------------------------|--------------|
| Session hook: SessionStart | `pi.on("session_start")` |
| Session hook: SessionEnd | `pi.on("agent_end")` or `pi.on("turn_end")` — detect inactivity |
| Session hook: UserPromptSubmit | `pi.on("context")` — runs before every LLM call |
| Session hook: Stop | `pi.on("session_shutdown")` |
| Background reconciler via launchd | **Not needed** — pi is event-driven; every action triggers updates immediately |
| Slash commands via Pi coding agent | `pi.registerCommand()` |
| Skills | `pi.registerTool()` with `promptGuidelines` + `before_agent_start` injection |

**Key insight:** We don't need a background reconciler at all. Pi events are synchronous — when the user runs a command or the agent calls a tool, we update everything immediately.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                     Shared Obsidian Vault                     │
│                                                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────┐  │
│  │ README.md │  │ Plan.md  │  │Design.md │  │Decisions.md│  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └─────┬──────┘  │
│       │              │             │              │          │
│  ┌────┴──────────────┴─────────────┴──────────────┴──────┐  │
│  │              Wikilink Graph (Obsidian)                  │  │
│  └────┬──────────────────────────────────────────────────┘  │
│       │                                                      │
│  ┌────┴──────────────┬────────────────────────────────────┐ │
│  │  Tasks.md          │  Sessions.md                       │ │
│  │  (Kanban board)   │  (Session lifecycle)               │ │
│  └────┬──────────────┴────────────────────────────────────┘ │
│       │                                                      │
│  ┌────┴────────────────────────────────────────────────────┐ │
│  │              _Context.md (auto-generated)                │ │
│  │           Loaded by before_agent_start                  │ │
│  └────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
                           ▲
                           │ file reads (on-demand)
                           │
┌──────────────────────────┼──────────────────────────────────┐
│                          │                                  │
│  Pi Extension            │  Agent events                    │
│                          │                                  │
│  ┌───────────────────┐   │  session_start                   │
│  │  Tools:           │   │  before_agent_start (briefing)   │
│  │  - docflow_read   │   │  context (inject docs)           │
│  │  - docflow_write  │   │  agent_end (track activity)      │
│  │  - docflow_task   │   │  session_shutdown                │
│  │  - docflow_plan   │   │                                  │
│  │  - docflow_design │   │  user_bash (optional capture)    │
│  │  - docflow_bug    │   │                                  │
│  │  - docflow_patch  │   │  tool_call / tool_result         │
│  │  - docflow_note   │   │  (intercept Pi coding agent docs writing) │
│  │  - docflow_status │   │                                  │
│  └───────────────────┘   │  commands                        │
│                          │  - /docflow-setup                 │
│                          │  - /docflow-project               │
│                          │  - /docflow-project-new           │
│                          │  - /docflow-status                │
│                          │  - /docflow-context               │
│                          │  - /docflow-list                  │
│                          └──────────────────────────────────┘
```

---

## Data Model

### Project

```typescript
interface Project {
  slug: string;
  name: string;
  createdAt: string;
  docStorage: "vault" | "repo";  // where project docs live
  vaultPath: string;              // used when docStorage === "vault"
  worktreePath: string;           // used when docStorage === "repo"
}
```

**Storage modes:**

| Mode | Location | Best for |
|------|----------|----------|
| `"vault"` (default) | `<vaultPath>/<slug>/` | Multi-repo projects, shared workspace |
| `"repo"` | `<repo-root>/docflow/<slug>/` | Single-repo projects, docs version-controlled with code |

Create with: `/docflow-project-new myproject "Name" repo` (appending `repo` switches to repo mode).

### Session (in-vault document)

```typescript
interface SessionCard {
  id: string;                    // sess-<timestamp>-<short-id>
  sessionId: string;             // pi session ID
  project: string;               // project slug
  status: "active" | "idle" | "stale" | "ended";
  startedAt: string;
  lastActivity: string;
  lastPrompt: string;
  branch: string;                // git branch
  cwd: string;
  claimedTask: string;           // wikilink [[TASK-001]]
  endedAt?: string;
}
```

### Task (in-vault document)

```typescript
interface TaskCard {
  id: string;                    // TASK-001
  status: "backlog" | "doing" | "blocked" | "done" | "archive";
  text: string;
  column: "Backlog" | "Doing" | "Blocked" | "Done" | "Archive";
  why?: string;                  // business reason
  implementation_hints?: string;
  test_approach?: string;
  definition_of_done?: string;
  estimates?: {
    original?: number;
    actual?: number;
  };
  sessions: string[];            // session IDs that worked on this
  blockedReason?: string;
  createdAt: string;
  updatedAt: string;
  // User-edited Backlog lines are opaque — reconciler won't touch them
}
```

### Decision

```typescript
interface DecisionEntry {
  id: string;                    // DEC-001
  date: string;
  phase: string;                 // "Planning", "Design", "Execution", etc.
  document: string;              // which doc this affects
  decidedBy: string;
  context: string;
  options: string[];
  decision: string;
  consequences: string[];
}
```

---

## Storage Layout

Documents live in **shared-vault** by default, but can be stored **in-repo** per project.

**Shared-vault** (default, `docStorage: "vault"`):
```
~/.pi/data/                                # Extension data
  config.json                              # vaultPath, projects, worktree-map

<vaultPath>/                               # Shared vault (rendered docs)
  _Index.md                                # Master rollup
  <slug>/
    README.md           # User-authored
    Plan.md             # Append-only via tool
    Design.md           # Append-only via tool
    Tasks.md            # Backlog: user; other columns: tool
    Sessions.md         # Session lifecycle
    Decisions.md        # Decision log
    _Context.md         # Auto-generated (tool writes)
```

**In-repo** (`docStorage: "repo"`):
```
<repo-root>/                         # alongside code, version-controlled
  <slug>/
    README.md
    Plan.md
    Design.md
    Tasks.md
    Sessions.md
    Decisions.md
    _Context.md
```

Create with: `/docflow-project-new <slug> <name> repo`
    Spikes/             # Focused investigations
    Patches/            # Hotfixes
    Bugs.md             # Bug register
```

---

## Tools (Registered with Pi)

### 1. `docflow_read` — Read project document

```typescript
parameters: {
  document: StringEnum(["readme", "plan", "design", "tasks", "sessions", "decisions", "context", "bugs", "index"]),
  project: Type.Optional(Type.String()), // defaults to current project
  section: Type.Optional(Type.String()), // optional section name
}
```

Reads a document from the shared vault. Used by:
- The briefing system (injects into context)
- Pi coding agent itself when it needs to read project docs
- User queries

### 2. `docflow_write` — Write/append to project document

```typescript
parameters: {
  document: StringEnum(["plan", "design", "decisions", "note"]),
  content: Type.String(),
  mode: StringEnum(["append", "overwrite"]) as const, // default: append
  project: Type.Optional(Type.String()),
}
```

Appends timestamped entries to Plan.md, Design.md, Decisions.md.
Overwrites allowed only for `_Context.md` (auto-generated).

### 3. `docflow_task` — Task management

```typescript
parameters: {
  action: StringEnum(["new", "claim", "done", "block", "list"]) as const,
  text: Type.Optional(Type.String()),
  reason: Type.Optional(Type.String()),
  project: Type.Optional(Type.String()),
}
```

Actions:
- `new` — create task in Backlog (or Doing if text given)
- `claim` — move Backlog task to Doing, attach session
- `done` — move claimed task to Done
- `block` — move claimed task to Blocked with reason
- `list` — show current task status

### 4. `docflow_session` — Session management

```typescript
parameters: {
  action: StringEnum(["status", "briefing"]) as const,
  project: Type.Optional(Type.String()),
}
```

- `status` — show current session's project, claimed task, activity
- `briefing` — generate context briefing (returns markdown)

### 5. `docflow_bug` — Bug tracking

```typescript
parameters: {
  action: StringEnum(["file", "list", "close"]) as const,
  description: Type.Optional(Type.String()),
  id: Type.Optional(Type.String()),
  project: Type.Optional(Type.String()),
}
```

### 6. `docflow_patch` — Hotfix tracking

```typescript
parameters: {
  action: StringEnum(["create", "list", "close"]) as const,
  description: Type.Optional(Type.String()),
  id: Type.Optional(Type.String()),
  project: Type.Optional(Type.String()),
}
```

### 7. `docflow_context` — Context index

```typescript
parameters: {
  project: Type.Optional(Type.String()),
}
```

Reads and regenerates `_Context.md` — the compact summary loaded by briefings.

---

## Commands (Slash Commands)

| Command | Handler | Purpose |
|---------|---------|---------|
| `/docflow-setup` | Interactive wizard | Set vault path, data dir |
| `/docflow-project <slug>` | Set current project | Assign to a project |
| `/docflow-project-new <slug> <name>` | Register project | Create project, seed docs |
| `/docflow-status` | Show status | Current project, session, tasks |
| `/docflow-context` | Show context | Display current briefing summary |
| `/docflow-list` | List tasks | Show task board for current project |

---

## Event Handlers (The Automation Engine)

### `session_start`

```typescript
pi.on("session_start", async (event, ctx) => {
  // 1. Detect project (3-layer resolution)
  // 2. Create session card in Sessions.md
  // 3. Load project context
  // 4. Inject briefing into next agent start
});
```

### `before_agent_start`

```typescript
pi.on("before_agent_start", async (event, ctx) => {
  // 1. Read _Context.md for current project
  // 2. Read latest Plan.md, Design.md
  // 3. Read open Tasks (Doing + Blocked)
  // 4. Read relevant Decisions
  // 5. Inject into event.message (system prompt injection)
});
```

### `context` (before every LLM call)

```typescript
pi.on("context", async (event, ctx) => {
  // 1. Update session last_activity timestamp
  // 2. If Pi coding agent wrote a doc, refresh _Context.md
  // 3. Update session status (active/idle/stale)
});
```

### `agent_end`

```typescript
pi.on("agent_end", async (event, ctx) => {
  // 1. Record last activity timestamp
  // 2. Update session card in Sessions.md
  // 3. If this was a long gap, update status
  // 4. Update _Context.md cache
});
```

### `session_shutdown`

```typescript
pi.on("session_shutdown", async (event, ctx) => {
  // 1. Mark session as "ended" in Sessions.md
  // 2. Update any tasks that were in "Doing"
  // 3. Clean up session data
});
```

### `tool_call` (interception)

```typescript
pi.on("tool_call", async (event, ctx) => {
  // Intercept Pi coding agent's file writes to:
  // 1. Auto-register new docs if Pi coding agent creates Plan.md, Design.md, etc.
  // 2. Extract task information from Pi coding agent's tool calls
  // 3. Auto-log decisions if Pi coding agent mentions them
});
```

---

## Session Briefing (Injected into Every Agent Start)

```markdown
## Project Context

You are working in project: **{{project_name}}**

### Current State
- Active sessions: {{count}}
- Doing tasks: {{list}}
- Blocked tasks: {{list}}

### Plan (latest)
{{last 3 plan entries}}

### Design (latest)
{{last 3 design entries}}

### Active Decisions
{{recent decisions}}

### Instructions
- Planning decisions → run docflow_write (plan)
- Technical decisions → run docflow_write (design)  
- Overrides → run docflow_write (decisions)
- Claim work → run docflow_task (claim)
- Done → run docflow_task (done)
- Blocked → run docflow_task (block, reason)
```

---

## Document Linking (Two-Layer)

### Layer 1: Wikilinks in content

Every generated section includes a `## Related` footer:

```markdown
### TASK-001: Implement OAuth2

This task traces to:
- [[Plan.md#section-3]] - Scope decision
- [[Design.md#section-2]] - Architecture choice
- [[DEC-001]] - Monolith over microservices

Related tasks: [[TASK-002]], [[TASK-003]]
```

### Layer 2: Frontmatter

```yaml
---
type: task
id: TASK-001
status: doing
created: 2026-06-15T10:30:00Z
updated: 2026-06-15T14:22:00Z
author: pi-extension
session: sess-abc123
traces_to:
  - doc: Plan.md
    section: "Scope Decision"
    weight: 4
  - doc: Design.md
    section: "Architecture"
    weight: 5
---
```

---

## What This Replaces from Source Tools

| Source Feature | docflow Equivalent | Improvement |
|---------------|-------------------|-------------|
| Pi coding agent hooks → event log | Pi events → direct tool calls | No background reconciler needed |
| LaunchAgent (macOS only) | Pi event system (platform-agnostic) | Cross-platform |
| Original slash commands | `docflow_read` + `docflow_write` tools | More flexible, composable |
| Original `/task` command | `docflow_task` tool with actions | More actions (new/claim/done/block/list) |
| Proactive skill | `before_agent_start` + `context` events | Built into pi, always on |
| Phase gates (document-first) | No gates, auto-injection | Lightweight, no ceremony |
| Context handoff manifests | `_Context.md` + `before_agent_start` | Simpler, single source of truth |
| Decision log | `docflow_write (decisions)` tool | Same content, simpler integration |
| Task YAML (document-first) | Kanban board + frontmatter | Visual board in Obsidian, machine-parseable |

---

## Implementation Plan

### Phase 1: Core (Extension scaffold + storage + config)
- [ ] Scaffold extension in `src/index.ts`
- [ ] Config schema (`~/.pi/data/docflow/config.json`)
- [ ] Project resolution (3-layer)
- [ ] `/docflow-setup` command
- [ ] `/docflow-project-new` command (seed templates)
- [ ] Storage layer (read/write vault docs)

### Phase 2: Tools + Events
- [ ] `docflow_read` tool
- [ ] `docflow_write` tool
- [ ] `docflow_task` tool (full CRUD)
- [ ] `docflow_session` tool
- [ ] `docflow_context` tool
- [ ] `session_start` event handler
- [ ] `session_shutdown` event handler
- [ ] `agent_end` event handler
- [ ] Session card management in Sessions.md

### Phase 3: Briefing + Integration
- [ ] `before_agent_start` — inject briefing
- [ ] `context` — update activity timestamps
- [ ] `_Context.md` auto-generation
- [ ] Document linking (wikilinks + frontmatter)
- [ ] `docflow_read` used by briefing system

### Phase 4: Polish
- [ ] `/docflow-status` command
- [ ] `/docflow-list` command (task board view)
- [ ] Master index (`_Index.md`)
- [ ] Bug register (`docflow_bug` tool)
- [ ] Patch tracking (`docflow_patch` tool)
- [ ] Spikes (optional)
- [ ] Tests + documentation

---

## Key Technical Decisions

### Why Tools + Events, Not Hooks

Pi coding agent hooks fire at the OS/process level (even if Pi coding agent crashes). Pi events fire at the API level (when Pi coding agent is running). Trade-off:

| | Hooks (original kanban) | Events + Tools (docflow) |
|---|---|---|
| Survives crash? | Yes (hooks are OS-level) | No — Pi needs to be running |
| Survives Pi coding agent refusing? | Yes | No — Pi needs to be running |
| Survives Pi coding agent context compaction? | Yes (event log persists) | No |
| Real-time updates? | Needs reconciler (10s lag) | Immediate (synchronous) |
| Platform | macOS only (launchd) | Cross-platform (pi runs anywhere) |
| Complexity | Shell scripts + TypeScript reconciler | Pure TypeScript in one file |
| Fork/branch persistence | No | Yes (tool details are fork-safe) |

**Mitigations for the trade-off:**
- `tool_call` interception can detect when Pi coding agent writes files, even if it doesn't call our tools
- `before_agent_start` runs for every new agent cycle, so the briefing always loads
- The briefing tells Pi coding agent to call our tools proactively — most coverage comes from the skill, not the events
- For crash recovery: if Pi restarts, `session_start` fires and creates a fresh session card

### Why Not a Background Reconciler

Pi is an event-driven runtime. There's no `launchd` equivalent. Options:
1. **No reconciler** (chosen) — everything is synchronous on events/tools
2. **Timer-based** — `setInterval` in the extension to check for changes
3. **File watchers** — watch vault directory for changes

Option 1 is simplest and most reliable. The main thing a reconciler does is:
- Age sessions → we update on `agent_end`
- Write vault docs → we write on tool call
- Generate context index → we regenerate on doc change

All of these happen synchronously on events, not on a timer.

### Session Tracking Strategy

Since pi doesn't have `SessionEnd` hooks:
- `session_start` → create session card
- `context` → update `lastActivity` every LLM call
- `agent_end` → record activity, update status
- `session_shutdown` → mark as ended
- **Gap handling**: If Pi is running and Pi coding agent stops, the session stays "active" until Pi restarts. On restart, old sessions get aged. This is acceptable since the user would notice Pi was down.

---

## Anti-Patterns

| Anti-pattern | Why | Solution |
|-------------|-----|----------|
| Over-documenting | Turns into paperwork | Keep docs append-only, one paragraph per entry |
| Too many mandatory docs | Overwhelms the AI | Only 7 core docs; everything else is optional |
| Manual approval gates | Slows flow | Trust the process; review via `/docflow-status` |
| Hard-to-find context | Briefing too long | `_Context.md` keeps it compact; truncate to last N entries |
| Backlog pollution | User creates tasks, forgets them | `/docflow-list` shows all; auto-archive Done after 30 days |
| Multi-machine vault conflicts | Two machines writing same docs | Single-machine for now; add file locking later if needed |
