# docflow — Document-Driven for Pi

A lightweight, automatic task and session tracker that lives alongside your Obsidian vault. It gives you kanban boards, session tracking, decision logging, and AI-generated diagrams — all updated in real-time as you work.

## What It Does

**docflow** keeps your project organized without ceremony:

- **Kanban boards** — Backlog → Doing → Blocked → Done → Archive, updated via tools
- **Session tracking** — automatic liveness (Active → Idle → Stale → Ended)
- **Proactive briefing** — project context injected at the start of every session
- **Decision log** — append-only record of planning and technical decisions
- **Multi-project rollup** — hot/warm/cold buckets show which projects are active
- **Shared vault** — all project docs live in one Obsidian vault, not scattered across repos
- **Diagram generation** — Excalidraw and Mermaid diagrams generated automatically from natural language

## Install

```bash
git clone git@github.com:congtrung6391/docflow.git ~/.pi/agent/extensions/docflow
```

Then run `/reload` in Pi — the extension will be discovered automatically at `~/.pi/agent/extensions/docflow/index.ts`.

## Quick Start

```
# 1. Set up the shared vault
/docflow-setup

# 2. Create a project (defaults to vault storage)
/docflow-project-new myproject "My Awesome Project"
# Or store docs in the local repo:
# /docflow-project-new myproject "My Awesome Project" repo

# 3. Assign current session
/docflow-project myproject
```

That's it. From now on:

```
# When making decisions:
docflow_write(document: "plan", content: "scope changed to...")
docflow_write(document: "design", content: "we chose SQLite over Postgres")

# When claiming and tracking work:
docflow_task(action: "new", text: "Implement user auth")
docflow_task(action: "claim", text: "Implement user auth")
docflow_task(action: "done")
docflow_task(action: "block", reason: "waiting on API key")

# Check status or get a briefing:
docflow_session(action: "status")
docflow_session(action: "briefing")
```

## Tools

| Tool | Purpose |
|------|---------|
| `docflow_read` | Read project documents (plan, design, tasks, sessions, decisions, context) |
| `docflow_write` | Append to plan, design, or decisions documents |
| `docflow_task` | Create/claim/done/block tasks on the kanban board |
| `docflow_session` | Check session status or get a project briefing |
| `docflow_context` | Regenerate the project context index |
| `draw_excalidraw` | Create free-form diagrams (architecture, wireframes, sketches) |
| `draw_mermaid` | Create structured diagrams (sequence, flowchart, state, gantt, class, ER) |
| `excalidraw_update` | Update existing Excalidraw diagrams |
| `diagram_status` | List all diagrams in a project |

## Commands

| Command | Purpose |
|---------|---------|
| `/docflow-setup` | Configure vault path |
| `/docflow-project <slug>` | Assign current session to a project |
| `/docflow-project-new <slug> <name>` | Create new project |
| `/docflow-status` | Show project, session, and task status |
| `/docflow-context` | Display current project briefing |
| `/diagram-excalidraw` | Initialize Excalidraw diagram directory |
| `/diagram-mermaid` | Initialize Mermaid diagram directory |

## Diagrams

Ask the agent to "draw the architecture" or "show the user flow" — it picks the right diagram type and generates valid output automatically.

| Tool | Best For |
|------|----------|
| `draw_excalidraw` | Free-form: architecture sketches, wireframes, brainstorming |
| `draw_mermaid` | Structured: sequence diagrams, flowcharts, state machines, Gantt charts |

## File Layout

Documents are stored in **two modes**, configurable per-project (`vault` is the default):

**Vault mode** (`docStorage: "vault"`) — all project docs in a shared Obsidian vault:

```
~/.pi/data/docflow/
  config.json
  projects.json

<vaultPath>/docflow/
  _Index.md                  # Master rollup (hot/warm/cold)
  <slug>/
    README.md                # Project charter
    Plan.md                  # Planning decisions
    Design.md                # Technical decisions
    Tasks.md                 # Kanban board
    Sessions.md              # Session lifecycle
    Decisions.md             # Decision log
    _Context.md              # Auto-generated index
    docs/                    # Diagrams
      diagrams.json          # Index
      <name>-excalidraw.json
      <name>-mermaid.md
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
    docs/
      diagrams.json
      ...
```

Choose **vault** for multi-repo projects where you want a single source of truth. Choose **repo** for single-repo projects where you want docs version-controlled with the code.

## Design Doc

See [DESIGN.md](DESIGN.md) for the full architecture, data model, and implementation details.

## License

MIT
