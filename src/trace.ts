// consult-trace: the query interface a plugin uses to read the daemon's live
// per-session event log (pressure-test P5).
//
// The DAEMON owns the in-memory session log (core). The trace PLUGIN owns the
// concrete event types + the on-disk format. A plugin never reads the trace
// store directly; it calls consult-trace, which the kernel routes to the daemon.

import type { SessionEvent } from './plugin.ts'

/**
 * The event kind that marks a turn boundary. A well-known kind: the daemon keys
 * `TraceQuery.thisTurn` off it, and the lift cuts turn spans on it. Kept in the SDK so the
 * kernel stays aware only of the contract, not of the trace plugin.
 *
 * THE TURN RULE, stated once here and consumed everywhere, because it was previously
 * written out three times and one copy silently disagreed:
 * - a turn OPENS at this kind and runs to the next one. The boundary is a CAPTURED EVENT
 *   KIND, never a message role and never a heuristic over content. Tool results are
 *   `user`-role messages in a harness transcript and must not open a turn; only a genuine
 *   human submission produces this event.
 * - ORDER BY `(at, seq)` BEFORE cutting. Append order is not production order, so cutting on
 *   position puts a late-lifted event in the wrong turn.
 * - the region BEFORE the first boundary is real and belongs to a turn with no prompt. A
 *   ledger can begin mid-session, so this is a normal case, not a corrupt one.
 * - turns are therefore contiguous, non-overlapping, and EXHAUSTIVE over the ledger.
 */
export const TURN_BOUNDARY_KIND = 'user_prompt'

/** A filter over the session log. All fields are AND-ed; omitted means no constraint. */
export interface TraceQuery {
  /** Only events at or after this sequence number. */
  sinceSeq?: number
  /** Only these event kinds. */
  kinds?: string[]
  /** Limit to the current turn (since the last user prompt). */
  thisTurn?: boolean
  /** Cap the number of returned events (most recent first). */
  limit?: number
}

/** The answer: a slice of the live log. */
export interface TraceSlice {
  events: SessionEvent[]
  /** The highest seq the daemon knew at query time (for follow-up paging). */
  headSeq: number
}

/** A plugin calls this (via MediationContext) to ask the daemon's live log. */
export type ConsultTrace = (query: TraceQuery) => Promise<TraceSlice>
