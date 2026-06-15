# pi Coding Agent Extension Development Guide

Quick reference for building pi extensions.

---

## 1. File Locations

| Location | Scope |
|----------|-------|
| `~/.pi/agent/extensions/*.ts` | Global (all projects) |
| `.pi/extensions/*.ts` | Project-local |
| `~/.pi/agent/extensions/*/index.ts` | Global (subdirectory) |
| `.pi/extensions/*/index.ts` | Project-local (subdirectory) |

Test one-off: `pi -e ./my-extension.ts`

---

## 2. Basic Template

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

export default function (pi: ExtensionAPI) {
  // Events
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("Loaded!", "info");
  });

  // Custom tool
  pi.registerTool({
    name: "my_tool",
    label: "My Tool",
    description: "What it does",
    parameters: Type.Object({
      action: StringEnum(["a", "b"] as const),
      text: Type.Optional(Type.String()),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      onUpdate?.({ content: [{ type: "text", text: "Working..." }] });
      return {
        content: [{ type: "text", text: "Done" }],
        details: { result: "..." },
      };
    },
  });

  // Command
  pi.registerCommand("mycommand", {
    description: "Do something",
    handler: async (args, ctx) => {
      ctx.ui.notify(args, "info");
    },
  });
}
```

---

## 3. Custom Tool Checklist

- [ ] `name` — unique identifier (lowercase, underscores)
- [ ] `label` — display name
- [ ] `description` — what it does (shown in system prompt)
- [ ] `parameters` — TypeBox schema
  - Use `StringEnum(["val"] as const)` for string params (Google API required)
  - Use `Type.Optional()` for optional fields
- [ ] `execute()` — returns `{ content, details? }`
  - Call `onUpdate?.()` for streaming progress
  - Store state in `details` for fork/branch persistence
- [ ] `promptSnippet` — one-line summary for "Available tools" section (optional)
- [ ] `promptGuidelines` — tool-specific instructions appended to Guidelines (optional)
  - Each bullet must name the tool: `"Use my_tool when..."`
- [ ] `renderCall` / `renderResult` — custom TUI rendering (optional)

---

## 4. Event Reference

### Subscribe
```typescript
pi.on("event_name", async (event, ctx) => { ... });
```

### Tool Events
| Event | Timing | Can? |
|-------|--------|------|
| `tool_execution_start` | Before tool runs | Inspect args |
| `tool_call` | Before tool runs | **Block** via `{ block: true, reason }`, mutate `event.input` |
| `tool_execution_update` | During execution | Inspect partial results |
| `tool_result` | After execution | **Modify** result (`{ content, details, isError }`) |
| `tool_execution_end` | After tool done | Inspect final result |

### Agent Events
| Event | Timing | Can? |
|-------|--------|------|
| `before_agent_start` | After prompt, before agent | Inject `message`, modify `systemPrompt` |
| `context` | Before each LLM call | Modify `messages` |
| `agent_start` | Once per user prompt | — |
| `agent_end` | After prompt completes | Inspect messages |
| `turn_start` / `turn_end` | Each LLM turn + tool calls | Inspect |
| `message_start` / `message_update` / `message_end` | Message lifecycle | `message_end` can return `{ message }` replacement |

### Session Events
| Event | Timing | Can? |
|-------|--------|------|
| `session_start` | Session loads/starts | Notify, restore state |
| `session_before_switch` | Before `/new` or `/resume` | **Cancel** via `{ cancel: true }` |
| `session_before_fork` | Before `/fork` or `/clone` | **Cancel**, or control conversation restore |
| `session_before_compact` | Before compaction | **Cancel**, or provide custom `summary` |
| `session_compact` | After compaction | Inspect compaction entry |
| `session_before_tree` | Before `/tree` | **Cancel**, or provide custom `summary` |
| `session_tree` | After tree navigation | Inspect new leaf/old leaf |
| `session_shutdown` | Before runtime tears down | Cleanup, save state |

### Startup Events
| Event | Timing |
|-------|--------|
| `project_trust` | Before project trust resolved |
| `session_start { reason: "startup" }` | After trust resolved |
| `resources_discover` | After session_start, before provider registration |

### Model Events
| Event | Timing |
|-------|--------|
| `model_select` | Model changes via `/model` or Ctrl+P |
| `thinking_level_select` | Thinking level changes |

### Other Events
| Event | Timing | Can? |
|-------|--------|------|
| `input` | User input received | **Intercept** (`handled`), **transform**, or **continue** |
| `before_provider_request` | Before HTTP request | **Replace** payload |
| `after_provider_response` | After HTTP response | Inspect status/headers |
| `user_bash` | `!` or `!!` commands | **Replace** operations |

---

## 5. Context (`ctx`) Reference

### Properties
| Property | Type | Description |
|----------|------|-------------|
| `ctx.mode` | `"tui" \| "rpc" \| "json" \| "print"` | Current mode |
| `ctx.hasUI` | `boolean` | True in TUI/RPC, false in print |
| `ctx.cwd` | `string` | Current working directory |
| `ctx.signal` | `AbortSignal \| undefined` | Abort signal during active turns |
| `ctx.model` | `Model | undefined` | Current model (in commands) |
| `ctx.sessionManager` | `SessionManager` | Read-only session state |

### `ctx.ui` Methods
| Method | Returns | Description |
|--------|---------|-------------|
| `ctx.ui.notify(msg, level)` | void | Toast notification |
| `ctx.ui.confirm(title, msg)` | `Promise<boolean>` | Yes/No dialog |
| `ctx.ui.select(title, items)` | `Promise<string>` | Single-item selector |
| `ctx.ui.input(prompt)` | `Promise<string>` | Text input |
| `ctx.ui.setStatus(extId, msg)` | void | Footer status line |
| `ctx.ui.setWidget(extId, lines)` | void | Widget above editor |
| `ctx.ui.setEditorText(text)` | void | Replace editor contents |
| `ctx.ui.setHeader(lines)` | void | Custom header |
| `ctx.ui.setFooter(lines)` | void | Custom footer |
| `ctx.ui.setWorkingIndicator(text)` | void | Replace working spinner |
| `ctx.ui.setHiddenThinkingLabel(text)` | void | Replace thinking label |
| `ctx.ui.setEditorComponent(component)` | void | Custom editor component |
| `ctx.ui.custom(renderFn)` | `Promise<T>` | Full custom TUI overlay |

### `ctx.sessionManager` Methods
| Method | Returns | Description |
|--------|---------|-------------|
| `getSessionFile()` | `string \| undefined` | Current session file path |
| `getEntries()` | `SessionEntry[]` | All entries |
| `getBranch()` | `SessionEntry[]` | Current branch entries |
| `getLeafId()` | `string` | Current leaf ID |
| `appendMessage(msg)` | void | Add message to session |

### `ctx` Helpers (Commands only)
| Method | Returns | Description |
|--------|---------|-------------|
| `ctx.getSystemPromptOptions()` | `SystemPromptOptions` | Base prompt inputs |
| `ctx.waitForIdle()` | `Promise<void>` | Wait for agent to finish |
| `ctx.newSession(opts)` | `NewSessionResult` | Create new session |
| `ctx.fork(entryId, opts)` | `ForkResult` | Fork from entry |
| `ctx.navigateTree(targetId, opts)` | `NavigationResult` | Navigate tree |
| `ctx.switchSession(path, opts)` | `SwitchResult` | Switch sessions |
| `ctx.reload()` | `Promise<void>` | Reload extensions/resources |

### `ctx` Helpers (All contexts)
| Method | Returns | Description |
|--------|---------|-------------|
| `ctx.isIdle()` | `boolean` | Agent idle? |
| `ctx.abort()` | void | Abort current turn |
| `ctx.hasPendingMessages()` | `boolean` | Messages queued? |
| `ctx.getContextUsage()` | `ContextUsage \| undefined` | Token/cost usage |
| `ctx.compact(opts)` | void | Trigger compaction |
| `ctx.getSystemPrompt()` | `string` | Current system prompt |
| `ctx.shutdown()` | void | Graceful shutdown |

---

## 6. ExtensionAPI Methods

| Method | Description |
|--------|-------------|
| `pi.on(event, handler)` | Subscribe to events |
| `pi.registerTool(tool)` | Register a custom tool (anytime) |
| `pi.registerCommand(name, cmd)` | Register a slash command |
| `pi.getAllTools()` | `ToolInfo[]` — all tools |
| `pi.getActiveTools()` | `string[]` — currently active |
| `pi.setActiveTools(names)` | Enable/disable tools |
| `pi.getCommands()` | `SlashCommandInfo[]` — all commands |
| `pi.sendMessage(msg, opts)` | Inject custom message into session |
| `pi.sendUserMessage(content, opts)` | Send actual user message |
| `pi.appendEntry(type, data)` | Persist state (not in LLM context) |
| `pi.setSessionName(name)` | Set session display name |
| `pi.getSessionName()` | Get session display name |
| `pi.setLabel(entryId, label?)` | Bookmark an entry |

---

## 7. Important Patterns

### Guarding for TUI-only features
```typescript
if (ctx.mode === "tui" && ctx.hasUI) {
  await ctx.ui.select(...);
}
```

### Abort-aware async work
```typescript
const res = await fetch(url, { signal: ctx.signal });
```

### State persistence via tool details (fork-safe)
```typescript
// Store
return { content: [...], details: { todos, nextId } };

// Restore on session_start or session_tree
for (const entry of ctx.sessionManager.getBranch()) {
  if (entry.type === "message" && entry.message.toolName === "my_tool") {
    const data = entry.message.details;
    // Reconstruct
  }
}
```

### Dynamic tool registration
```typescript
pi.on("session_start", (_event, ctx) => {
  pi.registerTool({ name: "echo_session", ... });
  ctx.ui.notify("Tool registered", "info");
});
```

### Async factory for startup work
```typescript
export default async function (pi: ExtensionAPI) {
  const data = await fetch("...");
  pi.registerProvider("custom", { ... });
}
```

### Safe session replacement pattern
```typescript
pi.registerCommand("handoff", {
  handler: async (_args, ctx) => {
    await ctx.newSession({
      withSession: async (ctx) => {
        // Use the NEW ctx here — not the captured one!
        await ctx.sendUserMessage("Continue");
      },
    });
  },
});
```

---

## 8. Dependencies

### Built-in imports
| Import | From |
|--------|------|
| `Type` | `typebox` |
| `StringEnum` | `@earendil-works/pi-ai` |
| `ExtensionAPI`, `ExtensionContext` | `@earendil-works/pi-coding-agent` |
| `Container`, `Markdown`, `matchesKey` | `@earendil-works/pi-tui` |
| `DynamicBorder`, `getMarkdownTheme` | `@earendil-works/pi-coding-agent` |
| `SessionManager` | `@earendil-works/pi-coding-agent` (static methods) |

### Adding npm deps
Create `package.json` next to extension:
```json
{
  "dependencies": {
    "chalk": "^5.0.0"
  }
}
```
Then `npm install` — imports from `node_modules/` resolve automatically.

---

## 9. Common Pitfalls

| Pitfall | Solution |
|---------|----------|
| Using `Type.Literal` for string enums | Use `StringEnum(["a","b"] as const)` for Google API compat |
| Reusing old `ctx` / `sessionManager` after session replacement | Always use the `ctx` passed to `withSession` callbacks |
| Calling `ctx.reload()` from a tool | Tools can't call `reload()`; register a command and queue it via `pi.sendUserMessage("/reload-cmd")` |
| `ctx.signal` is undefined outside turns | Check for undefined before using in fetch/async calls |
| `promptGuidelines` bullets must name the tool | Write `"Use my_tool when..."` not "Use this tool when..." |
| State stored outside `details` lost on fork | Always store tool state in `details` for fork/branch support |
| `withSession` runs after `session_shutdown` cleanup | Don't assume old in-memory state survives; only use plain data |

---

## 10. Useful Files to Reference

- Full docs: `~/.pi/agent/` extension docs directory
- Examples: `~/.pi/agent/examples/extensions/`
  - `hello.ts` — minimal tool
  - `dynamic-tools.ts` — runtime tool registration
  - `permission-gate.ts` — block dangerous commands
  - `qna.ts` — custom UI with LLM call
  - `tools.ts` — interactive tool selector with state persistence
  - `summarize.ts` — custom UI + LLM summarization
  - `handoff.ts` — session handoff pattern
  - `todo.ts` — stateful tool with details persistence
  - `event-bus.ts` — inter-extension communication
