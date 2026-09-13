// The per-harness adapter interface (pressure-test P8).
//
// An adapter binds one harness (Claude Code, a future Codex, ...) to the au-mcp
// daemon. It is a THIN daemon client: it DECLARES its harness's native surface
// and bridges I/O, but holds NO deny/trace/mode logic (that lives in the daemon
// + plugins, generic over this interface).
//
// The four parts an adapter provides:
//  1. its native tool surface + gate-equivalent mapping (for redirect),
//  2. hook event in/out bridging over the wire (for the kernel),
//  3. a context-injection channel (for soft modes / contracts),
//  4. session identity + cwd/workspace (for trace + the engine broker).
// A harness that cannot provide one degrades that capability, not the whole adapter.

import type { PendingAction, Decision } from './plugin.ts'

/** One of the harness's built-in tools, and where the agent should go instead when redirected. */
export interface NativeTool {
  /** The harness-native tool name (e.g. `Bash`, `Read`). */
  name: string
  /** The gate tool id to point the agent at when this native tool is denied. */
  gateEquivalent?: string
}

/** Static facts the adapter declares about its harness session. */
export interface AdapterInfo {
  /** The adapter's identity — its `mcp.adapter` type NAME (e.g. `mcp.adapter.cc`), the join key
   *  a launcher matches against the discovered node (`AdapterInfo.harness === subtype.name`).
   *  Not a tiered leaf: the engine has no tiered-name concept, so this is the whole opaque name. */
  harness: string
  /** Opaque session id (part 4). The FINE-GRAINED identity: it changes on `/clear` (a new CC
   *  session), so it is the daemon's session key. Preserved across `--resume`. */
  session: string
  /**
   * The stable per-LAUNCH session HANDLE (`AU_MCP_SESSION`), or absent when the launcher set none.
   *
   * Why it exists, separate from `session`: the CC mcp-server shim invokes the daemon with no
   * session (CC exposes none to an MCP server), but it CAN carry a launch-env value that is constant
   * for its whole life. The launcher mints `AU_MCP_SESSION` once; both the hooks (here) and the
   * long-lived shim inherit it. A `/clear` changes `session` (the id) but NOT the handle (same
   * process), so the daemon keeps a `handle -> current session` binding, refreshed on every
   * session-open: the shim presents only the handle on invoke, and the daemon resolves it to the
   * live session. Resolve rule: `binding.get(handle) ?? request.session` — a raw session id from a
   * direct caller (a verify/test that never set a handle) falls straight through.
   *
   * Absent -> no binding is recorded; a session-less invoke stays session-less (still valid for a
   * workspace-scoped callable). Enforcement that a CC session ALWAYS carries a handle lives at the
   * mcp-server (fail-closed on the missing env), never here — the type only carries it.
   * See [[decision - 2608070047 - a mandatory per-launch session handle in the env, fail-closed, binds to the live CC session::au-harness]].
   */
  handle?: string
  /**
   * Optional RESUME assertion: the adapter knows this open resumes a prior run of the same session
   * (e.g. `claude --resume`). The daemon otherwise INFERS resume from its own durable run-record for
   * the id, so this is an override for a cooperating adapter, not a requirement. Absent -> inferred.
   * See [[decision - 2608072219 ...]] superseded by the session-run-lifecycle spec.
   */
  resume?: boolean
  /**
   * An OPAQUE, adapter-owned relaunch reference: everything THIS harness needs to relaunch the same
   * conversation later (e.g. a Codex CODEX_HOME + thread UUID; CC's `--resume` id). The kernel never
   * parses it — it persists it on the durable session record and hands it back on `list-dormant`
   * ([[DormantSession]]), so a host/CLI can resume via the SAME adapter (paired with `harness`).
   * Absent -> the session is not adapter-resumable (a bare/test launch, or a harness with no resume).
   * Set at `session-open`; the latest value seen at a run-start is what a resume gets.
   */
  resumeRef?: string
  /** The workspace root the session runs over (part 4). */
  workspace: string
  /** The harness's native tool surface (part 1). */
  nativeTools: NativeTool[]
  /**
   * The prefix this harness gives the au-mcp gate tools (Phase 6.3). A governance
   * mode states `allow_gate` as POLICY; the concrete prefix is harness-specific, so
   * the adapter declares it (CC: `mcp__plugin_au-mcp-adapter-cc_au__`). Absent -> a
   * governance mode that allows the gate has no prefix to allow (deny-all).
   */
  gatePrefix?: string
  // The NATIVE-tool allowlist no longer rides AdapterInfo: it is resolved DAEMON-SIDE from the active
  // profile's `nativeToolAllowlist` (the native twin of the typed `tools` axis), reaching plugins via
  // `SessionLaunch.nativeToolAllowlist`. The adapter forwards only the profile LOCATOR below. The
  // retired `AU_MCP_NATIVE_TOOLS` env is gone.
  /**
   * The ACTIVE agent-profile for this session, a LOCATOR the daemon resolves against the graph at
   * session-open to read the session's typed `hooks` / `hookConfig` (E2, decision 2609020302). Set
   * from `AU_MCP_PROFILE`. Absent -> no profile (a bare launch): only the hard-default + always-on
   * (`critical`) hooks run, no `hookConfig`. The exact locator shape (instance path vs id) is settled
   * where the daemon read lands. It carries per-hook config as TYPED graph data — the untyped
   * per-plugin `pluginConfig` blob it replaced is retired (decision 2609021429).
   */
  profile?: string
}

/**
 * What a harness adapter implements. The daemon calls back through this to act
 * in the harness; the adapter forwards harness events to the daemon.
 */
export interface Adapter {
  info: AdapterInfo

  /** Part 3: inject context/contract text into the agent's session (soft modes). */
  inject(text: string): void

  /**
   * Part 2: the adapter calls this when the harness is about to run an action,
   * and applies the returned Decision (deny/allow/inject) back in the harness.
   * Implemented by the daemon client; the adapter wires it to its PreToolUse hook.
   */
  onAction?: (action: PendingAction) => Promise<Decision>
}
