---
type: au.engine.readme::au-engine
tldr: The contract SDK for the au-mcp kernel — the wire protocol, the plugin and adapter interfaces, and the agent-facing base type vocabulary. Build against it as the kernel, a plugin author, or a harness adapter. Extend the agent layer by implementing its plugin or adapter interfaces, not by changing the kernel.
---

# Repo Overview

## General Context
Before defining what `au-mcp-sdk` is,
here is some general context of the environment it exists in.

- `arsumbris` is a framework for agentic knowledge work.
- `au-engine` serves a graph over a cross-repo substrate of typed files.
- `au-host` is the UI part of the framework
- `au-mcp` is the agent layer of the framework.

`au-mcp-sdk` is part of this `arsumbris` framework.


## What this is

`au-mcp-sdk` is the **contract** for the `au-mcp` kernel daemon:
- wire protocol
  - the shape of the messages passed between the daemon and its clients
  - framed JSON over a socket
- plugin interfaces
  - what a capability implements to be discovered, loaded, and wired into the kernel
  - two kinds, plus the manifest each declares
    - a **tool** (the agent-facing callable)
    - a **hook** (kernel-internal: observer / mediator / stamper / session-start)
- adapter interfaces
  - what a specific agent harness implements to bind itself to the daemon
  - two sides: the per-session RUNTIME interface (`Adapter`/`AdapterInfo`), and the typed DISCOVERY node (`mcp.adapter`) a launcher enumerates off the engine
- base type vocabulary
  - the engine type-defs the whole agent layer speaks
  - (`mcp.tool`, `mcp.hook`, `mcp.inject`, `mcp.skill`, `mcp.adapter`, and the metas)
  - tools, hooks, and adapters are typed instances the engine validates


`au-mcp` is a workspace-scoped daemon that serves agent sessions.
It is paired 1:1 with the `au-engine` daemon.

The kernel itself holds no knowledge of specific tools,
it is aware only of this SDK.

Everything else is a plugin or an adapter that also speaks this SDK.


`au-mcp-sdk` is the agent-layer peer of the family's other two contract SDKs:
- `au-engine-sdk`, the client contract for the au-engine daemon.
- `au-host-sdk`, the mount contract for the au-host UI layer.


Three kinds of consumer build against it:
- **the kernel** (`@arsumbris/au-mcp`)
  - implements the daemon side of the wire and orchestrates plugins through these interfaces.
- **plugin authors**
  - implement the plugin contract to add capabilities. A capability is one of two KINDS:
    - a **tool**: the agent-facing callable
      - the agent invokes it and gets a result
      - it has an input schema (its fields), a presentation, and appears in the tool list
      - (e.g. read a file, run an engine read, execute plugin-specific code, ...)
    - a **hook**: kernel-internal, the agent never sees it
      - it fills one or more phase SHAPES (a hook may combine them, e.g. mediator + stamper):
        - observers
          - watch the session's events (e.g. a recorder)
        - mediators
          - intercept an action before it runs
          - decide allow / deny / inject (e.g. block certain tools unless conditions are met)
          - plus optional post action message back to the agent
        - stampers
          - contribute an un-forgeable stamp folded into a governed write's commit (e.g. provenance)
        - session-start hooks
          - run once at session-open and return computed context to inject (e.g. query the graph, inject a notice)
          - the decision-capable twin of the void `run-start` observer; recomputed per session, unlike static `mcp.inject`
          - a hook that also wants to BLOCK tools on the same condition co-declares the `mediator` shape
          - its ctx carries a kernel-resolved `scope: SessionScope` (active vs mounted tools / skills, members, profile), computed ONCE so a hook reads it instead of re-deriving the allowlist
- **harness adapters**
  - implement the adapter interface to bind a specific agent harness to the daemon
  - and self-declare an `mcp.adapter` subtype in their own repo, so a launcher discovers them off the engine (location from the def's `source.file`, launch/skills/inject entries on `adapter-runtime-meta`)
  - e.g. `@arsumbris/au-mcp-adapter-cc` for Claude Code


## How to use this

Consumed as **TypeScript source** — there is no build step.
Import from its subpath exports directly.

The surface, by subpath:

- `@arsumbris/au-mcp-sdk/wire`
  - the client ↔ daemon message protocol
  - framed JSON over a socket
- `@arsumbris/au-mcp-sdk/plugin`
  - the plugin contract
    - the two kinds
      - a callable **tool**
      - a **hook** (observer / mediator / stamper / session-start)
    - the manifest each declares
      - (`ToolManifest` / `HookManifest`)
    - the `Decision` a mediator returns
- `@arsumbris/au-mcp-sdk/adapter`
  - the per-harness adapter interface
    - the native tool surface
    - the hook bridge
    - the context-injection channel
    - the session-identity handle
- `@arsumbris/au-mcp-sdk/trace`
  - the consult-trace query interface over a session's live event log
    - the daemon holds the log, plugins query it
- `@arsumbris/au-mcp-sdk/client`
  - a typed client over a daemon transport
- `@arsumbris/au-mcp-sdk/vocabulary`
  - the session-event / ledger-line schema
    - event kinds
    - their data shapes
    - the span-boundary events
    - the `messageBlock` record spoken by the daemon, redirect, adapter, and recorder
- `@arsumbris/au-mcp-sdk/launch-env`
  - `LAUNCH_ENV`
    - the closed `AU_MCP_*` launch-env names + their value parsers
    - imported by both the launcher (producer) and the adapter (reader) so the two agree by construction
- `@arsumbris/au-mcp-sdk/launch-defaults`
  - the scalar hard defaults a session gets when nothing is set
- `@arsumbris/au-mcp-sdk`
  - re-exports all of the above


The base **type-defs** live in `type/` as engine vocabulary (not TypeScript):
- the harness-owned `mcp` base and its subtypes
  - `mcp.tool` (the agent-facing callable)
  - `mcp.hook` (the kernel-internal observer / mediator / stamper / session-start)
  - `mcp.inject`
  - `mcp.skill`
  - `agent-profile`
- and the typed metas a tool or plugin attaches
  - `plugin-runtime-meta`
  - `tool-access-meta`
  - `required-scope-meta` (the capabilities a tool / hook / skill needs AVAILABLE in the session; `requires?: type*[]`; a session-start hook warns per unmet ref)
  - `tool-presentation-meta`
  - `read-precondition-meta`
  - `serves-files-meta`
  - `tool-precondition-meta`
  - `retention-config`

These are mounted in the engine's served workspace,
so the daemon validates tool inputs against them and codegen derives each tool's schema from them.
The daemon reads a def's meta generically off the engine,
so no hand-written TS mirror is kept.


## How to extend this

A quick-start for building your own things on what this SDK offers.
You build these in **your own repo**,
against the contracts here.
The kernel discovers and wires them.


### Build a plugin

A plugin is a package that speaks this SDK.
It is one of two KINDS:
- a **tool** is the agent-facing callable.
  - Define it as an `mcp.tool` subtype
  - its FIELDS are its call input
  - it requires a `tool-presentation-meta` (its description)
- a **hook** is kernel-internal.
  - Define it as an `mcp.hook` subtype
  - with NO fields and NO presentation
  - its `plugin-runtime-meta` lists the `shapes` it fills
    - a subset of `[observer, mediator, stamper, session-start]`
      - (a hook may combine them, e.g. a mediator that also stamps).

The general flow, either kind:
- define the type-def (`extends: mcp.tool` or `extends: mcp.hook`).
  - its `meta` block carries `plugin-runtime-meta`
    - pointing `entry` at your ESM
  - (and, for a hook, listing its `shapes`).
- implement the matching function(s) in that ESM, exported via `createPlugin`.
  - the interfaces come from `@arsumbris/au-mcp-sdk/plugin`.
- mount your package in the workspace
  - the kernel discovers it (`subtypes`/`instances_of`), loads it, and wires it by its `kind`.

#### a tool (callable)
- an `mcp.tool` subtype whose **fields ARE its call input**.
- the daemon
  - validates each call
  - and generates the tool's input schema from those fields (via au-type-codegen)
1) define the def (`extends: mcp.tool`)
2) attach
  - `plugin-runtime-meta` (its `entry`)
  - `tool-presentation-meta` (its description)
3) the daemon discovers it across the served workspace.

```yaml
# type/my_tool.type.yaml — a tool is an mcp.tool subtype; its fields are the call input
extends: mcp.tool::au-mcp-sdk
fields:
  path: String
  recursive?: Boolean
meta:
  - type: plugin-runtime-meta::au-mcp-sdk
    entry: ./src/my-tool.ts
    contractVersion: 0
  - type: tool-presentation-meta::au-mcp-sdk
    description: "what the tool does + when to use it"
```

```ts
// src/my-tool.ts — input arrives already validated against the def's fields
export function createPlugin(ctx) {
  return {
    async invoke(input, ctx) { /* return a CallableResult */ },
  }
}
```

#### a hook (observer / mediator / stamper / session-start)
- an `mcp.hook` subtype
- its `plugin-runtime-meta` lists the `shapes` it fills, plus its ordering `tier`
- the ESM exports the function(s) for them.

```yaml
# type/my_hook.type.yaml — a hook is an mcp.hook subtype; no fields, no presentation
extends: mcp.hook::au-mcp-sdk
meta:
  - type: plugin-runtime-meta::au-mcp-sdk
    entry: ./src/my-hook.ts
    contractVersion: 0
    shapes: [session-start, mediator]   # a subset of [observer, mediator, stamper, session-start]; combine as needed
    tier: policy                        # ordering bucket: gate | floor | policy (earlier decides first)
```

The shape functions, by `shapes` entry:
- **observer**
  - implement `onEvent`
  - it receives every session event.
  - Throw-isolated: a recorder's failure never touches the session.
- **mediator**
  - implement `decide` (pre-tool: allow / deny / inject / ask)
  - plus an optional `review` (post-tool voice).
- **stamper**
  - implement `stamp(writeCtx)`
  - the stamps you return are folded into the governed write's own commit.
- **session-start**
  - implement `onSessionStart(ctx)`
  - runs once at session-open with a read-only `ctx.broker` (query the graph) + `ctx.launch` / `ctx.consultTrace`
  - return `{ inject: [...] }` to put computed context in front of the agent, or nothing.
  - INJECT-ONLY: to also block tools on the same condition, co-declare `mediator` and deny in `decide`.

```ts
// src/my-hook.ts — export only the functions for the shapes the def declares
export function createPlugin(ctx) {
  return {
    onEvent(event) { /* observer: record it; must never throw into the session */ },
    decide(action, ctx) { /* mediator: return allow | deny | inject | ask */ },
    review(event, ctx) { /* mediator: optional post-tool voice back to the agent */ },
    stamp(writeCtx) { /* stamper: return Stamp[] folded into the write's commit */ },
    async onSessionStart(ctx) {
      // session-start: compute at open, e.g. count instances of a type in the graph
      const r = await ctx.broker?.read('instances_of', { type: 'task' })
      const n = Array.isArray(r?.result) ? r.result.length : 0
      return n > 20 ? { inject: [`⚠ ${n} open items of type 'task' — consider triage.`] } : undefined
    },
  }
}
```

**Ordering tiers.** A hook declares a `tier` — `gate | floor | policy` — instead of a raw priority number. The kernel runs earlier tiers first (`gate → floor → policy`); within a tier it orders by name. Pick by role: `gate` for access/visibility/redirect, `floor` for always-on safety, `policy` for capability/user rules (the default).

This flow also ships as a **skill**: [`build-a-plugin`](skills/build-a-plugin.md).
- when this repo is mounted, the kernel materializes it into your harness.
- your agent auto-invokes it on the task, or you call `/au-mcp-sdk:build-a-plugin`.


### Build a harness adapter

Bind a new agent harness to the daemon.
- implement the interface from `@arsumbris/au-mcp-sdk/adapter`:
  - declare your harness's native tool surface
  - bridge its hook I/O
  - carry the session handle.
- hold no policy of your own
  - the generic plugins run against your adapter
  - so a second adapter reuses them.
- self-declare an `mcp.adapter` subtype in your repo's `type/`, so a launcher discovers you off the engine (no hardcoded key):

```yaml
# type/mcp.adapter.myharness.type.yaml — a self-declared adapter node
extends: mcp.adapter::au-mcp-sdk
# no fields — identity IS this def's type name; your live adapter reports the SAME name as AdapterInfo.harness
meta:
  # required by the mcp.adapter base — a launcher gates on these being present
  - type: adapter-runtime-meta::au-mcp-sdk
    contractVersion: 0
    agentBinary: myharness             # the executable NAME to launch (not a path)
    launchEntry: ./bin/launch.ts       # emits the runnable spawn command
    skillsEntry: ./bin/gen-skills.ts   # the skills materializer
    injectEntry: ./bin/gen-inject.ts   # the inject materializer
  - type: adapter-presentation-meta::au-mcp-sdk
    description: "Bridges My Harness to the au-mcp daemon."
    label: "My Harness"                # optional
```

  - identity is the def's type name (opaque — the engine reads no structure from it, so name it what you like); your live `AdapterInfo.harness` must report that exact name, the launcher's join key.
  - a launcher resolves your dir from the def's `source.file`; the entries are explicit, so nothing is hardcoded.
  - your repo must declare `au-mcp-sdk` as a dep and be a workspace member, or the node is not discovered.
  - the full contract: [[spec - mcp.adapter type - the harness adapter as a discovered typed node]].
- `@arsumbris/au-mcp-adapter-cc` (Claude Code) is the reference implementation.


### Build a skill

Ship agent guidance as an `mcp.skill` instance in your repo (markdown with frontmatter).
- at launch the kernel materializes it into a generated, per-owner artifact the harness scans.
  - here is how `au-mcp-adapter-cc` does it:
    - each owning repo becomes its own generated CC plugin (one `--plugin-dir` per owner)
    - which means your skill is namespaced `/<owner>:<skill>`.
  - so the agent picks it up with no hardcoded knowledge
- `description` is the trigger; the markdown body is the instructions.

```markdown
---
type: mcp.skill::au-mcp-sdk
name: my-skill
description: what it does + when to reach for it (this line is the trigger)
---

# My skill

The instructions the agent follows, as the markdown body.
```

This flow also ships as a **skill**: [`build-a-skill`](skills/build-a-skill.md).
- it is itself an `mcp.skill` instance teaching how to write them, so it doubles as the copy-me exemplar.
- auto-invokes on the task, or call `/au-mcp-sdk:build-a-skill`.

### Build a session inject

Ship always-on context as an `mcp.inject` instance in your repo.
- its body lands in the agent's context at session start.
  - "always-on" means no per-turn trigger (unlike a skill, which fires on a description match).
  - WHICH injects a session gets is chosen per launch:
    - the role-scoped default set (entry / edit members are in it; dep / discover are opt-in).
    - or an agent-profile's `inject` selection.
- use it for standing orientation a session should always have.
- its own outbound wikilinks are a **hop frontier** the inject can walk.
  - so a MOC-shaped inject fans out to the nodes it links,
    - each injected under its own provenance header.

```markdown
---
type: mcp.inject::au-mcp-sdk
name: my-orientation
description: what this standing context is (shown in the human picker)
# optional — walk the seed's links and pull in what they reach:
depth: 1                        # how many reference hops out to follow (absent/0 = body alone)
edge-kinds: [field-reference]   # which edge kinds the walk follows (required past depth 1)
show: body                      # body (prose only, default) | body-and-frontmatter (whole file)
---

The prose here lands in the agent's context at every session start.
```

The optional hop fields, for an inject that pulls in more than its own body:
- `depth?` — reference hops out from the seed. Absent or `0` injects the body alone.
- `edge-kinds?` — a CLOSED enum of which edge kinds the walk follows
  - (`field-reference`, `field-string-wikilink`, `contributing`, `navigational`).
  - REQUIRED past depth 1 — an unfiltered depth-2 walk through a hub/MOC can eat the whole session budget.
- `show?` — what to render per reached node: `body` (prose only, default), or `body-and-frontmatter` (the whole file, when the frontmatter fields ARE the data).

An inject is **prepaid** — its full body costs on every session, before the user says anything.
- so the authoring rule: unconditional context is an `mcp.inject`, conditional guidance is an `mcp.skill`.

This flow also ships as a **skill**: [`build-a-session-inject`](skills/build-a-session-inject.md).
- it covers the prepaid trade-off and the optional hop-walk fields.
- auto-invokes on the task, or call `/au-mcp-sdk:build-a-session-inject`.


### Build an agent profile

An `agent-profile` bundles the capability surface a session launches with: which skills, injects, and tools are active, and which native tools the session may use.
- `tools?` — the visible `mcp.tool` set. Absent = every discovered tool; an empty list = none.
- `skills?` — the `mcp.skill` set to materialize. Absent = every discovered skill; an empty list = none.
- `inject?` — the `mcp.inject` set to fire. Absent = the role-scoped default set (entry / edit fire, dep / discover are opt-in); an empty list = none.
- `nativeToolAllowlist?` — the native tools the session may use, as a whitelist. Absent = all (the default); an empty list = none; a list = only those. Everything else is redirected to the `au_*` gate tools.
- `hooks?` — the non-critical hook whitelist (the off-switch), as `mcp.hook` def-refs. Absent = every hook; an empty list = only `critical` hooks; a subset = those + the critical ones. A `critical` hook is mandatory and can never be excluded.
- `hookConfig?` — typed hook CONFIG, as inline-or-ref `mcp.hook` INSTANCES (a hook's fields ARE its config). A hook runs once per configured instance. Independent of `hooks`: this configures, it does not select.

A launcher (au-host, or a bare CLI) resolves `tools`/`skills`/`inject` into the launch env at launch. `hooks`/`hookConfig` resolve differently: the launcher passes only the profile locator (`AU_MCP_PROFILE`), and the daemon reads the profile from the graph at session-open to resolve them (they reflect live graph state each session — see the launch-surface spec's resolution asymmetry).

```yaml
# an agent-profile instance selecting + configuring a session's capability surface
type: agent-profile::au-mcp-sdk
tools:
  - mcp.tool.read_file
  - mcp.tool.au_diagnostics
skills:
  - my-skill
inject:
  - my-orientation
nativeToolAllowlist:
  - Read
  - Bash
hookConfig:
  - type: mcp.hook.instance-count-notice::au-mcp-core
    forType: "[[task]]"   # a typed def-ref; a typo is an engine diagnostic on the profile
    threshold: 20
```