---
name: diagrams
description: Create diagrams for project docs. Use draw_excalidraw for free-form (architecture, wireframes, sketches) and draw_mermaid for structured (sequence, flowchart, state, gantt, class, ER). Never draw manually.
---

# Diagram Drawing Skill

Use this skill whenever you need to create or update a diagram for a project.

## Mermaid vs Excalidraw Decision Tree

```
Is the diagram structured and follows a standard pattern?
├── YES → Use draw_mermaid
│   ├── Sequence diagram (actors talking to each other) → type: "sequence"
│   ├── Flowchart (steps, decisions, flow)              → type: "flowchart"
│   ├── State transitions (state machine)                → type: "state"
│   ├── Timeline/gantt (schedules, milestones)           → type: "gantt"
│   ├── Class diagram (OO design)                        → type: "class"
│   └── ER diagram (database schema)                     → type: "er"
└── NO → Use draw_excalidraw
    ├── Architecture (layers, components, services)      → free-form
    ├── UI Wireframes (layouts, screens, flows)          → free-form
    ├── Brainstorming (ideas, connections, notes)        → free-form
    └── Any custom/free-form diagram                     → free-form
```

## When to Draw

### Use draw_mermaid for:
- **Sequence diagrams**: API calls, user flows, service interactions
- **Flowcharts**: Decision trees, approval flows, installation steps
- **State diagrams**: Machine states, workflow states, lifecycle
- **Gantt charts**: Timelines, project schedules, milestones
- **Class diagrams**: Object-oriented class hierarchies
- **ER diagrams**: Database schemas, entity relationships

### Use draw_excalidraw for:
- **Architecture diagrams**: Microservices, layered architecture, system overview
- **Wireframes**: UI layouts, screen designs, navigation flows
- **Brainstorming**: Ideas, connections, sticky-note style
- **Custom diagrams**: Anything that doesn't fit standard patterns
- **Hybrid diagrams**: Mix of boxes, arrows, free-form text, frames

## How to Use draw_excalidraw

Describe the diagram in plain English. You specify:
- **Elements**: box, circle, diamond, text, note, image, frame
- **Positions**: x/y are optional — omit for auto-layout
- **Colors**: use named colors (blue, green, red, orange, purple, teal, gray)
- **Arrows**: specify source label → target label with optional text

### Example: Architecture Diagram

```
Create an architecture diagram:
- Frontend box (blue) at top
- Backend box (green) in middle
- Database box (purple) at bottom
- Arrow from Frontend to Backend labeled "HTTPS"
- Arrow from Backend to Database labeled "SQL"
```

The tool converts this to valid Excalidraw JSON automatically.

### Example: Wireframe

```
Create a wireframe for a settings page:
- Frame labeled "Settings" (full width)
- Sidebar with "Profile", "Notifications", "Security" (left)
- Content area with input fields (center)
- Save button at bottom right (green)
```

### Example: Freehand Notes

```
Create a brainstorm diagram:
- Central node "AI Agent" (circle, orange)
- Connected to: "Planning", "Coding", "Testing", "Debugging" (boxes)
- "Planning" connects to "Tasks", "Goals"
- "Coding" connects to "Build", "Refactor", "Review"
```

## How to Use draw_mermaid

Describe the structure, not the Mermaid syntax:

### Example: Sequence Diagram

```
Create a sequence diagram:
- Actors: User, API, Database
- Messages:
  - User -> API: Submit form
  - API -> Database: Validate
  - Database -> API: Results
  - API -> User: Confirmation
```

### Example: Flowchart

```
Create a flowchart:
- Nodes: Start, Is Valid?, Process, Error, End
- Edges:
  - Start -> Is Valid?
  - Is Valid? -> Process: Yes
  - Is Valid? -> Error: No
  - Process -> End
  - Error -> End
```

## Best Practices

1. **Always use tools** — never write Excalidraw JSON or Mermaid syntax manually
2. **Start simple** — basic boxes and arrows first, then refine
3. **Use colors** to indicate importance or grouping
4. **Group related items** with frames in Excalidraw
5. **Keep labels short** — use one line per label when possible
6. **Save to project diagrams directory** — tools write to `<slug>/diagrams/`
7. **Embed in docs** — reference diagrams from Plan.md, Design.md with `[[filename]]`

## Troubleshooting

- **Diagram not showing in Obsidian**: Ensure the file has a `.md` wrapper with `%%EXCALIDRAW%%` directive
- **Elements overlapping**: Add explicit x/y coordinates to break auto-layout
- **Colors not matching**: Use named colors from the color palette (blue, green, red, orange, purple, teal, gray, black)
- **Too many elements**: Split into multiple diagrams with different scopes
