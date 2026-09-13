---
type: mcp.skill::au-mcp-sdk
name: build-a-skill
description: How to author an mcp.skill instance — TRIGGERED agent guidance a package ships and the kernel materializes into the harness at launch. Use when adding a skill (a when-to-use description + instructions) to a package that speaks the au-mcp-sdk.
---

# Build a skill

A skill is TRIGGERED agent guidance: a "when to use me" plus the instructions.
Your package ships it as one markdown file; the kernel materializes it into the harness at launch.
The agent then picks it up with no hardcoded knowledge.

This file you are reading IS an `mcp.skill` instance. Copy its shape.

## What a skill is (and is not)

A skill is the TRIGGERED delivery class of the three agent-facing kinds.
- a **tool** applies when the agent CALLS it.
- a **skill** applies when its `description` MATCHES the agent's intent.
- an **inject** applies UNCONDITIONALLY (see build-a-session-inject).

So the authoring rule:
- conditional, "do this WHEN X" guidance -> a skill.
- unconditional, always-on context -> an inject.

A skill earns its place when the task is a **multi-step sequence** the agent runs.
- per-field "what is this one thing" is already answered by the type-def's `#:` docstrings.
- a skill answers cross-item: which to pick, when, and how to sequence.

## Step 1 - write the instance

One markdown file. Frontmatter claims the type + fields; the BODY is the instructions.

```markdown
---
type: mcp.skill::au-mcp-sdk
name: my-skill
description: what it does + WHEN to reach for it (this line is the trigger)
---

# My skill

The instructions the agent follows, as the markdown body.
Keep it procedural: do X, then Y, verify Z.
```

Fields:
- `name` (required) — the invocable slug; becomes the harness id, invoked `/<owner>:<name>`.
- `description` (required) — the TRIGGER. The harness matches the agent's intent against this to auto-invoke, so lead with what + when.
- `related-tools?` — the `mcp.tool` defs this skill is ABOUT (discovery only; NOT materialized, no permission effect).
- `allowed-tools?` — the `mcp.tool` defs pre-approved while the skill runs (no permission prompt mid-flow). A SEPARATE axis from `related-tools`.

The body is freeform prose. There is no `body:` contract and no `entry`/code — a skill is guidance, not a callable.

## Step 2 - write a description that triggers well

The `description` is the ONLY thing the harness matches on. A vague one never fires.
- name the task and the moment: "Use when adding a new engine read..." beats "about reads".
- put the trigger phrase the agent would think in the description, not only in the body.

## Step 3 - mount, discover, verify

1. **Mount your package** in the workspace so the engine sees the file.
2. **Confirm discovery** — the instance must surface under `instances_of('mcp.skill')`.
   - skills are INSTANCES of one type, not subtypes. `subtypes('mcp.skill')` is wrong and finds nothing.
   - a match missing `name` or `description` is SKIPPED with a reason (never silently dropped) — check for it if your skill does not appear.
3. **Materialize it** — the launcher runs `gen-skills` at launch; the skill lands as a native harness skill.
   - for Claude Code: each owning repo becomes one generated CC plugin, so your skill is namespaced `/<owner>:<name>`, collision-free.
4. **Exercise it** — the skill auto-invokes when its `description` matches, and is manually invocable by name.

## Notes

- Skills are launch-time STATIC. A mid-session edit takes effect only on relaunch.
- Materialized skills are additive + isolated. They never touch the user's own `.claude/`.
- No engine / no host -> no skills materialize. That is a quiet no-op, never an error.
- Where the file lives is free (discovery is workspace-wide), but a `skills/` directory at the repo root keeps them found and linkable, and it SHIPS.
