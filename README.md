# docflow — Document-Driven Kanban for Pi

A pi extension that combines document-first-wf's **document generation & linking** with **session tracking & kanban boards** — no phase gates, no ceremony.

## What It Is

**docflow** gives you:
- **Kanban boards** for tasks (Backlog → Doing → Blocked → Done → Archive)
- **Session tracking** with automatic liveness (Active → Idle → Stale → Ended)
- **Proactive briefing** — every session starts with project context injected
- **Decision log** — capture why you chose what you chose
- **Project-first multi-project rollup** — master index with hot/warm/cold buckets
- **Shared vault** — all documents live in a central Obsidian vault, not scattered across repos

## Install

```bash
# From this directory
cd ~/workspace/obsidian-plugin
npm install

# Then copy to your extensions directory
mkdir -p ~/.pi/agent/extensions/docflow
cp -r src/* ~/.pi/agent/extensions/docflow/

# Or use globally
mkdir -p ~/.pi/agent/extensions/docflow
cp src/index.ts ~/.pi/agent/extensions/docflow/index.ts
```

## Quick Start

```bash
# 1. Set up the shared vault
/docflow-setup

# 2. Create a project (defaults to vault storage)
/docflow-project-new myproject "My Awesome Project"
# Or store docs in the local repo:
# /docflow-project-new myproject "My Awesome Project" repo

# 3. Assign current session
/docflow-project myproject

# 4. Start working — Pi coding agent gets briefed automatically
#    When making decisions: docflow_write (plan, "scope changed to...")
#    When claiming work:    docflow_task (claim, "Implement auth")
#    When done:             docflow_task (done)
```

## Architecture

| Source Feature | docflow Equivalent | Improvement |
|---------------|-------------------|-------------|
| Pi coding agent hooks | Pi events + tools | Immediate, synchronous |
| LaunchAgent | No background process needed | Cross-platform |
| Phase gates | None — lightweight | No ceremony |
| Per-phase docs | 7 core docs + on-demand | Simple, focused |
| Context manifests | `_Context.md` auto-generated | Single source of truth |
| Decision log | `docflow_write (decisions)` | Integrated, append-only |

### Module Layout

```
src/
├── types.ts           — Shared interfaces (DocflowConfig, SessionCard, TaskRecord)
├── utils.ts           — Constants, file I/O, config, project resolution
├── kanban.ts          — Kanban board markdown generation/parsing
├── session.ts         — Session card creation and updates
├── briefing.ts        — Briefings, context index, master index
├── tools.ts           — docflow_* tool registrations
├── commands.ts        — Slash command registrations
├── events.ts          — Pi event handlers (session_start, context, etc.)
├── diagrams.ts        — Excalidraw + Mermaid diagram tools
└── index.ts           — Entry point: wires everything together
```

## Tools

| Tool | Purpose |
|------|---------|
| `docflow_read` | Read project documents (plan, design, tasks, etc.) |
| `docflow_write` | Append to project documents (plan, design, decisions) |
| `docflow_task` | Create/claim/done/block tasks |
| `docflow_session` | Session status and briefing |
| `docflow_context` | Regenerate context index |
| `draw_excalidraw` | Create free-form diagrams (architecture, wireframes, sketches) |
| `draw_mermaid` | Create standard diagrams (sequence, flowchart, state, gantt, class, ER) |
| `excalidraw_update` | Update existing Excalidraw diagrams |
| `diagram_status` | List all diagrams in a project |

## Commands

| Command | Purpose |
|---------|---------|
| `/docflow-setup` | Configure vault path |
| `/docflow-project <slug>` | Assign session to project |
| `/docflow-project-new <slug> <name>` | Create new project |
| `/docflow-status` | Show project/session/task status |
| `/docflow-context` | Display current briefing |
| `/diagram-excalidraw` | Create Excalidraw diagram directory |
| `/diagram-mermaid` | Create Mermaid diagram directory |

## Diagrams

AI agents draw diagrams automatically using two tools:

| Tool | Use When |
|------|----------|
| `draw_excalidraw` | Free-form: architecture, wireframes, brainstorming |
| `draw_mermaid` | Structured: sequence, flowchart, state, gantt, class, ER |

Just ask Pi coding agent to "draw the architecture" or "show the user flow" — it picks the right tool and generates valid diagrams automatically.

## File Layout

Documents are stored in **two modes**, configurable per-project (`vault` default):

**Vault mode** (`docStorage: "vault"`) — all project docs in a shared Obsidian vault:
```
~/.pi/data/docflow/
  config.json
  projects.json

<vaultPath>/docflow/
  _Index.md               # Master rollup
  <slug>/
    README.md             # Project charter
    Plan.md               # Planning decisions
    Design.md             # Technical decisions
    Tasks.md              # Kanban board
    Sessions.md           # Session lifecycle
    Decisions.md          # Decision log
    _Context.md           # Auto-generated index
```

**Repo mode** (`docStorage: "repo"`) — docs stored in `<repo-root>/docflow/<slug>/` alongside the code:
```
<repo-root>/docflow/
  myproject/
    README.md
    Plan.md
    Design.md
    Tasks.md
    Sessions.md
    Decisions.md
    _Context.md
```

Choose `vault` for multi-repo projects, `repo` for single-repo projects where you want docs version-controlled with code.

## Design Doc

See [DESIGN.md](DESIGN.md) for the full architecture, data model, and implementation plan.

## License

MIT
