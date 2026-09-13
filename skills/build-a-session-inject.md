---
type: mcp.skill::au-mcp-sdk
name: build-a-session-inject
description: How to author an mcp.inject instance — ALWAYS-ON context a package ships that lands in the agent's context at session start. Use when adding standing orientation (as opposed to a triggered skill) to a package that speaks the au-mcp-sdk.
---

# Build a session inject

An inject is ALWAYS-ON context: its body lands in the agent's context at session start.
Your package ships it as one markdown file; the kernel packs it into the generated session-start slots.

## What an inject is (and when to use one instead of a skill)

An inject is the UNCONDITIONAL delivery class of the three agent-facing kinds.
- a **tool** applies when the agent CALLS it.
- a **skill** applies when its description MATCHES the agent's intent.
- an **inject** applies UNCONDITIONALLY, every session, before the user says anything.

So an inject is **PREPAID** — its full body costs on EVERY session, up front.
That drives the authoring rule:
- unconditional standing context a session should always hold -> an inject.
- conditional "do this when X" guidance -> a skill (see build-a-skill). Cheaper, since it costs only when triggered.

Reach for an inject for orientation the agent must have from turn one.
Reach for a skill for anything the agent needs only sometimes.

## Step 1 - write the instance

One markdown file. The BODY is the always-on content.

```markdown
---
type: mcp.inject::au-mcp-sdk
name: my-orientation
description: what this standing context IS (shown to the human deciding whether to pay for it)
---

The prose here lands in the agent's context at every session start.
```

Note `description` here is NOT a trigger (an inject always applies, so nothing matches on it).
It is a cost-justification LABEL for the human picker. Contrast a skill, whose description IS the trigger.

## Step 2 (optional) - pull in linked nodes with a hop walk

An inject can fan out beyond its own body: its outbound wikilinks are a hop frontier the walk follows.
Add these fields only when you want more than the body:

```markdown
---
type: mcp.inject::au-mcp-sdk
name: my-moc-orientation
description: standing orientation that pulls in the nodes it links
depth: 1                        # reference hops out from this file (absent/0 = body alone)
edge-kinds: [field-reference]   # which edge kinds the walk follows
show: body                      # body (prose only, default) | body-and-frontmatter (whole file)
---
```

- `depth?` — how many reference hops out to follow, seeding at this file. Absent or `0` injects the body alone. Each reached node is injected under its own provenance header.
- `edge-kinds?` — a CLOSED enum of which edge kinds the walk follows: `field-reference`, `field-string-wikilink`, `contributing`, `navigational`.
  - REQUIRED past depth 1. An unfiltered depth-2 walk through a hub / MOC can eat the whole session budget.
  - it is an enum on purpose: a typo is a loud authoring error, not a silent "followed nothing".
- `show?` — what to render per reached node. `body` (prose only, default), or `body-and-frontmatter` (the whole file, when the frontmatter fields ARE the data, or to make a frontmatter-edge fanout legible).

## Step 3 - mount, discover, verify

1. **Mount your package** in the workspace so the engine sees the file.
2. **Confirm discovery** — the instance surfaces under `instances_of('mcp.inject')` (an INSTANCE of one type, not a subtype).
3. **Know the default set** — WHICH injects a session gets is chosen per launch:
   - the role-scoped default set: entry / edit members are in it; dep / discover members are opt-in. So a consumed member OFFERS an inject, never imposes it.
   - or an agent-profile's explicit `inject` selection.
4. **Watch the budget** — injects are packed under a hard character budget. A large body or a wide hop walk can crowd out others. Keep it lean.

## Notes

- Because it is prepaid, prefer a skill unless the context is genuinely always needed.
- Where the file lives is free (discovery is workspace-wide), but a `skills/` or dedicated directory at the repo root keeps injects found and linkable, and it SHIPS.
