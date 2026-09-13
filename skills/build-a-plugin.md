---
type: mcp.skill::au-mcp-sdk
name: build-a-plugin
description: How to build an au-mcp plugin against the au-mcp-sdk contract. Use when adding a new agent-facing TOOL (a callable), or a kernel-internal HOOK (an observer / mediator / stamper), to a package that speaks the SDK.
---

# Build a plugin

A plugin is a package that speaks `@arsumbris/au-mcp-sdk`.
The kernel discovers it from the type graph, loads it, and wires it by its kind.
You author it in YOUR OWN repo, against the SDK contract.

## Step 0 - decide the kind

A plugin is exactly ONE of two kinds. Pick before you write anything.
- a **tool** — the agent-facing callable.
  - the agent invokes it and gets a result.
  - it has an input schema (its fields), a presentation (its description), and shows in the tool list.
  - e.g. read a file, run an engine read, run package-specific code.
- a **hook** — kernel-internal, the agent never sees it.
  - it fills one or more phase SHAPES (a hook may combine them):
    - **observer** — watches session events (e.g. a recorder).
    - **mediator** — intercepts an action before it runs; returns allow / deny / inject / ask, plus an optional post-action message.
    - **stamper** — contributes an un-forgeable stamp folded into a governed write's commit (e.g. provenance).

If the agent should call it, it is a tool.
If it should silently watch, gate, or stamp, it is a hook.

## Build a tool

A tool is an `mcp.tool` subtype whose FIELDS ARE its call input.
The daemon validates each call against those fields and generates the input schema from them.

1. **Write the def** — `type/<name>.type.yaml`, `extends: mcp.tool::au-mcp-sdk`.
   - each field is one call input; add `#:` docstrings (they tell the agent how to fill each one).
   - a `?` suffix marks an optional field.
2. **Attach the meta** — two blocks in `meta:`.
   - `plugin-runtime-meta` — `entry` points at your ESM (a `.ts` file; the SDK is consumed as TS source, no build step), plus `contractVersion: 0`.
   - `tool-presentation-meta` — `description` is what the tool does + when to use it (the agent reads this).
3. **Implement the ESM** — export `createPlugin`, returning `{ invoke }`.
   - `invoke(input, ctx)` receives input ALREADY validated against the def's fields; return a `CallableResult`.
   - interfaces come from `@arsumbris/au-mcp-sdk` (`PluginContext`, `PluginRuntime`).

```yaml
# type/my_tool.type.yaml
extends: mcp.tool::au-mcp-sdk
fields:
  #: absolute path of the file to act on.
  path: String
  #: recurse into subdirectories.
  recursive?: Boolean
meta:
  - type: plugin-runtime-meta::au-mcp-sdk
    entry: ./src/my-tool.ts
    contractVersion: 0
  - type: tool-presentation-meta::au-mcp-sdk
    description: "what the tool does + when to reach for it"
```

```ts
// src/my-tool.ts
import type { PluginContext, PluginRuntime } from '@arsumbris/au-mcp-sdk'

export function createPlugin(ctx: PluginContext): PluginRuntime {
  return {
    async invoke(input, ctx) {
      // input is already validated against the def's fields
      return { /* a CallableResult */ }
    },
  }
}
```

## Build a hook

A hook is an `mcp.hook` subtype — NO fields, NO presentation (it has no agent-facing surface).
Its `plugin-runtime-meta` lists the `shapes` it fills; the ESM exports the function per shape.

1. **Write the def** — `type/<name>.type.yaml`, `extends: mcp.hook::au-mcp-sdk`, no `fields`.
2. **Attach `plugin-runtime-meta`** — `entry`, `contractVersion: 0`, and `shapes: [...]` (a subset of `[observer, mediator, stamper]`).
   - optional: `priority` (ordering among hooks), `critical: true` (a governance floor that must fail CLOSED — refuse to serve if its code fails to load).
3. **Implement the ESM** — export `createPlugin`, returning only the functions for the shapes you declared.
   - **observer** — `onEvent(event)`; throw-isolated, must never throw into the session.
   - **mediator** — `decide(action, ctx)` returns allow / deny / inject / ask; optional `review(event, ctx)` is a post-tool voice back to the agent.
   - **stamper** — `stamp(writeCtx)` returns `Stamp[]` folded into the governed write's commit.

```yaml
# type/my_hook.type.yaml
extends: mcp.hook::au-mcp-sdk
meta:
  - type: plugin-runtime-meta::au-mcp-sdk
    entry: ./src/my-hook.ts
    contractVersion: 0
    shapes: [mediator, stamper]
```

```ts
// src/my-hook.ts
import type { PluginContext, PluginRuntime } from '@arsumbris/au-mcp-sdk'

export function createPlugin(ctx: PluginContext): PluginRuntime {
  return {
    decide(action, ctx) { /* mediator: allow | deny | inject | ask */ },
    review(event, ctx) { /* mediator: optional post-tool voice */ },
    stamp(writeCtx) { /* stamper: return Stamp[] */ },
  }
}
```

## Step - mount and verify

1. **Mount your package** in the workspace, so the engine sees its `type/` defs.
2. **Confirm discovery** — the def must resolve as a subtype of its base:
   - a tool shows under `subtypes(mcp.tool)`; a hook under `subtypes(mcp.hook)`.
   - if it is missing, the def did not mount or does not `extends` the right base.
3. **Check for authoring diagnostics** — a mis-shaped def surfaces as an engine diagnostic.
   - a common one: `subtype-missing-required-meta` means a required meta block is absent (a tool needs `tool-presentation-meta`; both kinds need `plugin-runtime-meta`).
4. **Launch and exercise it** — a tool appears in the agent's tool list; a hook takes effect on the events / actions / writes it targets.

## The line between a tool and a hook

Do NOT put agent-facing input on a hook, or make a tool silently gate things.
- a tool's fields ARE its public input schema; a hook has none.
- a tool is invoked and returns; a hook watches, gates, or stamps around other actions.
Pick the kind by who acts: the agent (tool) or the kernel (hook).
