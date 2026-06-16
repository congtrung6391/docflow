---
name: diagrams
description: Draw clean diagrams for project docs — architecture/C4, ER, state machine, data flow, sequence, flowchart, screenflow, UI wireframe, brainstorm, scrum. Clarity comes from restraint — use few arrows, group with frames and layout, and pick the diagram type whose conventions keep it tidy. Use draw_excalidraw for spatial/creative diagrams and draw_mermaid for strict standard ones. Never hand-write Excalidraw or Mermaid.
---

# Drawing clean diagrams

A good diagram answers **one** question and can be read in seconds. Arrows carry
the meaning — they show how things connect, call, flow, or depend. **Draw every
relationship the reader needs to understand the system.** A diagram that omits
real connections is just as useless as one buried in arrow-soup — and *more*
common once you start trimming. The goal is not "few arrows," it is "every
*essential* arrow, no *redundant* ones." Cut only what grouping or order already
makes obvious; never cut a connection the reader would otherwise have to guess.

## The 10 rules of a clean diagram (read first)

1. **Show every essential relationship.** If two things talk, call, flow, or
   depend on each other and the reader needs to know, draw the arrow. Under-
   drawing is a real failure: a box with no connections, or a diagram that
   doesn't show how the pieces interact, teaches nothing.
2. **One diagram, one question, one scope.** If you're tempted to show
   *everything at every level*, split into several diagrams (this is the whole
   idea behind C4 levels) — don't drop essential arrows to fit one canvas.
3. **Cut only REDUNDANT arrows, not essential ones.** Drop an arrow only when
   grouping or order already conveys it:
   - **Containment** — a box inside an "Auth Service" `frame` needs no arrow to
     say it *belongs* there (but still draw arrows for what it *calls*).
   - **Order / proximity** — adjacent steps in a pipeline imply sequence; you
     needn't connect every pair if the flow is linear and obvious.
   - **Transitivity** — if A→B→C is shown, skip a redundant A→C unless A really
     calls C directly.
4. **Watch the extremes, not a hard cap.** Roughly, far more arrows than boxes
   usually means redundant/derivable links (or wrong diagram type); far fewer
   means you're under-drawing. Aim for "every essential connection shown" — if
   that genuinely needs many arrows, split by scope rather than omit.
5. **One primary direction** (top→down or left→right). Avoid back-edges and
   cross-links; they create the crossings that make diagrams ugly.
6. **No bidirectional pairs.** One arrow, the dominant direction. Two-way is noise.
7. **Collapse parallel edges.** If many boxes point at one target, group them in
   a frame and draw a single arrow from the frame — or show only the
   representative relationship.
8. **Cap fan-out.** A box with >4 arrows is a hairball. Introduce a hub, a
   group, or split the diagram.
9. **Label only non-obvious arrows.** If position already makes the relationship
   clear, drop the label.
10. **Right type beats more detail.** Choosing the correct diagram type
    constrains arrows for you — half of "messy architecture diagrams" are really
    a data-flow or sequence diagram drawn with the wrong conventions.

## Pick the diagram type (most creative → most strict)

| Type | Shows | Tool | Arrow discipline |
|---|---|---|---|
| Brainstorm / mind-map | ideas & associations | excalidraw | tree only (parent→child), no cross-links |
| UI / UX wireframe | one screen's layout | excalidraw | **none** between elements — use frames + layout |
| Screenflow | navigation between screens | excalidraw | 1 per transition, labeled with the user action |
| Data-flow (DFD) | how data moves | excalidraw | 1 per flow, labeled with the *data* (a noun) |
| Scrum / agile board | work state | excalidraw | ~none — columns are frames, work items are cards |
| C4 (context/container/component) | software architecture | excalidraw | only meaningful dependencies; **one level per diagram** |
| State machine | states & events | mermaid `state` | 1 per transition, labeled with the trigger |
| Entity-relationship | data model | mermaid `er` | lines only between related entities, with cardinality |
| Sequence | time-ordered interaction | mermaid `sequence` | messages in order; no free arrows |
| Flowchart | a process / decisions | mermaid `flowchart` | linear flow, one direction |

**Tool rule of thumb:** strict standard notations (sequence, flowchart, state,
ER, class, gantt) → **draw_mermaid** — it auto-lays-out and you physically can't
make arrow soup. Spatial or non-standard diagrams (C4, wireframe, screenflow,
brainstorm, DFD, board) → **draw_excalidraw**.

## Per-type playbooks

### Brainstorm / mind-map (creative)
- Central idea = circle or diamond; branches = boxes radiating out.
- Arrows: parent→child **only**, no arrowheads needed, **never** cross-link
  siblings (that's what turns a mind-map into a web). Color per branch.
- One arrow per child — nothing more.

### UI / UX wireframe (creative, spatial)
- A `frame` per screen or region; boxes = UI elements (button, input, card,
  nav); `note`/`text` = copy/placeholder.
- **Do not connect UI elements with arrows.** Hierarchy and order *are* the
  layout. Keep it to one screen per diagram.
- Use grey/neutral colors; wireframes are about structure, not styling.

### Screenflow
- Each screen = one box (or a small frame), laid left→right.
- One arrow per transition, labeled with the trigger ("tap Login", "submit").
  Branch only at real decision points. This is where wireframe screens get
  connected — keep the wireframe detail out of it.

### Data-flow diagram (DFD)
- External entity = rectangle; process = circle/ellipse; data store = box.
- Arrows are data flows — label each with the **data** ("order details"), not a
  verb. No control flow, no loops. Keep to one level (context, then level-1) per
  diagram.

### Scrum / agile
- Board: a `frame` per column (Backlog / To Do / Doing / Done) with cards
  (boxes or notes) inside — **containment, essentially no arrows.**
- Sprint/ceremony flow: a short left→right chain (Plan → Sprint → Review →
  Retro). Burndown/velocity are charts — note them or use a mermaid gantt for
  timelines.

### C4 — the antidote to arrow-soup architecture
Never cram a whole system into one diagram. Draw the level you need:
- **Context** — the system in focus (one box, centered), its users (actors), and
  external systems around it. Arrows = only the few interactions that matter.
- **Container** — a `frame` for the system boundary; containers inside (web app,
  API, DB, queue, worker). Arrows = inter-container calls, labeled with
  protocol/intent. Aim for ≤ ~1 arrow per talking pair.
- **Component** — one container as a `frame`; its components inside; arrows =
  key calls only.
- If an architecture diagram feels arrow-heavy, you're mixing levels — split.

### State machine → `draw_mermaid` type:"state"
- States = nodes, transitions = arrows labeled with the event/trigger, mark the
  initial state. Cycles are fine; every transition must be meaningful.

### Entity-relationship → `draw_mermaid` type:"er"
- Entities with their attributes; one relationship line per related pair, with
  cardinality (1-to-many etc.). No stray arrows.

### Sequence → `draw_mermaid` type:"sequence"
- Actors/lifelines across the top; messages in time order. Don't reach for
  excalidraw here.

### Flowchart → `draw_mermaid` type:"flowchart"
- Rounded start/end, rectangles for steps, diamond for decisions with Yes/No
  branches, one direction (top-down). Keep it linear.

## draw_excalidraw mechanics

Describe the diagram in plain English; the tool emits valid Excalidraw JSON.
- **Elements**: `box`, `circle`, `diamond`, `text`, `note`, `image`, `frame`.
- **Grouping**: give an element a `frame` (the label of a `frame` element); the
  frame auto-sizes around its members. This is your primary tool for cutting
  arrows.
- **Positions**: omit `x`/`y` — nodes auto-lay-out from the arrows. Only set
  them to override.
- **Direction**: `auto` (inferred), or force `LR` / `TB`.
- **Colors**: named — blue, green, red, orange, purple, teal, gray, black. Use
  color to group, not to decorate.
- **Arrows**: reference elements by `label`; optional `label`, `strokeColor`,
  `strokeStyle` (solid/dashed/dotted). Labels sit on the line, clear of boxes.
- **Routing** (`routing`): the default gives elbow-style arrows — clean
  orthogonal (Manhattan) routes with rounded corners, every arrow bound to both
  box edges so it always points at a real box and never floats. They fan across
  borders and route around the box field. Use `straight` for simple direct
  lines. You rarely need to set this — and routing never rescues a diagram that
  simply has too many arrows.

## draw_mermaid mechanics

Describe the structure, not the syntax. `type` ∈ sequence, flowchart, state,
gantt, class, er. The tool generates the Mermaid for you and Obsidian renders
it. Prefer this for the strict types above.

## Before you finish — cleanliness checklist

- [ ] Is **every** essential relationship shown? Any box left unconnected that
      shouldn't be? (Under-drawing is the most common failure — don't ship a
      diagram that hides how the pieces interact.)
- [ ] Any *redundant* arrows (already implied by a frame, by order, or by
      transitivity)? Drop only those.
- [ ] Any bidirectional pair or back-edge that should be one directed arrow? Fix it.
- [ ] Do arrows mostly flow one direction?
- [ ] If there are genuinely too many essential arrows, split by scope/level
      (C4) rather than omit connections.
- [ ] Is this the right *type* for the question, or am I forcing it?
- [ ] Saved to `<slug>/diagrams/` and referenced from the relevant doc (`[[file]]`).

## Always

- Use the tools — never hand-write Excalidraw JSON or Mermaid.
- Lay out boxes and grouping first, then draw all the relationships that matter.
- When in doubt, draw two smaller diagrams instead of one busy one.
