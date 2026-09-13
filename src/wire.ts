// The wire protocol between a client and the au-mcp daemon.
//
// Every client is thin and speaks this: the CC MCP-server shim, the CC hooks,
// au-host, other UIs. The daemon holds the state; clients send requests and
// await correlated responses over a Transport.

import type { AdapterInfo, NativeTool } from './adapter.ts'
import type { PendingAction, Decision, SessionEvent, ToolManifest } from './plugin.ts'
import type { TraceQuery, TraceSlice } from './trace.ts'

/** The contract version; handshake is exact integer equality. */
export const MCP_CONTRACT_VERSION = 0

/** A correlation id minted by the client per request. */
export type RequestId = number

/** Client -> daemon. */
export type ClientRequest =
  /** A harness session begins; the adapter declares itself. */
  | { kind: 'session-open'; id: RequestId; info: AdapterInfo }
  /** A harness session ends. */
  | { kind: 'session-close'; id: RequestId; session: string }
  /** Decide an action before it runs (mediation). */
  | { kind: 'mediate'; id: RequestId; session: string; action: PendingAction }
  /** Record an event (observers run inside the daemon). */
  | { kind: 'observe'; id: RequestId; session: string; event: SessionEvent }
  /** Invoke a callable tool the daemon surfaces. Workspace-scoped (session optional).
   *  `allowed` is the caller's tool allowlist: the daemon refuses a tool outside it.
   *  Absent means every tool (see the tool-visibility spec's absent-means-all rule). */
  | { kind: 'invoke'; id: RequestId; session?: string; tool: string; input: unknown }
  /** Query the live session log. */
  | { kind: 'consult-trace'; id: RequestId; session: string; query: TraceQuery }
  /** The harness reports that a TURN ended. A pure lifecycle FACT, not an instruction: the
   *  adapter says what happened in its harness, the kernel forwards it to the observers, and
   *  whichever recorder is installed decides what it means. Kept off the event vocabulary
   *  because it is not an observation about the session, and an adapter that never sends it
   *  simply produces no such signal. */
  | { kind: 'turn-end'; id: RequestId; session: string }
  /** The session's governance posture (`denyNative`, from the native-tool allowlist being
   *  present). Lets an input-layer hook (UserPromptSubmit) decide whether to block an ungoverned read path
   *  like an @-mention, without running a tool call. */
  | { kind: 'session-guards'; id: RequestId; session: string }
  /** List the active callables + native redirects. Workspace-scoped (session optional).
   *  `allowed` is the caller's tool allowlist: the daemon advertises exactly those tools.
   *  Absent means every tool, an empty list means none (the tool-visibility spec). */
  | { kind: 'list-capabilities'; id: RequestId; session?: string; profile?: string }
  /** Liveness + version probe; needs no session. Operator/status control. */
  | { kind: 'ping'; id: RequestId }
  /** Stop the daemon. Operator/lifecycle control. */
  | { kind: 'shutdown'; id: RequestId }
  /** List DORMANT sessions (cleanly-closed, resumable) for the host to show. Control-plane,
   *  session-less; NOT an agent tool. See the session-retention spec. */
  | { kind: 'list-dormant'; id: RequestId }
  /** Blast-radius preview: which dormant sessions a proposed retention `windowMs` WOULD retire,
   *  shown before the policy change applies. Control-plane, read-only. */
  | { kind: 'retention-preview'; id: RequestId; windowMs: number }
  /** Explicitly retire a dormant session now (host/app, user-directed). Control-plane; NOT an
   *  agent tool — ending a session for good is not the agent's to take. */
  | { kind: 'retire-session'; id: RequestId; session: string }
  /** Get au-mcp's current retention window (the dormancy policy). Control-plane, read-only. */
  | { kind: 'retention-config'; id: RequestId }
  /** Set au-mcp's retention window, in days. Control-plane; au-mcp persists it via its OWN
   *  (scoped-config) storage — the caller names no storage. Returns the applied window. NOT an
   *  agent tool. See the session-retention spec. */
  | { kind: 'set-retention-window'; id: RequestId; windowDays: number }
  /** An adapter replays a resumed session's OBSERVABLE conversation (prompts, assistant messages,
   *  tool calls) from its own transcript, so `consultTrace` shows the prior run(s). The kernel injects
   *  them READ-ONLY (never through observe, so the read-views stay empty) and REFUSES any governance
   *  kind — governance is daemon-sourced and un-forgeable. Identity is daemon-stamped: the adapter
   *  supplies only `{kind, data, at}`; the kernel owns `(run, seq)`. See the session-run-lifecycle
   *  spec's inert-rehydration contract. */
  | { kind: 'session-rehydrate'; id: RequestId; session: string; events: ReplayEvent[] }
  /** Fetch the COMPUTED session-start context: the inject blocks this session's `session-start`
   *  hooks produced at open (they ran a live-broker graph query, e.g. "N instances of type T").
   *  The adapter calls it once per session start and emits the blocks into the session-start slot.
   *  Session-scoped; recomputed per session-open, unlike the static launch-time `mcp.inject`. */
  | { kind: 'session-start-context'; id: RequestId; session: string }
export type DaemonResponse =
  | { kind: 'opened'; id: RequestId; contractVersion: number }
  | { kind: 'closed'; id: RequestId }
  | { kind: 'decision'; id: RequestId; decision: Decision }
  /** Acknowledges an `observe`. `text` carries any mediator `review` output for this event —
   *  the POST-tool announcement channel — for the adapter to surface as PostToolUse
   *  `additionalContext`. Absent when no mediator reviewed (the common case). Additive + optional,
   *  so it needs no `MCP_CONTRACT_VERSION` bump: a client that ignores it, and a daemon that never
   *  sets it, still agree at the same version. */
  | { kind: 'observed'; id: RequestId; text?: string }
  /** Acknowledges a `turn-end`. Carries nothing: what the signal CAUSED is decided by
   *  whichever recorder is installed, so neither the kernel nor the adapter knows. */
  | { kind: 'turn-ended'; id: RequestId }
  | { kind: 'invoked'; id: RequestId; result: unknown; isError?: boolean }
  | { kind: 'trace'; id: RequestId; slice: TraceSlice }
  /** The session's governance posture: `denyNative` (a native-tool allowlist is set, so
   *  unlisted native tools are forced through the gate), for an adapter to report + inject the "use the gate" note. */
  | { kind: 'guards'; id: RequestId; denyNative: boolean }
  | { kind: 'capabilities'; id: RequestId; callables: ToolManifest[]; redirects: NativeTool[] }
  | { kind: 'pong'; id: RequestId; contractVersion: number; workspace: string }
  | { kind: 'shutdown-ack'; id: RequestId }
  /** The dormant sessions (`list-dormant`), or the ones a proposed window would retire
   *  (`retention-preview`); discriminated by the originating request. */
  | { kind: 'dormant-sessions'; id: RequestId; sessions: DormantSession[] }
  | { kind: 'retention-preview'; id: RequestId; sessions: DormantSession[] }
  /** au-mcp's current retention window — answers `retention-config` and acks `set-retention-window`
   *  with the applied value. */
  | { kind: 'retention-config'; id: RequestId; windowDays: number; windowMs: number }
  /** Acknowledges a `retire-session`, naming the retired id. */
  | { kind: 'retired'; id: RequestId; session: string }
  /** Acknowledges a `session-rehydrate`: how many observable events LANDED, and how many were
   *  REFUSED as non-observable (the forgery-refusal tally). */
  | { kind: 'rehydrated'; id: RequestId; injected: number; refused: number }
  /** The COMPUTED session-start inject blocks (from the session's `session-start` hooks), for the
   *  adapter to pack into the session-start context. `[]` when no session-start hook produced any.
   *  Additive + optional, so it needs no `MCP_CONTRACT_VERSION` bump. */
  | { kind: 'session-start-context'; id: RequestId; inject: string[] }
  | { kind: 'error'; id: RequestId; message: string }

/**
 * One OBSERVABLE event an adapter replays on resume (`session-rehydrate`). Deliberately identity-free:
 * the adapter reconstructs it from its transcript, which carries no `(run, seq)`, so it supplies only
 * the kind, the payload, and the production time. The kernel stamps `(run, seq)` (the prior run + a
 * fresh monotonic seq) — ordering in `consultTrace` is by `at`, so the stamped seq is a tiebreaker
 * only. Governance kinds are refused kernel-side; a well-behaved adapter sends only observable ones.
 */
export interface ReplayEvent {
  kind: string
  data: unknown
  /** ISO-8601 production time (the transcript entry's timestamp), the authoritative order key. */
  at?: string
  /** OPAQUE idempotency key (see `SessionEvent.dedupeKey`). On replay the kernel does NOT dedupe the
   *  replayed events themselves (replay is inert, read-only), it SEEDS its per-session seen-key set
   *  from these, so a subsequent live re-lift of the same events dedupes without a ledger read. */
  dedupeKey?: string
}

/** A dormant session's store, as surfaced to the host for resume-or-clean-up. */
export interface DormantSession {
  id: string
  run: number
  /** Newest store-file mtime (ms) — the session's last activity. */
  lastActiveMs: number
  /** Total bytes of the session's durable store. */
  sizeBytes: number
  /** The adapter that produced this session — its `mcp.adapter` type name (`AdapterInfo.harness`,
   *  e.g. `mcp.adapter.cc` / `mcp.adapter.codex`). The RESUME DISCRIMINATOR: a session is resumable
   *  only by its own adapter (you cannot resume a Codex session with the CC adapter), so a host pairs
   *  it with `resumeRef` to pick the launcher. Optional: a record written before this field existed
   *  has none, and such a session is not adapter-resumable. */
  harness?: string
  /** The adapter's OPAQUE relaunch reference for this session (`AdapterInfo.resumeRef`), persisted
   *  verbatim and returned here. The kernel never parses it. Absent -> not adapter-resumable. */
  resumeRef?: string
  /** The agent-profile locator the session ran under (`AdapterInfo.profile`), so a host can restore
   *  the same capability surface on resume (pass it back as `--profile`) and label the session by it.
   *  Absent -> the session ran bare (no profile). */
  profile?: string
}

/**
 * A bidirectional channel to the daemon. One implementation per location
 * (Unix socket, in-process, test double); the client below never knows which.
 * Mirrors au-host-sdk's HostTransport.
 */
export interface DaemonTransport {
  /** Send one request to the daemon. Fire-and-forget; replies arrive via receive. */
  send(request: ClientRequest): void
  /** Register the handler for responses. Returns a disposer. */
  receive(onResponse: (response: DaemonResponse) => void): () => void
  /**
   * Register a handler invoked ONCE when the underlying channel drops after connecting
   * (the daemon died / the socket closed or errored). Optional: in-process and test
   * transports never drop, so they may omit it. The client uses it to fail every pending
   * request fast instead of hanging forever waiting for a reply that can never come.
   */
  onClose?(handler: (reason?: Error) => void): void
}
