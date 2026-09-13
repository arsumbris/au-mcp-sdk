// The plugin contract.
//
// A capability the kernel surfaces is a PLUGIN, and is one of two KINDS (the split of
// decision 2608242056). The kernel reads the manifest `kind` to know how to wire it, and
// runs plugins in fixed phases (mediate -> act -> observe, P3).
// - a TOOL — the agent-facing CALLABLE (read_file, write_file). It has an input schema (its
//   fields), a presentation, appears in the advertised tool list, and returns a result. A
//   tool fills exactly one role, so it declares NO `shapes`.
// - a HOOK — a KERNEL-INTERNAL capability the agent never sees. It fills one or more phase
//   SHAPES (P2) and may be more than one:
//   - OBSERVER: watches events, never invoked by the agent (trace).
//   - MEDIATOR: intercepts an action and decides allow / deny / inject.
//   - STAMPER: augments a governed write with stamps folded into its commit.
//   - SESSION-START: runs once at session-open and returns computed context to inject
//     (the decision-capable twin of the void `Observer.onRun('run-start')`).
//
// `callable` is NOT a shape — it IS a TOOL. `PluginManifest` is a discriminated union on
// `kind`: a `ToolManifest` carries the agent-facing surface (description/inputSchema/
// access), a `HookManifest` carries `shapes`.

/** A globally unique capability id, namespaced under the harness-owned base (e.g. `mcp.read-file`). */
export type PluginId = string

/**
 * The kernel<->plugin manifest contract version the KERNEL expects. A plugin's declared
 * `BaseManifest.contractVersion` is checked against this for exact equality at discovery
 * (au-mcp `discovery.ts`) — a mismatched plugin is refused (critical -> refuse-to-serve,
 * else skipped with a loud warning), never silently loaded at the wrong contract.
 *
 * Distinct from the wire `MCP_CONTRACT_VERSION` (the client<->daemon protocol version):
 * the two contracts version INDEPENDENTLY, though both are `0` today. See
 * [[decision - 2609091649 - the mcp wire and plugin contracts enforce exact-equality, loud fail-closed with no override::au-harness]].
 */
export const PLUGIN_CONTRACT_VERSION = 0

/** The phase shapes a HOOK fills. A TOOL is callable and declares no shape (callable is not a shape). */
export type PluginShape = 'observer' | 'mediator' | 'stamper' | 'session-start'

/**
 * A hook's ordering TIER — a small ordered set of role-named buckets that REPLACES the old raw
 * integer priority (no magic numbers, decision 2609020302). Canonical order `gate -> floor ->
 * policy` (earlier runs first); within a tier the registry orders deterministically by name. The
 * order FOLLOWS from the role, so picking a tier is a meaningful choice, not an arbitrary rank:
 * - `gate` — access / visibility / redirect (decides first, outermost). e.g. the native-tool redirect.
 * - `floor` — always-on safety invariants. e.g. read-before-write, tool-preconditions.
 * - `policy` — capability / user rules (decides last). e.g. workflow guards, user hooks.
 */
export type PluginTier = 'gate' | 'floor' | 'policy'

/**
 * A tool's DECLARED engine-broker access — the TS mirror of the `tool-access-meta` `broker`
 * level (owned here, au-mcp-sdk). `none` = no broker, `read` = read-only broker, `read-write`
 * = the full broker incl. the governed mutation channel.
 *
 * This is the tool stating its own least privilege at DECLARATION time. The kernel uses it
 * two ways: to SCOPE the tool's own broker (the callable path), and — surfaced on the manifest
 * and via `MediationContext.accessOf` — to answer "would this pending action MUTATE?" at
 * `decide`, so a guard covers the write-capable CLASS name-free (no downstream verb table).
 * `read-write` is the mutate-capable class; the finer write-vs-delete split is only knowable
 * post-run (at observe), not at decide.
 */
export type ToolAccess = 'none' | 'read' | 'read-write'

/**
 * The fields EVERY plugin manifest carries, tool or hook. Discovered as a typed instance
 * (P6); the kernel reads this to wire the plugin into the right phases and resolve deps.
 * `PluginManifest` is the discriminated union `ToolManifest | HookManifest` on `kind`.
 */
export interface BaseManifest {
  id: PluginId
  /** Human-readable name, for surfacing to the agent / operator. */
  name: string
  /**
   * Where this plugin comes from: `'core'` for an engine-bundled capability compiled into the
   * kernel (the floor — engine reads + file ops), or the owner REPO NAME of the package
   * that contributed it (a loadable one discovered by mount). The daemon sets it (core
   * literals → `'core'`; discovered subtypes → their `WireSubtype.repo`); the adapter uses
   * it to tell the agent what is engine vs contributed. Self-updating as packages mount —
   * NOT a hand table. Absent until set (defaults to `'core'` at registration).
   */
  provenance?: string
  /** Integer contract version; handshake is exact-equality, no semver. */
  contractVersion: number
  /**
   * Other plugins this one needs (P4). The daemon AUTO-LOADS them; a hard rule
   * whose dep cannot load fails closed. Never silent-degrade a hard governance rule.
   */
  dependsOn?: PluginId[]
  /**
   * The hook's ordering TIER within a phase (`gate | floor | policy`, earlier runs first),
   * replacing the old integer priority (decision 2609020302). A TOOL declares none. Absent
   * defaults to `policy` (a plain plugin sorts after the gate + floors). Within a tier, the
   * registry orders deterministically by name.
   */
  tier?: PluginTier
  /**
   * Fail-CLOSED-at-load. A `critical` plugin whose LOADABLE discovery fails (its
   * `createPlugin` throws, or its entry exports none) must NOT be silently skipped:
   * the daemon refuses to serve (aborts before the socket binds), naming the plugin.
   * For a governance mediator, governance evaporating on our own fault is worse than
   * refusing — the session must never run UNGATED because the gate quietly failed to load.
   * Default (absent/false): the old best-effort skip-and-continue. This is the loadable
   * counterpart of the static `dependsOn` fail-closed already enforced at construction.
   *
   * `critical` also means MANDATORY to an agent-profile (decision 2609020302): a critical hook always
   * runs and a profile's `hooks` whitelist cannot exclude it (listing one is redundant, the validator
   * complains). The two are ALIGNED — a mandatory hook that fails to load must refuse-to-serve, since
   * silently skipping it is as bad as excluding it. This is a LOAD-and-selection guarantee only; a
   * critical OBSERVER is still throw-isolated at RUN-time (run-time isolation is a separate axis).
   */
  critical?: boolean
  /**
   * The plugin cannot function without the durable SESSION CONTINUITY state (e.g. a workflow
   * step-gate that needs the prior step). On a resume that LOST that state (retired/wiped), the
   * daemon hides this plugin's tools + denies its calls (Tier 1); if its capability (its
   * `provenance`) is in the session's `require` set, it escalates to a session-wide write-block
   * (Tier 2). Absent/false -> continuity is irrelevant to this plugin (it works fresh). See
   * [[spec - session continuity requirements - a data-lost resume hides an optional capability and fails a required one closed::au-harness]].
   */
  requiresContinuity?: boolean
}

/**
 * A TOOL manifest — the agent-facing CALLABLE (`kind: 'tool'`). Sourced from an `mcp.tool`
 * subtype (fields = input, a `tool-presentation-meta`). A tool declares no `shapes`; it is
 * callable by being a tool. Only a tool carries the agent-facing surface below.
 */
export interface ToolManifest extends BaseManifest {
  kind: 'tool'
  /**
   * Agent-facing description, surfaced to the MCP client. Sourced from the tool's
   * `tool-presentation-meta` on its def (decision 2606251602); the daemon sets it,
   * the adapter forwards it. Optional on the wire (absent until the engine is
   * reachable / a tool declares the meta); the adapter falls back to `name`.
   */
  description?: string
  /**
   * Optional proactive trigger: WHEN to reach for this tool unprompted. Sourced from the
   * tool's `tool-presentation-meta` `guidance` field; the daemon sets it, the adapter
   * forwards it into the session's orientation. Rides the manifest exactly like
   * `description`, so a session's up-front guidance covers exactly the tools it has and no
   * downstream layer keys notes by tool name. Absent for most tools, which have no trigger.
   */
  guidance?: string
  /**
   * The tool's input JSON Schema (Draft 2020-12), surfaced to the MCP client.
   * GENERATED at discovery from the tool's `mcp.tool.<tool>` subtype FIELDS by
   * au-type-codegen's emitter (the PRODUCER); the daemon sets it, the adapter
   * forwards it. Rides the manifest exactly like `description` (decision 2606251602 /
   * plan 2606102230 action 5) — so LOADABLE tools carry their schema too, not just
   * the core set a static artifact could cover. Optional on the wire (absent until
   * the engine is reachable / the tool's def is mounted); the adapter falls back to
   * a permissive open-object schema.
   */
  inputSchema?: Record<string, unknown>
  /**
   * The tool's DECLARED engine access (`ToolAccess`). Uniform across CORE and LOADABLE tools:
   * a core tool declares it at its definition site, a loadable tool via its `tool-access-meta`
   * (the daemon sets it from `requestedBroker`). This is the name-free source for "does this
   * action mutate?" — a mediator reads it at `decide` via `MediationContext.accessOf`. Absent
   * defaults to `none`. NOT a security boundary; a transparency + default-scope fact.
   */
  access?: ToolAccess
}

/**
 * A HOOK manifest — a KERNEL-INTERNAL capability (`kind: 'hook'`). Sourced from an `mcp.hook`
 * subtype. It has no agent-facing surface (no description / inputSchema / access); it fills one
 * or more phase `shapes`. A hook that brokers gets a read-only broker from the daemon, not a
 * declared `access`.
 */
export interface HookManifest extends BaseManifest {
  kind: 'hook'
  /** One or more phase shapes this hook fills (observer / mediator / stamper / session-start). Non-empty. */
  shapes: PluginShape[]
}

/**
 * What a plugin declares about itself: a discriminated union on `kind` (decision 2608242056).
 * The kernel narrows by `kind` — a `ToolManifest` is wired as a callable, a `HookManifest`'s
 * `shapes` are registered into the mediate/act/observe phases.
 */
export type PluginManifest = ToolManifest | HookManifest

// --- CALLABLE ---------------------------------------------------------------

/** A tool the agent can invoke. The kernel surfaces it; the MCP-server shim relays the call. */
export interface CallableTool {
  /** Invoke with validated input; resolve a result the agent sees. */
  invoke(input: unknown, ctx?: CallableContext): Promise<CallableResult>
}

/**
 * What the kernel knows about the CALL, as opposed to its input.
 *
 * Passed to every callable and ignored by almost all of them. It exists so a tool that acts
 * on "this session" does not have to make the agent name its own session id — the daemon
 * already knows it from the invoke request, and a value the agent has to supply is a value
 * the agent can get wrong or forge.
 *
 * Optional, so a tool that does not care keeps a one-argument signature.
 */
export interface CallableContext {
  /** The invoking session, when the call carries one. Workspace-scoped calls have none. */
  session?: string
  /** The session's launch/governance facts + this plugin's per-session config, when the call
   *  carries a session. Absent for workspace-scoped calls. */
  launch?: SessionLaunch
  /**
   * READ-ONLY access to this session's live event log — the SAME `consultTrace` a mediator gets
   * (MediationContext), handed to a callable so a tool that REPORTS on session state can compute
   * its OWN payload rather than depending on a mediator's pre-tool `inject` to be useful. That
   * dependency is a real trap: an inject-fed status tool is inert in any client without the
   * PreToolUse channel; a callable that reads its own trace answers everywhere.
   *
   * Read-only by design: a callable that reports needs the trace, not `emit` / `broker`. Present
   * only when the call carries a `session` (a workspace-scoped call has no log to read); a tool
   * that does not report on session state simply never touches it.
   */
  consultTrace?: import('./trace.ts').ConsultTrace
}

/** The outcome of a callable invocation, handed back to the agent. */
export interface CallableResult {
  /** Free-form result payload returned to the agent. */
  content: unknown
  /** True if the call failed; `content` then describes the error. */
  isError?: boolean
  /**
   * A DAEMON-INTERNAL read-view update a governed write reports back, so the kernel keeps the
   * writing session's `readView` accurate WITHOUT a re-read (session FRESHNESS, Mechanism 3). Never
   * returned to the agent — the kernel applies it at the invoke site (where the session is known)
   * and drops it. `set` records `path -> POST-write content hash` (from the mutation reply, the exact
   * hash the session now "saw"); `remove` names paths whose entry is void (a delete target, a rename
   * source). A write self-supplies this; a non-write callable omits it.
   */
  readViewUpdate?: {
    set?: { path: string; hash: string }
    remove?: string[]
  }
}

// --- OBSERVER ---------------------------------------------------------------

/** Watches the event stream; never denies, never returns a result. (trace is the first.) */
export interface Observer {
  /**
   * Called once per event, after mediators have decided and the action ran. `config` is the
   * observer's OWN typed config from the active agent-profile's `hookConfig` (decision 2609021429),
   * keyed by its manifest id — the observer-phase analog of `MediationContext.hookConfig` and the
   * session-start `config` param. `undefined` when the profile configures none. Lets a per-session
   * observer (e.g. the provenance recorder gating persistence on `mode`) read its config, which the
   * bare event carries no channel for.
   */
  onEvent(event: SessionEvent, config?: unknown): void
  /**
   * Called when a session lifecycle FACT occurs. Optional.
   *
   * The kernel states what happened; the observer decides what it means. That split is what
   * keeps a recorder REPLACEABLE: without it the kernel would have to know that some specific
   * plugin wants to run some specific thing at session end, which is the coupling that makes
   * a "plugin" a built-in wearing a plugin's shape.
   *
   * Best-effort by contract: a throwing observer must not take a session-close or a turn with
   * it, so the kernel isolates each call.
   */
  onLifecycle?(signal: SessionLifecycle, session: string, config?: unknown): void
  /**
   * Called on a RUN-lifecycle fact — a run boundary or the terminal retirement — carrying the run
   * identity. Optional; best-effort (a throwing handler must not take the session). Distinct from
   * `onLifecycle`: these carry a `run` payload a recorder needs to segment or finalize (e.g.
   * au-provenance starts a ledger segment on `run-start` and finalizes on `session-retire`).
   *
   * `config` is this observer's typed hookConfig (as on `onEvent`), so a run-boundary write (e.g. the
   * run-start ledger pin) can honor a per-session `mode: off` too. `undefined` when none configured or
   * the session is gone (a terminal retire).
   */
  onRun?(event: RunLifecycle, config?: unknown): void
}

/**
 * A session lifecycle fact the kernel observes and reports.
 *
 * - `turn-end`: the harness reported that a turn finished. Only ever arrives from an adapter
 *   that sends it; an adapter that does not simply never produces this signal.
 * - `session-close`: the session is ending. The last point at which a recorder can act on a
 *   complete session.
 */
export type SessionLifecycle = 'turn-end' | 'session-close'

/**
 * A RUN-lifecycle fact the kernel emits to plugins. A session is a durable identity spanning many
 * runs (one open->close episode each); these mark the run boundaries and the terminal retirement,
 * carrying the run identity a consumer needs to rehydrate or finalize.
 *
 * - `run-start`: a run began. `isResume` distinguishes a fresh run from a resumed one; `priorRun`
 *   names the last run's index on a resume (absent on a fresh run).
 * - `run-end`: this run's episode paused; the session goes dormant (not terminated).
 * - `session-retire`: the session ends for real; a recorder finalizes and releases.
 *
 * See [[spec - session run lifecycle - a durable session is a series of runs keyed by run-seq and rehydrated from a minimal un-forgeable store::au-harness]].
 */
export type RunLifecycle =
  | { kind: 'run-start'; session: string; run: number; isResume: boolean; priorRun?: number }
  | { kind: 'run-end'; session: string; run: number }
  | { kind: 'session-retire'; session: string; lastRun: number }

/** The kernel-core event shape every observer sees. Concrete leaf types extend this. */
export interface SessionEvent {
  /** Discriminator, namespaced (e.g. `tool_start`, `tool_denied`, `user_prompt`). */
  kind: string
  /** The kernel's monotonic per-session RUN index, stamped on append. A `--resume` opens the next
   *  run; combined with `seq` it is the ledger-stable identity `(run, seq)`. See `LedgerLine` +
   *  [[spec - session run lifecycle - a durable session is a series of runs keyed by run-seq and rehydrated from a minimal un-forgeable store::au-harness]]. */
  run: number
  /** Monotonic per-RUN sequence number, stamped by the daemon on append. A `--resume` opens the next
   *  run, so `seq` restarts; pair with `run` for a ledger-stable id. */
  seq: number
  /** Opaque per-session id. */
  session: string
  /** Event payload; the trace plugin owns its concrete typing. */
  data: unknown
  /**
   * The event's REAL (authored) time, ISO-8601. The PRODUCER sets it when the true
   * time differs from capture time — notably LIFTED events (assistant messages lifted
   * from the transcript at Stop, whose real time lives in the transcript). Absent ->
   * the writer stamps capture time (correct for live-hooked events). `at` is the
   * CHRONOLOGICAL key; `seq` is the daemon's capture/append order — they differ for
   * deferred lifts, so order a trace by `at`.
   */
  at?: string
  /**
   * OPAQUE idempotency key for this event, set by the PRODUCER. When present, the kernel records
   * the event at most once per session: a second `observe` carrying a `dedupeKey` already seen this
   * session is a no-op (not appended, not fanned to observers). The kernel NEVER interprets it — it
   * is an idempotency token like an HTTP one, so the kernel stays capability-agnostic.
   *
   * Set it on events a producer may re-submit. The CC adapter sets it on LIFTED events (the
   * transcript re-scan re-sees the same events each PostToolUse): the assistant message `uuid`, or a
   * tool `tool_use_id`. Live, fire-once events (a hooked `tool_call`) leave it unset and are never
   * deduped — which is required, since those carry the read/served-view enrichment the kernel must
   * always process. Seeded on resume from the replayed conversation, so a re-lift after `--resume`
   * dedupes without consulting any ledger. See
   * [[decision - 2609131240 - observe is idempotent by an opaque dedupeKey deduped at the kernel before fan-out::au-harness]].
   */
  dedupeKey?: string
}

// --- MEDIATOR ---------------------------------------------------------------

/**
 * What a mediator says AFTER a tool ran (the `review` return). `text` is surfaced to the agent
 * on the tool's OWN result (the adapter's PostToolUse `additionalContext`); void / no text is
 * silent. Kept a struct, not a bare string, so a later field (a structured verdict) is additive.
 */
export type ReviewResult = { text?: string } | void

/** Intercepts an action before it runs and decides what happens; may also speak AFTER it ran. */
export interface Mediator {
  /** Decide allow / deny / inject for one pending action, given the trace state. */
  decide(action: PendingAction, ctx: MediationContext): Promise<Decision> | Decision
  /**
   * The POST-tool twin of `decide`. Optional. Called once per observed event (a completed
   * `tool_call`, an emitted transition, …) AFTER the tool ran, so a mediator can narrate a
   * CONSEQUENCE its `decide` turn could not: "gate cleared → now at X", or the sharp case, a
   * SILENT failed exit gate — "⚠ still at s_make — exit gate unmet: required field 'size'". The
   * returned `text` rides the causing tool's own result via the adapter's PostToolUse
   * `additionalContext`, so success and FAILURE both announce, instead of success announcing on
   * the next call and failure staying silent.
   *
   * Why this is the mediator's turn, not the observer's: the observer (`onEvent`) is void,
   * throw-isolated, and REPLACEABLE — a recorder whose failure must never touch the session. A
   * post-tool VOICE is a decision, not a recording, so it belongs with `decide`. Best-effort all
   * the same: the kernel isolates a throwing `review` so it cannot take the observe or the session.
   */
  review?(event: SessionEvent, ctx: MediationContext): Promise<ReviewResult> | ReviewResult
}

/** An action the agent is about to take, surfaced to mediators. */
export interface PendingAction {
  /** The harness-native tool name (e.g. `Bash`) or a gate tool id. */
  tool: string
  /** The proposed input. */
  input: unknown
}

/** The human's answer to a `requestApproval`. */
export type ApprovalVerdict = 'granted' | 'denied'

/**
 * What a mediator asks a human to approve, plus the facts the prompt needs to be actionable.
 * The human still reads the chat to judge; these fields let them LOCATE the right chat and see
 * what is being gated. The daemon adds the session id.
 */
export interface ApprovalRequest {
  /** Short prompt title, e.g. the gate / escape name. */
  title: string
  /** The question / reason shown in the prompt body. */
  reason: string
  /** The tool being gated, so the human can identify the action. */
  tool?: string
  /** A SHORT summary of the tool input. Keep it small — detail lives in the chat. */
  inputSummary?: string
  /** Correlation id for the gated tool call, stamped onto the recorded verdict event. */
  toolUseId?: string
}

/**
 * A read-only view of a session's LAUNCH state, handed to a plugin so a LOADABLE mediator or
 * callable can branch on the same per-session facts the built-in floors close over — INCLUDING
 * its own per-session CONFIG, set at launch.
 *
 * WHY THIS EXISTS: the built-in floors are constructed per-session by the daemon over
 * `session.info`; a loadable plugin is built ONCE per daemon (shared across sessions), so it
 * cannot close over per-session state. This surfaces that state on the per-call context instead,
 * so e.g. a provenance guard can be "on for THIS session" rather than workspace-wide.
 */
export interface SessionLaunch {
  /** The gate tool-name prefix, when the session is gated. */
  gatePrefix?: string
  /**
   * The session's NATIVE-tool allowlist — the native-tool counterpart to the profile's typed
   * `tools`, resolved DAEMON-SIDE from the active profile at session-open (no `AU_MCP_NATIVE_TOOLS`
   * env; it mirrors how the typed `tools` axis resolves). Tri-state:
   * - absent / `undefined` -> ALL native tools allowed (the hard default).
   * - `[]` -> NO native tool allowed (a true whitelist with nothing on it).
   * - `[names]` -> ONLY those native tools allowed.
   * The redirect plugin reads it: absent -> inert; present -> allow a native tool iff it is
   * listed (the au-mcp gate tools stay available regardless — they are the gate surface, not
   * natives). No tool is ever implicitly allowed; it is a whitelist with no exceptions.
   */
  nativeToolAllowlist?: string[]
}
// A plugin's per-session config no longer rides `SessionLaunch` — the untyped `AU_MCP_PLUGIN_CONFIG`
// channel is RETIRED (decision 2609021429). Typed config is delivered per phase: `onSessionStart(ctx,
// config)`, `MediationContext.hookConfig` / `WriteContext.hookConfig`, and the observer `config` param.

/**
 * One resolved type identity of a previewed write's product. A COMPACT mirror of the engine's
 * `WireTypeIdentity` — au-mcp-sdk mirrors engine types rather than depending on au-engine-sdk
 * (the `Stamp` / frame precedent), so a gate reads `identities` without an engine-sdk dependency.
 */
export interface PreviewIdentity {
  name: string
  repo: string
}

/**
 * One whole-file diagnostic on a previewed product. A COMPACT mirror of the engine's
 * `WireDiagnostic` — just the fields a gate needs (span / related / fix are dropped). `severity`
 * is a bare string (the engine's catalog is open + additive; known values are
 * `error` / `drift` / `warning` / `hint`), so a gate checks `severity === 'error'`.
 */
export interface PreviewDiagnostic {
  code: string
  severity: string
  message: string
}

/** One blast-radius entry: another file whose diagnostics DIFFER because of the previewed write. */
export interface PreviewBlastEntry {
  path: string
  diagnostics: PreviewDiagnostic[]
}

/**
 * The agent-facing result of previewing a pending mutation (`MediationContext.previewAction`).
 * OWNED by au-mcp-sdk, a compact projection of the engine's `preview_mutation` read. Discriminated
 * on `kind`:
 * - `product`: the write WOULD land. A gate checks `identities` contains the demanded type AND
 *   `diagnostics` carry no error-severity finding. `hash` is the expected-hash a later REAL write
 *   can guard on (null for a delete). `blastRadius` is the per-file diagnostics change elsewhere.
 * - `reject`: a STRUCTURAL refusal (an edit/delete of an absent file, an absent or non-unique
 *   old_string, a stamp on a non-list field, a path mounting nowhere). It is DATA, not an error.
 */
export type ActionPreview =
  | {
      kind: 'product'
      path: string
      hash: string | null
      identities: PreviewIdentity[]
      diagnostics: PreviewDiagnostic[]
      blastRadius: PreviewBlastEntry[]
    }
  | { kind: 'reject'; message: string; detail?: unknown }

/** The handles a mediator is given alongside the action, to inform its decision. */
export interface MediationContext {
  /** The invoking session's id. A mediator always runs within one. */
  session: string
  /**
   * The current RUN index of the active episode (kernel-stamped identity half; pairs with the
   * `(run, seq)` a mediator keys production order off). A durable session is a SERIES of runs;
   * this is the one in progress. Read `sessions.runOf` by the daemon.
   */
  run: number
  /**
   * Whether THIS run continues a prior run (a resume) rather than starting fresh. Mirrors the
   * `run-start` fact's `isResume` (delivered eagerly via `Observer.onRun`); surfaced here so a
   * mediator that DECIDES on continuity can read it LAZILY at `decide` time — the resume fact is
   * NOT an `EventKind` in the trace, so `consultTrace` cannot recover it. A gate that must fail
   * closed on an observable-absent resume (record present, the prior run's observable slice not
   * replayed) checks `isResume && the active episode's run < ctx.run && no observable events at
   * that run`. Composes with `PluginManifest.requiresContinuity`: the manifest flag says "I need
   * continuity", this ctx field says "continuity is degraded THIS run".
   */
  isResume: boolean
  /** The prior run being continued on a resume (mirrors `run-start.priorRun`), else undefined. */
  priorRun?: number
  /** This session's launch/governance facts + the plugin's own per-session config. */
  launch: SessionLaunch
  /**
   * A mediator's OWN typed config from the active agent-profile's `hookConfig` (decision 2609021429),
   * keyed by the plugin's manifest id — the TYPED replacement for `launch.config(pluginId)` for hooks.
   * Returns the ONE `hookConfig` instance configuring this mediator (its typed fields, engine-validated),
   * or `undefined` when the profile configures none. A mediator is a singleton per session, so it takes
   * one config (unlike a session-start hook, which the daemon runs once per instance). Resolved from the
   * graph at session-open + stashed on the session, so it reaches both `decide` and `review`. Optional on
   * the context (a mediator that needs no config never reads it; a bare-launch session has none).
   */
  hookConfig?(pluginId: string): unknown
  /** Query the daemon's live session log (consult-trace, P5). See ./trace. */
  consultTrace: import('./trace.ts').ConsultTrace
  /**
   * Whether this session has READ (or been SERVED) `path`. Canonicalizes (realpath) both sides, so
   * an engine-resolved path matches the agent's read path across symlinks. The read-view is
   * SPOOF-RESISTANT: populated only from observed read CALLS (`read_file`) + declared
   * serves-contracts, never from response text. This is the ready-made predicate a
   * read-precondition gate consults — "deny the tool until its `onFiles` are read." Read-only, and
   * on EVERY mediator's context, so it is a shared handle, not a privilege: a user plugin builds
   * its own precondition floor over the same predicate. Kernel maintains the read-view (session
   * freshness the write seam needs regardless); the DENY policy is the plugin's.
   */
  hasRead(path: string): boolean
  /**
   * The engine content HASH this session recorded when it READ `path` (an ABSOLUTE path), or
   * `undefined` if the session never read it. The read-time half of the read-before-write check: a
   * guard compares it to the file's CURRENT hash (a `content` read via `broker`) to catch an
   * overwrite of a file that CHANGED since the session saw it. Exact-path lookup over the read-view
   * only (no realpath, no served-view) — the write's `file_path` is the same absolute path the read
   * used. Sibling to `hasRead`: the boolean answers "was it read", this answers "at what hash".
   */
  readHash(path: string): string | undefined
  /** The session's declared native tool surface (e.g. for redirect to find gate equivalents). */
  nativeTools: import('./adapter.ts').NativeTool[]
  /**
   * READ-ONLY engine access, when an engine is reachable. A mediator DECIDES (allow/
   * deny/inject); it never mutates — the write rides the action it allows, through the
   * governed mutation channel. So the kernel grants a read-only broker only: a guard
   * consults the engine (a validation verdict, "is this file tracked") to inform its
   * gate. `mutate` is denied. A mediator that needs no engine read never touches it, and
   * must handle `broker.available()` returning false (no engine for this workspace).
   */
  broker?: PluginBroker
  /**
   * Record an event through the kernel bus; observers (e.g. trace) see it. The
   * daemon stamps session + seq. A mediator uses this so deny and trace cannot
   * desync — the kernel sequences decide -> record.
   */
  emit(kind: string, data: unknown): void
  /**
   * Ask the HUMAN to approve or deny, and LEARN the verdict. Unlike `Decision.ask` — which
   * defers to CC's native prompt and NEVER returns the outcome (CC exposes no permission
   * verdict to any hook) — this runs the daemon's OWN approval surface and RESOLVES with the
   * human's choice. So a guard can gate an escape, get the answer, and return allow/deny
   * KNOWING it. The daemon RECORDS the verdict to the ledger (an `approval_granted` /
   * `approval_denied` event) before resolving, so the reject is audited even if the guard
   * forgets to. BLOCKS until answered (no timeout): an unanswered escape never proceeds —
   * blocking IS the fail-closed here. The prompt carries the session id + the request fields.
   */
  requestApproval(req: ApprovalRequest): Promise<ApprovalVerdict>
  /**
   * The pending action's DECLARED engine access, resolved from the target tool's manifest
   * `access` (`ToolAccess`). `read-write` = the action would MUTATE (route through the governed
   * mutation channel); `read` / `none` = it would not. `undefined` when the tool is unknown
   * (e.g. a native tool with no manifest).
   *
   * This is what lets a guard cover the write-capable CLASS name-free — "is this a covered
   * write?" is `accessOf(action) === 'read-write'`, not a match against a verb list. The class
   * is coarse by necessity: `decide` runs BEFORE the tool, so only the declared capability is
   * known, not the finer write-vs-delete an actual mutation reveals at observe.
   */
  accessOf(action: PendingAction): ToolAccess | undefined
  /**
   * DRY-RUN the pending write and read its PRODUCT — the would-be file's type identities +
   * diagnostics — WITHOUT it landing. The mediator hands back the action it is deciding; au-mcp
   * maps `(tool, input)` to the engine mutation (reusing its execution-time mapping) and calls the
   * engine's `preview_mutation`, so a mediator forwards NOTHING adapter-specific (content-key
   * stability is a non-issue — au-mcp already holds the call). This is what lets a per-call gate
   * do "this step permits `write_file`, but only a valid `mcp.plan`": preview, then allow iff the
   * product's `identities` contain the demanded type AND its `diagnostics` carry no error.
   *
   * READ-ONLY, decide-time: preview is a read over an overlay, no disk write, no commit — the
   * agent's turn is untouched (no preview tool call it sees). Resolves `undefined` when the action
   * is NOT a previewable mutation (not write/edit/delete, or a native tool au-mcp cannot map) or no
   * engine is reachable — a mediator branches on that like it does `broker.available()`.
   */
  previewAction(action: PendingAction): Promise<ActionPreview | undefined>
}

/**
 * allow: proceed, optionally attaching a `note` surfaced to the agent as context on the allowed
 * action (the adapter maps it to PreToolUse `additionalContext`). The note is for a distinct,
 * first-class signal on the allow branch — e.g. "approved by the human" after a granted escape —
 * rather than that signal riding an `inject`. deny: block, with a reason + optional pointer.
 * inject: allow + add context. ask: defer to the HUMAN — the adapter surfaces a native
 * approve/deny prompt for this exact action (CC PreToolUse `permissionDecision: 'ask'`); `reason`
 * is shown in the prompt. The mediator does NOT learn the verdict (no hook refire); approval is
 * inferred downstream from whether the action then ran (a captured `toolCall`). Used for
 * human-in-the-loop confirmation (e.g. approve a type proposal before authoring).
 */
export type Decision =
  | { kind: 'allow'; note?: string }
  | { kind: 'deny'; reason: string; useInstead?: string }
  | { kind: 'inject'; text: string }
  | { kind: 'ask'; reason: string }

// --- SESSION-START ----------------------------------------------------------

/**
 * A KERNEL-RESOLVED snapshot of what is active and mounted this session, computed ONCE at
 * session-open and shared by every session-start hook, so no hook re-resolves the profile allowlist
 * itself (decision 2609071712). A generic seam; the `requiredScope-check` hook is its first client.
 *
 * `mounted` is present in the workspace graph; `active` is `mounted` intersected with the session's
 * tool/skill allowlist (the profile's `tools` field). For a TYPE or MEMBER ref there is no allowlist
 * analog, so a consumer treats `active == mounted` for non-tool/skill refs.
 */
export interface SessionScope {
  /** Agent-facing tool names: `mounted` in the workspace, `active` after the profile allowlist. */
  tools: { active: string[]; mounted: string[] }
  /** Skill names: `mounted` in the workspace, `active` after the profile allowlist. */
  skills: { active: string[]; mounted: string[] }
  /** Mounted workspace member (repo) names. */
  members: string[]
  /** The active agent-profile name, when the session has one. */
  profile?: string
}

/**
 * The handles a session-start hook is given. A read-only slice of what a mediator gets
 * (MediationContext), MINUS the per-action fields — there is no PendingAction at session open, so
 * no `accessOf` / `previewAction` / `requestApproval` / read-view predicates. A session-start hook
 * queries the graph (`broker`) and/or the live log (`consultTrace`) to COMPUTE context; it never
 * mutates and never decides a tool call (that is the mediator's turn).
 */
export interface SessionStartContext {
  /** The opening session's id. */
  session: string
  /** The RUN index of the episode being opened (pairs with `(run, seq)`; a durable session is a series of runs). */
  run: number
  /** Whether this open RESUMES a prior run rather than starting fresh (mirrors `run-start.isResume`). */
  isResume: boolean
  /** The prior run being continued on a resume (mirrors `run-start.priorRun`), else undefined. */
  priorRun?: number
  /** This session's launch/governance facts + this plugin's own per-session config. */
  launch: SessionLaunch
  /** Query the daemon's live session log (consult-trace). See ./trace. */
  consultTrace: import('./trace.ts').ConsultTrace
  /**
   * READ-ONLY engine access, when an engine is reachable. This is how a hook COUNTS or INSPECTS the
   * graph at session open (e.g. `broker.read('instances_of', { type })`). `mutate` is denied — a
   * session-start hook computes context, it never writes. Must handle `broker.available()` false
   * (no engine for this workspace).
   */
  broker?: PluginBroker
  /**
   * The kernel-resolved session scope (decision 2609071712): tools / skills active vs mounted, the
   * mounted members, and the active profile. Resolved ONCE at session-open so a hook reads it
   * instead of re-deriving the allowlist. Always provided by the daemon.
   */
  scope: SessionScope
  /** Record an event through the kernel bus (observers see it); the daemon stamps session + seq. */
  emit(kind: string, data: unknown): void
}

/**
 * What a session-start hook produces: optional context to inject at session start. INJECT-ONLY by
 * design (decision 2609020302) — a hook that ALSO wants to BLOCK tools on the same graph condition
 * additionally declares the `mediator` shape and denies in `decide`; the tool axis already has a
 * decision-capable seam, so this shape adds only the missing session-open INJECT one. `inject` is a
 * LIST of blocks (the adapter packs them into the session-start context); void / empty injects
 * nothing. Kept a struct so a later additive field stays non-breaking.
 */
export type SessionStartResult = { inject?: string[] } | void

/**
 * Runs ONCE at session-open, before the agent's first turn, and returns computed context to inject.
 * The decision-capable twin of the void `Observer.onRun('run-start')`: same firing moment, but this
 * shape can put COMPUTED text in front of the agent. Recomputed per session-open (unlike the static,
 * launch-time `mcp.inject`), so it reflects LIVE graph state each session.
 *
 * Best-effort by contract: a throwing session-start hook must not take the session open — the kernel
 * isolates each call and proceeds with no inject from it.
 *
 * `config` is the hook's TYPED per-instance configuration (decision 2609020302): the daemon runs the
 * hook once per `hookConfig` instance of it in the active agent-profile, passing that instance's
 * engine-validated fields (the hook narrows `config` to its own au-type-codegen'd config type — the
 * engine already validated it). A config-less always-on hook is called once with `config` undefined.
 * This SUPERSEDES `ctx.launch.config()` for hooks: config is typed graph data, not an untyped blob.
 */
export interface SessionStartHook {
  onSessionStart(ctx: SessionStartContext, config?: unknown): Promise<SessionStartResult> | SessionStartResult
}

// --- STAMPER ----------------------------------------------------------------

/**
 * One `{ key, value }` trailer of the `attribution` write rider (engine schema 26). The TS mirror
 * of the engine `AttributionEntry` (owned by the engine; mirrored here so the agent-facing contract
 * needs no engine-sdk dependency, the same porting the `Stamp` mirror uses). au-mcp is the one layer
 * that sees both shapes and asserts their parity (broker.ts).
 *
 * Folded VERBATIM and UNINTERPRETED into a write's own commit beside `Mutation-Id`, read back by
 * `commit_meta`'s `trailers`. Carries the CALLER concept (the session / span a write belongs to) so
 * a commit states which unit of work made it; the engine stays domain-pure. The engine enforces the
 * well-formed-token rule and reserves its own keys (`Mutation-Id` etc.), rejecting a malformed or
 * colliding key — so the slot cannot forge an engine record.
 */
export interface AttributionEntry {
  /** The trailer key (a well-formed git-trailer token; the engine rejects a reserved-key collision). */
  key: string
  /** The trailer value, stored verbatim. */
  value: string
}

/**
 * A caller-supplied record the engine idempotently ensures into a named frontmatter list-field
 * of the file a write touches, folded into that write's OWN commit. The TS mirror of the engine
 * `stamp` write rider (owned by the engine; mirrored here so the agent-facing contract needs no
 * engine-sdk dependency, the same porting the frame / socket utilities use).
 *
 * OPAQUE to the engine: it validates nothing about `field` / `record` / `matchOn`. A stamper that
 * wants its record type-checked opts in via `PluginManifest.validateStamps`.
 */
export interface Stamp {
  /** The frontmatter sequence key the record is ensured into. */
  field: string
  /** The record to ensure: an arbitrary structured value, rendered to YAML by the engine. */
  record: unknown
  /**
   * The optional dedup predicate, a map of element-slot to value. With it, the stamp is a NO-OP
   * when some existing element of `field` carries every pair; else `record` is appended. Without
   * it, `record` is always appended. Serialized as `match_on` on the wire.
   */
  matchOn?: Record<string, unknown>
}

/**
 * A stamper's contribution to ONE governed write: its stamp(s), plus optional `ensure_mixins`
 * directives that ride the SAME write. The TS mirror of the engine `ensure_mixins` write rider
 * (schema 25, the type-claim analog of `stamps`), surfaced through the seam so a stamper that
 * TYPES a file (not just stamps it) can ensure the owning mixin on the file's `type:` claim,
 * folded into the write's OWN commit. So a stamped field lands DECLARED, not advisory-invalid.
 *
 * `ensureMixins` is a per-WRITE rider (a list on the whole write), NOT a per-`Stamp` field — a
 * `Stamp` appends a record to a list-field, a mixin adds a type to the `type:` claim, they are
 * siblings. So it sits beside `stamps` here, not inside a `Stamp`. A stamper that ensures no
 * mixin returns a bare `Stamp[]` and never constructs this.
 */
export interface StampResult {
  /** The stamps to fold into this write (the `stamps` rider). */
  stamps: Stamp[]
  /**
   * `::repo`-qualified type names to ensure as mixins on the written file's `type:` claim, e.g.
   * `"provenance::au-provenance"`. Absent or empty means no mixin. Carried ONLY on the three
   * verbs the engine rider accepts (`write_file` / `edit_file` / `rename`); the seam drops it on
   * any other stampable verb.
   */
  ensureMixins?: string[]
  /**
   * Whether an un-appliable mixin REJECTS the whole write (strict, the engine default) or is
   * skipped so the write still lands (lenient, `false`). Omitted → the engine applies its default
   * (strict). Ignored without `ensureMixins`.
   */
  ensureMixinsStrict?: boolean
  /**
   * The optional `attribution` write rider (engine schema 26): commit-metadata trailers
   * ({@link AttributionEntry}) folded into THIS write's OWN commit, read back by `commit_meta`'s
   * `trailers`. Unlike `stamps` (a record in the file's CONTENT) and `ensureMixins` (the file's
   * `type:` claim), attribution lands in the git COMMIT, not the file — so it is the ONE rider a
   * `delete` can carry (a delete has no surviving file to stamp or type). Absent or empty writes no
   * trailer. The kernel injects it un-forgeably, like `stamps`; a stamper contributing only
   * attribution (e.g. on a delete) returns `{ stamps: [], attribution: [...] }`.
   */
  attribution?: AttributionEntry[]
}

/**
 * How a governed write touched its file: the neutral KIND the kernel derives and a stamper maps.
 * `delete` carries no file-CONTENT stamp (there is no surviving file), so a stamper sees it ONLY to
 * contribute commit-level `attribution`; `create` / `edit` / `rename` also carry stamps + mixins.
 */
export type WriteKind = 'create' | 'edit' | 'rename' | 'delete'

/**
 * The write-time facts the kernel assembles and hands a stamper — everything only the daemon
 * knows at the moment of a governed write. A stamper reads these to build its stamp(s); any
 * engine-read access it needs for coverage (e.g. "is this file's type tracked") it captures from
 * its `PluginContext.broker` at construction, not from here.
 */
export interface WriteContext {
  /** The session making the write, for the record + its matchOn. */
  session: string
  /** create / edit / rename, derived by the kernel from the verb + target existence. */
  kind: WriteKind
  /** The file the write touches (the verb's primary file). */
  path: string
  /** The OLD path, set only on a `rename`. */
  from?: string
  /** The write's timestamp (the engine commit time), set only on a `rename`. */
  at?: string
  /** The session's launch facts + this plugin's per-session config — the coverage policy source. */
  launch: SessionLaunch
  /**
   * A stamper's OWN typed config from the active agent-profile's `hookConfig` (decision 2609021429),
   * keyed by its manifest id — the stamper-phase analog of `MediationContext.hookConfig`. The typed
   * replacement for `launch.config` for hooks (e.g. the provenance stamper reads its `mode`). Optional;
   * `undefined` when the profile configures none.
   */
  hookConfig?(pluginId: string): unknown
}

/**
 * Augments a governed write with stamps folded into its commit. The FOURTH shape.
 *
 * The kernel runs every registered stamper at the write's invoke seam, collects their stamps into
 * a list, and hands the list to the engine's stamp rider — un-forgeably: the agent cannot supply a
 * stamp, the kernel overwrites any agent-sent value with the stamper's.
 *
 * A stamper OWNS the content (the field, the record, the matchOn, any `ensure_mixins`, and any
 * commit-level `attribution`) and its COVERAGE: return `[]` (or `{ stamps: [] }`) to decline a
 * write. The kernel owns the pipe (the WriteContext, the KIND, the un-forgeable attach). So the
 * kernel never types a consumer's record vocabulary.
 *
 * A `delete` reaches a stamper too (WriteKind gained `delete`), but only to contribute
 * `attribution` — the kernel folds no stamp / mixin into a delete (there is no surviving file), so
 * a delete stamper returns `{ stamps: [], attribution: [...] }`.
 */
export interface Stamper {
  /**
   * Produce this stamper's contribution to a write. Return a bare `Stamp[]` for stamps-only (the
   * common case), or a `StampResult` to also ensure mixins on the file's `type:` claim and/or fold
   * commit-level `attribution`. Async when it consults the engine for coverage.
   */
  stamp(ctx: WriteContext): Promise<Stamp[] | StampResult> | Stamp[] | StampResult
}

/**
 * A plugin's runtime is the union of the interfaces for its kind/shapes.
 * The kernel narrows by manifest.kind — a tool provides `CallableTool`; a hook provides the
 * interfaces for its `shapes` (Observer / Mediator / Stamper / SessionStartHook).
 */
export type Plugin = Partial<CallableTool & Observer & Mediator & Stamper & SessionStartHook> & {
  manifest: PluginManifest
}

// --- LOADABLE MODULE CONTRACT (decision 2606231421) -------------------------
//
// A LOADABLE tool (first-party-non-core, third-party, or user-repo — anything not
// compiled into the kernel) is discovered as an `mcp.tool` subtype and dynamically
// imported from its type-def meta's `entry`. The entry ESM exports ONLY the shape
// FUNCTIONS via `createPlugin` — never metadata: the manifest is derived from the
// type-def + its `plugin-runtime-meta` (decision 2606111610, "the loaded module adds
// only the shape functions"). CORE tools skip this; they register manifest literals.

/** The just-the-shape-functions half of a Plugin; the manifest comes from the type-def. */
export type PluginRuntime = Partial<CallableTool & Observer & Mediator & Stamper & SessionStartHook>

/**
 * One framed response from the engine over the broker. `type: 'error'` / `ready: false`
 * signal failure; `result` carries the read payload or mutation outcome. Structurally the
 * same frame au-mcp's EngineBroker returns, so its broker satisfies `PluginBroker` directly.
 */
export interface EngineFrame {
  type?: string
  ready?: boolean
  result?: unknown
  [key: string]: unknown
}

/**
 * The engine-access capability a loadable tool MAY be granted through its `PluginContext`.
 * A minimal subset of au-mcp's EngineBroker: one governed read + one governed mutation.
 * The kernel decides whether to hand this to a given tool — the seam a future per-tool
 * permission surface gates (see the au-host tool-permission wish). A tool that needs no
 * engine access simply never reads `ctx.broker`.
 */
export interface PluginBroker {
  /** Whether an engine appears reachable for this workspace. */
  available(): boolean
  /** One read over the engine wire: `{ read: op, ...args }` -> a framed response. */
  read(op: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<EngineFrame>
  /** One mutation through the engine's governed mutation channel (write_file/edit_file/…). */
  mutate(verb: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<EngineFrame>
}

/**
 * What the daemon hands a loadable plugin at construction. `workspace` is always present;
 * `broker` is OPTIONAL — the kernel grants it to tools that need engine reads or governed
 * writes, and may withhold it (a synthesis-only tool, or a future per-tool permission that
 * denies it). A tool that reads `ctx.broker` must handle its absence.
 */
export interface PluginContext {
  /** The workspace root the daemon serves. */
  workspace: string
  /** Engine access, when granted. Absent for synthesis-only or permission-denied tools. */
  broker?: PluginBroker
}

/** The shape a loadable tool's entry ESM must export. */
export interface PluginModule {
  /** Build the shape functions for this tool. Called once per daemon load. */
  createPlugin(ctx: PluginContext): PluginRuntime
}
