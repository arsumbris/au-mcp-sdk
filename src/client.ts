// A typed client over a DaemonTransport.
//
// Mints request ids, correlates responses, and presents the daemon as a set of
// async methods. The CC shim, the CC hooks, au-host, etc. all build on this.
// Mirrors au-host-sdk's createMountHost (a library that re-presents a transport).

import type { AdapterInfo, NativeTool } from './adapter.ts'
import type { PendingAction, Decision, SessionEvent, ToolManifest } from './plugin.ts'
import type { TraceQuery, TraceSlice } from './trace.ts'
import type { ClientRequest, DaemonResponse, DaemonTransport, RequestId, ReplayEvent, DormantSession } from './wire.ts'
import { MCP_CONTRACT_VERSION } from './wire.ts'

export interface DaemonClient {
  sessionOpen(info: AdapterInfo): Promise<{ contractVersion: number }>
  sessionClose(session: string): Promise<void>
  mediate(session: string, action: PendingAction): Promise<Decision>
  /** Record an event; resolves with any mediator `review` text (the post-tool channel), or undefined. */
  observe(session: string, event: SessionEvent): Promise<string | undefined>
  /** Workspace-scoped: `session` is optional (the callable tools don't need it).
   *  `allowed` is the caller's tool allowlist; the daemon refuses a tool outside it.
   *  Omit it to reach every tool (the tool-visibility spec's absent-means-all rule). */
  invoke(
    session: string | undefined,
    tool: string,
    input: unknown,
  ): Promise<{ result: unknown; isError?: boolean }>
  consultTrace(session: string, query: TraceQuery): Promise<TraceSlice>
  /** Report that a harness TURN ended. A lifecycle FACT, not an instruction: what it causes
   *  is decided by whichever recorder is installed, and no caller here learns what that was. */
  turnEnd(session: string): Promise<void>
  /** The session's governance posture: `denyNative` (a native-tool allowlist is set, so
   *  unlisted native tools are forced through the gate), for the adapter to report + inject the "use the gate" note. */
  sessionGuards(session: string): Promise<{ denyNative: boolean }>
  /** The COMPUTED session-start context: the inject blocks this session's `session-start` hooks
   *  produced at open (a live-broker graph query). The adapter calls it once per session start and
   *  emits the blocks into the session-start slot. `[]` when no hook produced any. */
  sessionStartContext(session: string): Promise<{ inject: string[] }>
  /** Workspace-scoped: `session` is optional. Tool visibility is profile-derived (the
   *  tool-visibility spec): with an open `session` the daemon gates from its resolved
   *  allowlist; else it resolves the allowlist from the `profile` LOCATOR (the advertise
   *  runs at MCP-server startup, before session-open — so the profile, not the session, is
   *  the source there). With neither, every tool is advertised. */
  listCapabilities(
    session?: string,
    profile?: string,
  ): Promise<{ callables: ToolManifest[]; redirects: NativeTool[] }>
  /** Liveness + version probe; needs no session. */
  ping(): Promise<{ contractVersion: number; workspace: string }>
  /** Ask the daemon to stop (operator/lifecycle control). */
  shutdown(): Promise<void>
  /** Replay a resumed session's OBSERVABLE conversation (from the adapter's transcript) so
   *  `consultTrace` shows the prior run(s). Inert (read-only) kernel-side; governance kinds are
   *  refused. Resolves with the `{injected, refused}` tally. */
  sessionRehydrate(session: string, events: ReplayEvent[]): Promise<{ injected: number; refused: number }>

  // Session-retention control-plane. Host/user authority, never agent tools; session-less
  // (they act across sessions, not within one), matching how the kernel treats them.
  // See the session-retention spec.
  /** List DORMANT sessions (cleanly-closed, resumable) for the host to show. */
  listDormant(): Promise<DormantSession[]>
  /** Blast-radius preview: which dormant sessions a proposed `windowMs` WOULD retire. Read-only. */
  retentionPreview(windowMs: number): Promise<DormantSession[]>
  /** The current retention window (the dormancy policy). Read-only. */
  retentionConfig(): Promise<{ windowDays: number; windowMs: number }>
  /** Set the retention window in days; the daemon persists it and returns the applied window. */
  setRetentionWindow(windowDays: number): Promise<{ windowDays: number; windowMs: number }>
  /** Explicitly retire a dormant session now (user-directed); resolves with the retired id. */
  retireSession(session: string): Promise<{ session: string }>

  /** Stop listening on the transport. */
  dispose(): void
}

/** Wrap a transport into a typed client. */
/**
 * Why a daemon request FAILED at the transport (not an engine/tool error, which rides
 * back as a normal response). Lets a caller branch — a dropped connection can be retried
 * against a fresh daemon; a wedged one cannot. See the adapter's reconnect loop.
 */
export type DaemonConnErrorCode =
  | 'connection-lost' // the socket dropped after connecting (the daemon died / restarted)
  | 'timeout' // the connection is open but no reply arrived in time (a wedged daemon)

/** A transport-level failure of a daemon request, carrying a machine-branchable `code`. */
export class DaemonConnectionError extends Error {
  readonly code: DaemonConnErrorCode
  constructor(code: DaemonConnErrorCode, message: string) {
    super(message)
    this.name = 'DaemonConnectionError'
    this.code = code
  }
}

/**
 * The daemon's reported wire contract version does not EQUAL the SDK's `MCP_CONTRACT_VERSION`.
 * The handshake is exact integer equality (wire.ts): a version-skewed client and daemon must
 * refuse LOUD, never proceed on a mismatched protocol (loud fail-closed, no override —
 * [[decision - 2609091649 - the mcp wire and plugin contracts enforce exact-equality, loud fail-closed with no override::au-harness]]).
 * Thrown at `sessionOpen` (the handshake point). `ping` stays a pure version PROBE — it does
 * NOT throw — so an operator/CLI can still READ a skew to diagnose it.
 */
export class ContractVersionError extends Error {
  /** The version this SDK client speaks (`MCP_CONTRACT_VERSION`). */
  readonly expected: number
  /** The version the daemon reported. */
  readonly actual: number
  constructor(expected: number, actual: number) {
    super(
      `au-mcp wire contract mismatch: client speaks v${expected}, daemon is v${actual}. ` +
        `Run a matching daemon and client (siblings ship together).`,
    )
    this.name = 'ContractVersionError'
    this.expected = expected
    this.actual = actual
  }
}

/** How long a single request waits for its reply before failing as `timeout`. 0 disables. */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

export interface DaemonClientOptions {
  /** Per-request reply timeout (ms). Defaults to 30s; pass 0 to wait forever (legacy). */
  requestTimeoutMs?: number
}

export function createDaemonClient(transport: DaemonTransport, options: DaemonClientOptions = {}): DaemonClient {
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  let nextId = 1
  interface Pending {
    onResponse: (response: DaemonResponse) => void
    onFail: (error: Error) => void
    timer?: ReturnType<typeof setTimeout>
  }
  const pending = new Map<RequestId, Pending>()

  const stopReceiving = transport.receive((response) => {
    const p = pending.get(response.id)
    if (!p) return
    pending.delete(response.id)
    if (p.timer) clearTimeout(p.timer)
    p.onResponse(response)
  })

  // A dropped channel (daemon died / socket closed) can never answer the in-flight
  // requests, so fail them ALL immediately instead of leaving them to hang forever.
  transport.onClose?.((reason) => {
    const err = new DaemonConnectionError('connection-lost', reason?.message ?? 'daemon connection dropped')
    for (const [id, p] of [...pending]) {
      pending.delete(id)
      if (p.timer) clearTimeout(p.timer)
      p.onFail(err)
    }
  })

  function request(build: (id: RequestId) => ClientRequest): Promise<DaemonResponse> {
    const id = nextId++
    return new Promise<DaemonResponse>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              pending.delete(id)
              reject(new DaemonConnectionError('timeout', `daemon did not respond within ${timeoutMs}ms`))
            }, timeoutMs)
          : undefined
      pending.set(id, {
        onResponse: (response) => {
          if (response.kind === 'error') reject(new Error(response.message))
          else resolve(response)
        },
        onFail: reject,
        timer,
      })
      try {
        transport.send(build(id))
      } catch (e) {
        // A synchronous send failure (writing to a torn-down socket) fails just this request.
        pending.delete(id)
        if (timer) clearTimeout(timer)
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    })
  }

  return {
    async sessionOpen(info) {
      const r = await request((id) => ({ kind: 'session-open', id, info }))
      if (r.kind !== 'opened') throw unexpected(r)
      // Enforce the wire handshake: exact integer equality (wire.ts). A skewed daemon must
      // refuse LOUD here, never pass through — a mismatched protocol is silent corruption.
      if (r.contractVersion !== MCP_CONTRACT_VERSION) {
        throw new ContractVersionError(MCP_CONTRACT_VERSION, r.contractVersion)
      }
      return { contractVersion: r.contractVersion }
    },
    async sessionClose(session) {
      const r = await request((id) => ({ kind: 'session-close', id, session }))
      if (r.kind !== 'closed') throw unexpected(r)
    },
    async mediate(session, action) {
      const r = await request((id) => ({ kind: 'mediate', id, session, action }))
      if (r.kind !== 'decision') throw unexpected(r)
      return r.decision
    },
    async observe(session, event) {
      const r = await request((id) => ({ kind: 'observe', id, session, event }))
      if (r.kind !== 'observed') throw unexpected(r)
      return r.text
    },
    async invoke(session, tool, input) {
      const r = await request((id) => ({ kind: 'invoke', id, session, tool, input }))
      if (r.kind !== 'invoked') throw unexpected(r)
      return { result: r.result, isError: r.isError }
    },
    async turnEnd(session) {
      const r = await request((id) => ({ kind: 'turn-end', id, session }))
      if (r.kind !== 'turn-ended') throw unexpected(r)
    },
    async consultTrace(session, query) {
      const r = await request((id) => ({ kind: 'consult-trace', id, session, query }))
      if (r.kind !== 'trace') throw unexpected(r)
      return r.slice
    },
    async listCapabilities(session, profile) {
      const r = await request((id) => ({ kind: 'list-capabilities', id, session, profile }))
      if (r.kind !== 'capabilities') throw unexpected(r)
      return { callables: r.callables, redirects: r.redirects }
    },
    async sessionGuards(session) {
      const r = await request((id) => ({ kind: 'session-guards', id, session }))
      if (r.kind !== 'guards') throw unexpected(r)
      return { denyNative: r.denyNative }
    },
    async sessionStartContext(session) {
      const r = await request((id) => ({ kind: 'session-start-context', id, session }))
      if (r.kind !== 'session-start-context') throw unexpected(r)
      return { inject: r.inject }
    },
    async ping() {
      const r = await request((id) => ({ kind: 'ping', id }))
      if (r.kind !== 'pong') throw unexpected(r)
      return { contractVersion: r.contractVersion, workspace: r.workspace }
    },
    async shutdown() {
      const r = await request((id) => ({ kind: 'shutdown', id }))
      if (r.kind !== 'shutdown-ack') throw unexpected(r)
    },
    async sessionRehydrate(session, events) {
      const r = await request((id) => ({ kind: 'session-rehydrate', id, session, events }))
      if (r.kind !== 'rehydrated') throw unexpected(r)
      return { injected: r.injected, refused: r.refused }
    },
    async listDormant() {
      const r = await request((id) => ({ kind: 'list-dormant', id }))
      if (r.kind !== 'dormant-sessions') throw unexpected(r)
      return r.sessions
    },
    async retentionPreview(windowMs) {
      const r = await request((id) => ({ kind: 'retention-preview', id, windowMs }))
      if (r.kind !== 'retention-preview') throw unexpected(r)
      return r.sessions
    },
    async retentionConfig() {
      const r = await request((id) => ({ kind: 'retention-config', id }))
      if (r.kind !== 'retention-config') throw unexpected(r)
      return { windowDays: r.windowDays, windowMs: r.windowMs }
    },
    async setRetentionWindow(windowDays) {
      const r = await request((id) => ({ kind: 'set-retention-window', id, windowDays }))
      if (r.kind !== 'retention-config') throw unexpected(r)
      return { windowDays: r.windowDays, windowMs: r.windowMs }
    },
    async retireSession(session) {
      const r = await request((id) => ({ kind: 'retire-session', id, session }))
      if (r.kind !== 'retired') throw unexpected(r)
      return { session: r.session }
    },
    dispose() {
      stopReceiving()
      for (const p of pending.values()) if (p.timer) clearTimeout(p.timer)
      pending.clear()
    },
  }
}

function unexpected(response: DaemonResponse): Error {
  return new Error(`unexpected daemon response: ${response.kind}`)
}
