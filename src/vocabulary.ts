// The generic agent-session event vocabulary.
//
// The SDK owns the GENERIC kinds + their base field shapes (a CONTRACT spoken by
// the daemon, redirect, the adapter, and trace); a per-harness adapter EXTENDS
// this with harness-specific leaves. See [[decision - 2606121303 - the sdk owns
// the session-event vocabulary, the trace plugin owns only the format::au-harness]].
// These shapes are the `data` payload of `SessionEvent` (which carries the
// envelope: kind / seq / session). `user_prompt` is the turn boundary, matching
// `TURN_BOUNDARY_KIND`.
//
// THIS FILE IS THE LEDGER SCHEMA, and the ONLY contract over its lines. The ledger is an
// unparsed `.ndjson` ASSET, so nothing validates it engine-side and no line claims a type.
//
// There were once engine type-defs for this vocabulary (`type/session-log.yamls`, a sealed
// `sessionEvent` family). They existed because the trace WAS a typed instance, one event per
// record with a real `type:` claim. Once the ledger became an asset nothing produced those
// instances, so the defs described a shape with no writer and were retired. The exhaustiveness
// they bought is now the `EventKind` union below.
// See [[spec - session capture - an unparsed ledger is the record and a lifted span index is
// its provenance surface::au-harness]].
//
// The TYPED half of capture is the lifted SPAN INDEX, a separate vocabulary.

import { TURN_BOUNDARY_KIND } from './trace.ts'
import type { SessionEvent } from './plugin.ts'

/** The generic event kinds (snake_case, as written to disk). */
export const EventKind = {
  SessionStart: 'session_start',
  UserPrompt: TURN_BOUNDARY_KIND, // 'user_prompt' — the turn boundary
  AssistantMessage: 'assistant_message',
  ToolStart: 'tool_start',
  ToolCall: 'tool_call',
  ToolDenied: 'tool_denied',
  ToolFailed: 'tool_failed',
  Judgment: 'judgment',
  SpanOpen: 'span_open',
  SpanClose: 'span_close',
  Compaction: 'compaction',
  Notification: 'notification',
  // A human's verdict on a mediator `requestApproval` (kernel-owned approval, distinct from
  // the redirect's `tool_denied`). Recorded so a REJECT is audited, and a mediator can tell
  // "denied" from "not yet answered" via consultTrace. See MediationContext.requestApproval.
  ApprovalGranted: 'approval_granted',
  ApprovalDenied: 'approval_denied',
  SessionEnd: 'session_end',
} as const
export type EventKind = (typeof EventKind)[keyof typeof EventKind]

// --- the generic `data` shapes per kind ------------------------------------

export interface SessionStartData {
  source?: string
  transcript?: string
}
export interface UserPromptData {
  prompt?: string
}
/** One assistant content block. Enum-discriminated, no sealed family needed. */
export interface MessageBlock {
  kind: 'text' | 'thinking'
  text: string
}
export interface AssistantMessageData {
  uuid?: string
  blocks: MessageBlock[]
  /** The agent whose turn this is — a SUBAGENT's id, absent for the main agent. See {@link ToolCallData.agent_id}.
   *  Lift-sourced (a subagent's messages ride its own transcript), stamped by the SubagentStop lift. */
  agent_id?: string
  /** The agent-type of {@link AssistantMessageData.agent_id}. See {@link ToolCallData.agent_type}. */
  agent_type?: string
}
// Field names are snake_case to match the type-defs, the on-disk format, and the
// tool-input convention (file_path, ...) — i.e. what codegen will emit.
export interface ToolStartData {
  tool?: string
  input?: unknown
  tool_use_id?: string
  /** The agent that made this call. See {@link ToolCallData.agent_id}. */
  agent_id?: string
  /** The agent-type that made this call. See {@link ToolCallData.agent_type}. */
  agent_type?: string
}
export interface ToolCallData {
  tool?: string
  input?: unknown
  tool_use_id?: string
  duration_ms?: number
  response?: unknown
  /**
   * WHICH AGENT in this session made the call — a SUBAGENT's opaque id, absent for the MAIN agent.
   *
   * A subagent shares the session's ONE ledger and is distinguished per-event, not per-session:
   * every one of a session's agents writes to the same log, so a consumer partitions that log by
   * `agent_id` (main-agent events carry none and stay the top-level thread; each subagent's events
   * form their own). It is a GENERAL session-relationship fact, not a provenance hook — attribution
   * ("which agent touched this file"), per-agent gating, and per-agent cost all read the same field.
   *
   * Stamped by whichever producer knows it: the adapter forwards the harness's per-call agent handle
   * (CC surfaces `agent_id` on the subagent tool hooks; the main agent's calls carry none). Unset
   * exactly when the call was the main agent's.
   */
  agent_id?: string
  /**
   * The KIND of the agent named by `agent_id` (e.g. `general-purpose`) — the harness's subagent-type
   * label, forwarded alongside `agent_id`. Unset for a main-agent call (and whenever the harness
   * does not name a type). A coarse grouping key next to the precise per-agent `agent_id`.
   */
  agent_type?: string
  /**
   * The repo file a file-op touched (provenance). An engine git-ref-PINNED reference
   * (`file*@`): a `[[<repo-relative-path>::@<commit>]]` wikilink whose `@<commit>` pin
   * binds to the `::` scope. Deletion-stable: resolves to the bytes at that commit forever; a divergent live
   * target is soft `pinned-reference-drifted` (drift), never an error on this append-only
   * log. The producer assembles the pin from the mutation `CommitSha`. The TS type stays
   * `string` (the pinned wikilink is text); the `file*@` contract is enforced engine-side.
   * Populated for BOTH file-op kinds via `pinnedFileTarget`, by two paths:
   *   - MUTATION (write/edit): from the gate's `FileOpTouch` (the mutation `commit` rides
   *     the tool result; the adapter stamps it). Exact — the pin is the commit just made.
   *   - READ: stamped SERVER-SIDE in the daemon at observe, from the `content` read's
   *     `commit` (no adapter round-trip). Best-effort — the bytes are the working tree's,
   *     the pin anchors HEAD. Off-git (`commit` null) stays unset.
   */
  target?: string
  /**
   * WHICH WAY the `target` edge points: did this call read those bytes, write them, or delete them.
   *
   * Set by whichever producer stamped `target`, because each already knows: the daemon's
   * read path stamps `read`, the mutation path stamps `write` (or `delete`) off the gate's
   * `FileOpTouch`. Unset exactly when `target` is unset.
   *
   * It rides the event so no CONSUMER has to classify a tool NAME to tell a read from a
   * write. A downstream table of tool names is the leak "adapters only adapt" forbids, and
   * the retired viewer proved it rots: every pretty-renderer it keyed on `mcp__gate__*`
   * became dead code the day that prefix changed, silently.
   */
  access?: FileAccess
  /**
   * The PRIOR path of a rename, the name-history edge's source. Set only when `access` is
   * `'rename'`: `target` pins the NEW name, `from` is the OLD repo-relative path. A consumer
   * reconstructs a file's name-history from `(from, at)` windows off this stamped field, never
   * from the input shape or the tool name. Unset for every other access direction.
   */
  from?: string
  /**
   * The produced COMMIT for `span.commits` attribution, as a `[[::@<sha>]]` commit-referent
   * (built by `commitReferent`), when it diverges from `target`'s pin.
   *
   * Set ONLY for a DELETE: a delete's `target` pins the readable LAST-LIVE commit, so the
   * deletion commit (where the file is absent) can no longer be recovered from `target` for
   * attribution. It rides here instead. For write / edit / rename `target` already pins the
   * produced commit, so a consumer reads attribution off `target` and this stays unset.
   *
   * A consumer resolves the sha with `commitOfPinnedTarget`, the same reader it uses on
   * `target`, so no downstream layer parses the wikilink itself.
   */
  committed?: string
  /**
   * WHY this event's `response` is absent, when it is.
   *
   * The ledger never drops content silently. If a payload was not recorded, the event says so
   * and says what to do instead, so a reader can tell "not recorded" from "there was none".
   * - `git`: the bytes are in git at `target`'s commit. Retrievable, and exact.
   * - `input`: not retrievable. This call's `input` states the operation and the path it
   *   touched, so the result is RECONSTRUCTIBLE by replaying it over the committed base.
   * - `cap`: the response is PRESENT but its long strings are truncated. `bytes` says how big
   *   it was. A sidecar may hold the full text, if the workspace opted into one.
   *
   * Absent means the response is whatever it is — present and whole, or genuinely empty.
   */
  elided?: Elision
  /** The response's original serialized size, set whenever `elided` is. Scale, not content. */
  bytes?: number
}

/**
 * Which way a `target` edge points: a read of those bytes, a write of them, a delete, or a
 * rename (a move that carries a name-history edge).
 *
 * A `delete` is recorded as a `tool_call` with `access: 'delete'`; the lift turns it into a
 * tombstone reference on the span's `deleted` slot (au-provenance's span-index vocab). A
 * `rename` is a `tool_call` with `access: 'rename'`, `target` = the NEW-name pin and `from` =
 * the OLD path, so a consumer reconstructs a file's name-history from `(from, at)` windows
 * WITHOUT classifying a tool name. All non-read directions are stamped by the mutation path
 * (the gate `mutationResult`, the one layer that knows the verb), the same producer that
 * stamps `write`.
 */
export type FileAccess = 'read' | 'write' | 'delete' | 'rename'

/**
 * Why a payload is absent from the ledger. Never silence: always a stated reason, and the
 * reasons differ in what they promise.
 *
 * `git` promises retrieval. `input` promises only reconstruction, which is why it is used for
 * a WRITE (whose operation is recorded) and never for a READ (whose content, once dropped, is
 * recorded nowhere). `cap` promises neither: it keeps the response's shape and bounds its
 * text, and is the only one of the three that applies to output git can never hold.
 *
 * NONE of them ever applies to MESSAGE TEXT. User and assistant text is the reasoning record,
 * so it is kept verbatim, never capped and never summarized.
 */
export type Elision = 'git' | 'input' | 'cap'

/**
 * The `data` for a `judgment` event: the agent's pre-write declaration about a covered write.
 *
 * The declaration tool emits this BEFORE the write it is about. The lift folds it onto the
 * span's `judgment` block (au-provenance's span-index vocab), mirroring the span-side record
 * `{ wrote, context, tldr }` across the snake_case / kebab-case seam the lift already crosses.
 */
export interface JudgmentData {
  /** The pinned write this judgment is about: a `[[<path>::@<commit>]]` string. Folds to the
   *  span judgment's `wrote`. */
  target: string
  /** Pinned file refs the agent deemed relevant to the write. Folds to the span judgment's `context`. */
  context?: string[]
  /** The one-line note. Folds to the span judgment's `tldr`. */
  tldr?: string
}

/**
 * The commit a pinned target names, or null when the value is not a pin.
 *
 * The inverse of `pinnedFileTarget`, kept beside it so the layer that WRITES the form is the
 * only one that reads it back. A consumer needing the sha (a span's `commits`) calls this
 * instead of pattern-matching the wikilink itself.
 */
export function commitOfPinnedTarget(target: string | undefined | null): string | null {
  if (typeof target !== 'string') return null
  const m = /^\[\[.*@([^\]@]+)\]\]$/.exec(target)
  return m ? m[1] : null
}

/**
 * One ledger line: the envelope, flat, with the payload nested under `data`.
 *
 * Owned here because this file IS the ledger schema. The writer produces it and the lift
 * consumes it, and neither should restate the shape.
 *
 * There is no header, no per-event id, and no type claim.
 * - the session id is in the filename, and `started` is the first line's `at`.
 * - a session is a durable identity spanning many RUNS (one `open->close` episode each). The kernel
 *   stamps a monotonic `run` on every event, and `seq` is monotonic within one run (it restarts each
 *   run). So ledger-stable identity is `(run, seq)` — `seq` alone is NOT unique within a ledger that
 *   concatenates runs (a `--resume` re-opens the same id and appends). A span's block-id derives from
 *   `(run, seq)` (`r<run>-t<seq>`). Order by `at`, tie-broken by `(run, seq)`.
 *   See [[spec - session run lifecycle - a durable session is a series of runs keyed by run-seq and rehydrated from a minimal un-forgeable store::au-harness]].
 * - nothing validates this file; `kind` is the discriminator.
 */
export interface LedgerLine {
  /** The kernel's monotonic per-session RUN index, stamped on append. A `--resume` opens the next
   *  run; `run` disambiguates the per-run `seq`, so ledger-stable identity is `(run, seq)`. */
  run: number
  /** The daemon's authoritative monotonic per-RUN sequence, stamped on append. Restarts each run;
   *  pair with `run` for a ledger-stable id — see the interface doc. */
  seq: number
  /** The event kind, snake_case, e.g. `tool_call`. The discriminator. */
  kind: string
  /** Production time when known (a lifted event carries the transcript's), else capture time. */
  at: string
  /** The event payload, verbatim and uninterpreted. Absent when the event carries none. */
  data?: unknown
}

/**
 * The canonical ledger ordering: by production time `at`, tie-broken by `(run, seq)`.
 *
 * Single-sourced here (the ledger-schema owner) so no consumer re-spells the rule. `at` (production
 * time) is authoritative; a lifted event carries its transcript time, so append order is not
 * production order. Ties break by `run` then `seq`: within a run `seq` is monotonic, and across runs
 * `run` separates them — `seq` alone is not unique once a session concatenates runs. An absent `at`
 * (a live event before the writer stamps one) sorts as epoch 0, deterministically behind any dated
 * event. See [[decision - 2607301638 - a span is bounded by production time and sequence, and the ledger is never re-sorted::au-harness]].
 */
export function compareByProductionOrder(
  a: { at?: string; run: number; seq: number },
  b: { at?: string; run: number; seq: number },
): number {
  const at = (x: { at?: string }): number => {
    const t = x.at ? Date.parse(x.at) : NaN
    return Number.isNaN(t) ? 0 : t
  }
  return at(a) - at(b) || a.run - b.run || a.seq - b.seq
}

/**
 * The pin material a MUTATION gate result carries so a producer can stamp the
 * touched-file edge (`ToolCallData.target`). A CONTRACT shape: the gate (au-mcp)
 * produces it inside its write/edit result, a per-harness adapter reads it off the
 * tool response and calls `pinnedFileTarget`. Single-sourced here so neither the
 * gate nor the adapter hand-maintains the shape (see "adapters only adapt").
 *
 * MUTATIONS ONLY. A READ is pinned by a different path — server-side in the daemon at
 * observe, straight from the `content` read's `commit` — so it never builds a
 * `FileOpTouch`. WHY the mutation pin rides the agent-facing tool result: the commit is
 * known on the gate's (session-less) invoke path, but the trace `tool_call` event is built
 * on the (session-bound) observe path — the only channel between them is the tool result.
 * So the gate emits the touch in its result; the adapter lifts it into `target`.
 */
export interface FileOpTouch {
  /** Repo-relative path of the touched file (the gate relativizes the absolute input). */
  path: string
  /**
   * The commit whose bytes the mutation touched — the `@<commit>` pin. The engine commits
   * one per accepted write, surfaced as the mutation's `commit` (HEAD of `path`'s own repo).
   * Absent only off a git working tree (then the edge stays unset, not unpinned).
   *
   * For a DELETE this is the DELETION commit (where the file is ABSENT), so it is the
   * ATTRIBUTION commit, not the readable pin — `priorCommit` carries the last-live pin the
   * tombstone `target` resolves at. For every other verb `commit` IS the readable pin.
   */
  commit?: string
  /**
   * The LAST-LIVE commit — the parent of the deletion commit, the last commit where the file
   * still EXISTED. Set ONLY by a `delete_file` mutation, and only on-git (sourced from the
   * SDK's `WireMutateResult.last_live_commit`). A delete tombstone must pin THIS, not `commit`:
   * `commit` names the deletion commit where the target is absent (`pinned-path-absent`), while
   * `priorCommit` still reads back the file's last content. `pinnedFileTarget` prefers it, so a
   * delete's `target` is the readable last-live pin; the deletion commit rides `commit` for
   * attribution. Absent on every non-delete primitive and off-git.
   */
  priorCommit?: string
  /**
   * The member repo owning the touched file, the `::repo` resolution scope. Omitted for
   * the THIS-REPO form `[[path::@commit]]` (the commit resolves against the repo the trace
   * lives in). Set it for a cross-repo touch so the pin resolves in the owning repo
   * (`[[path::repo@commit]]`). The gate uses the this-repo form for now.
   */
  repo?: string
  /**
   * WHICH WAY this touch's edge points, carried from the gate `mutationResult` (the layer that
   * KNOWS the verb) to the adapter that stamps `ToolCallData.access`. So the adapter forwards
   * the direction instead of hardcoding it or classifying a tool name ("adapters only adapt").
   * Omitted -> the adapter falls back to `'write'` (a touch only ever comes from a mutation).
   */
  access?: FileAccess
  /**
   * The OLD repo-relative path, set only for a `rename` (else omitted). Carries the name-history
   * edge's source to `ToolCallData.from`, so a consumer reads the prior name off a stamped field
   * rather than reverse-engineering it from the input shape. `path` is the NEW name, `from` the old.
   */
  from?: string
}

/**
 * Build the pinned touched-file edge value for `ToolCallData.target`, the engine `file*@`
 * pinned-reference form ([[message - 260625144937 - git-pinned references shipped::au-engine]]).
 * The `@commit` BINDS TO the `::` scope, so the value always carries `::` before `@`:
 * `[[<path>::@<commit>]]` (this repo) or `[[<path>::<repo>@<commit>]]` (a named member repo).
 * Canonical fragment order: `name ::repo @commit`. A bare `[[<path>@<commit>]]` is NOT a pin
 * and fails the contract with `value-not-pinned`.
 *
 * Returns null when there is no commit to pin (e.g. a read), so the caller leaves the
 * optional field unset rather than writing an unpinned value (which would error).
 *
 * Pins `priorCommit` when present (a DELETE's last-live commit), else `commit`. So a delete's
 * `target` resolves to the file's last content, while `commit` (the deletion commit, absent)
 * stays for attribution; every other verb has no `priorCommit` and pins `commit` as before.
 */
export function pinnedFileTarget(touch: FileOpTouch | null | undefined): string | null {
  if (!touch || typeof touch.path !== 'string') return null
  const pin = typeof touch.priorCommit === 'string' && touch.priorCommit !== '' ? touch.priorCommit : touch.commit
  if (typeof pin !== 'string' || pin === '') return null
  return `[[${touch.path}::${touch.repo ?? ''}@${pin}]]`
}

/**
 * Build a COMMIT-ONLY pinned referent `[[::@<sha>]]` — a commit named by itself, no file path.
 * The forward pair of `commitOfPinnedTarget` (which reads the sha back out), kept beside it so
 * the layer that writes the form is the only one that reads it. Used for the delete ATTRIBUTION
 * channel (`ToolCallData.committed`): a delete's `target` pins the readable last-live commit, so
 * the produced DELETION commit rides this referent for `span.commits` instead. The adapter calls
 * it rather than hand-building the wikilink ("adapters only adapt").
 *
 * Returns null when there is no sha to pin, so the caller leaves the optional field unset.
 */
export function commitReferent(commit: string | null | undefined): string | null {
  if (typeof commit !== 'string' || commit === '') return null
  return `[[::@${commit}]]`
}
export interface ToolDeniedData {
  tool: string
  input?: unknown
  tool_use_id?: string
  reason: string
  /** Where the denial was enforced (e.g. `hook`, `settings`). */
  belt?: string
}
export interface ToolFailedData {
  tool?: string
  input?: unknown
  tool_use_id?: string
  error: string
  /** The agent that made the failed call — a SUBAGENT's id, absent for the main agent. See {@link ToolCallData.agent_id}.
   *  Lift-sourced (a failed call rides a transcript, not a hook), stamped by the SubagentStop lift. */
  agent_id?: string
  /** The agent-type of {@link ToolFailedData.agent_id}. See {@link ToolCallData.agent_type}. */
  agent_type?: string
}
/**
 * A human's verdict on a `requestApproval` (kind `approval_granted` / `approval_denied`).
 * The kind carries the outcome; this is the shared payload. Recorded by the daemon when the
 * human answers, so the reject is audited and a mediator can `consultTrace` for it.
 */
export interface ApprovalVerdictData {
  /** The tool the approval gated. */
  tool?: string
  /** A short summary of the gated input (detail lives in the chat). */
  input?: unknown
  tool_use_id?: string
  /** The mediator/gate that requested the approval. */
  gate?: string
  /** The reason the human was shown. */
  reason: string
}
/**
 * Who declared a task span. A turn span has no declarer: it is DERIVED from turn
 * boundaries by the lift, never declared, so it never rides the ledger as a span event.
 */
export type SpanDeclarer = 'agent' | 'human'

/**
 * A declared task span opens.
 *
 * Span boundaries ride as EVENTS so the lifted index stays a PURE FUNCTION of the ledger:
 * an out-of-band declaration would be invisible on replay, and a re-lift would silently
 * lose it. The ledger is the record; nothing about a session is knowable from anywhere else.
 *
 * `span` is a CORRELATION id, NOT the span's block-id. The declarer cannot know the
 * block-id: a span's id derives from the `seq` of the event that opened it, and `seq` is
 * stamped by the daemon on append, after the declarer is done. So this field exists only
 * to pair an open with its close, and the lift derives the addressable id itself. Unique
 * within a session.
 */
export interface SpanOpenData {
  /** Correlation id, matched by the closing event's `span`. Not the block-id. */
  span: string
  /** What this unit of work is. The reason a task span exists at all, so it is required. */
  label: string
  declared_by: SpanDeclarer
}

/**
 * A declared task span closes. Carries only the correlation id: everything else about
 * the span is already on its opening event, and restating it here would let the two
 * disagree.
 */
export interface SpanCloseData {
  /** The `span` of the opening event this closes. */
  span: string
}

export interface CompactionData {
  trigger?: string
  custom_instructions?: string
}
export interface NotificationData {
  message?: string
}
export interface SessionEndData {
  reason?: string
}

/**
 * Build a `SessionEvent` envelope for one event. `run` and `seq` are left 0: the daemon
 * stamps the authoritative monotonic run + seq on append (P5). Producers (the adapter,
 * the daemon on a deny) use this to construct events.
 * `kind` is any kind string: the generic `EventKind` values, or an adapter's
 * extended kind (e.g. CC's `tool_unavailable`) — adapters extend the vocabulary.
 */
export function traceEvent(
  kind: string,
  session: string,
  data: unknown,
  at?: string,
  dedupeKey?: string,
): SessionEvent {
  const event: SessionEvent = { kind, run: 0, seq: 0, session, data }
  if (at !== undefined) event.at = at // a lifted event's real (authored) time, from the transcript
  if (dedupeKey !== undefined) event.dedupeKey = dedupeKey // opaque idempotency key for re-submittable (lifted) events
  return event
}
