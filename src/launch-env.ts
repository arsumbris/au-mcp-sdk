// The launch-environment contract.
//
// The `AU_MCP_*` variables a launcher SETS and the CC adapter READS, defined ONCE so the
// two ends cannot drift. The drift this prevents is real: a launcher emitting `AU_PROFILE`
// while the adapter reads `AU_MCP_PROFILE` fails silently. See [[decision - 2608221130 - the
// agent launch surface is a two-layer model owned by the au-mcp family, au-mcp.yaml dropped::au-harness]].
//
// TOOL restriction — typed AND native — is no longer a launch env: both axes resolve DAEMON-SIDE
// from the active agent-profile (the launch env carries only the profile LOCATOR). The retired
// `AU_MCP_TOOLS` and `AU_MCP_NATIVE_TOOLS` vars are intentionally absent.
//
// Pure data + pure value-parsing, NO engine-sdk dependency — this SDK stays the minimal
// contract. The VALUE semantics (unset-vs-empty, fail-closed handle, JSON shape) live here
// too, so the reader (adapter) and the future launcher (au-mcp) agree by construction.
//
// `AU_MCP_TRACE` is deliberately ABSENT: trace/capture is being retired as a launch knob
// (persistence is the recorder's own concern, not a kernel env). See the same decision +
// [[plan - 2608221145 - build the agent launch contract, two-layer model with one env
// contract and a launcher bin::au-harness]] Phase 6.

import { randomUUID } from 'node:crypto'

/** The `AU_MCP_*` launch environment variable names. The single source — never hand-type these. */
export const LAUNCH_ENV = {
  /** Required, fail-closed: the per-launch session handle the daemon binds. */
  SESSION: 'AU_MCP_SESSION',
  /** The folder-repo entry the session serves. A LOCATOR (falls back to `CLAUDE_PROJECT_DIR`). */
  WORKSPACE: 'AU_MCP_WORKSPACE',
  // Tool restriction — typed `tools` AND `nativeToolAllowlist` — is no longer a launch env: both
  // resolve daemon-side from the active agent-profile's graph. The launch env carries only the
  // profile LOCATOR (`PROFILE`). The retired `AU_MCP_TOOLS` + `AU_MCP_NATIVE_TOOLS` vars are absent.
  /** The active agent-profile the daemon reads from the graph at session-open, to resolve the
   *  session's typed `hooks` / `hookConfig` (E2, decision 2609020302). A LOCATOR for the profile
   *  instance; its exact shape (id vs path) + the no-profile path settle when the daemon read lands. */
  PROFILE: 'AU_MCP_PROFILE',
} as const

export type LaunchEnvName = (typeof LAUNCH_ENV)[keyof typeof LAUNCH_ENV]

/** Parse the session handle: a trimmed non-empty string, else `undefined`. */
export function parseSessionHandle(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim()
  return trimmed ? trimmed : undefined
}

/** Parse the active agent-profile locator: a trimmed non-empty string, else `undefined` (no profile,
 *  a bare launch). A plain locator the daemon resolves against the graph — same value semantics as the
 *  session handle, named on its own axis so the reader and launcher agree by construction. */
export const parseProfile = parseSessionHandle

// --- the PRODUCER half: a launcher assembles the env from these, the inverse of the parsers above.

/** The harness-agnostic launch inputs a launcher resolves (from an agent-profile or ad-hoc). */
export interface LaunchInputs {
  /** The folder-repo entry the session serves. */
  workspace: string
  /** The active agent-profile locator the daemon reads from the graph to resolve typed
   *  `hooks` / `hookConfig` AND the tool axes (`tools`, `nativeToolAllowlist`), all daemon-side
   *  (decision 2609020302). `undefined` = no profile (a bare launch). */
  profile?: string
  /** A pre-minted session handle; when omitted, one is minted. */
  session?: string
}

/** The assembled launch env plus the (minted or passed-through) session handle. */
export interface LaunchEnvResult {
  /** The `AU_MCP_*` environment for the session. */
  env: Record<string, string>
  /** The session handle set in the env (minted here when the input omitted it). */
  session: string
}

/**
 * Assemble the `AU_MCP_*` launch env from harness-agnostic inputs, minting the session handle.
 *
 * Emits ONLY what is set, so an unset knob falls to the reader's hard default (a var absent from
 * the result is absent from the env). The names come from `LAUNCH_ENV`, so a launcher built on this
 * can never drift from the adapter that reads it. Harness-agnostic: turning this into a runnable
 * command is the per-adapter command transform's job.
 */
export function buildLaunchEnv(inputs: LaunchInputs): LaunchEnvResult {
  const session = inputs.session ?? randomUUID()
  const env: Record<string, string> = {
    [LAUNCH_ENV.SESSION]: session,
    [LAUNCH_ENV.WORKSPACE]: inputs.workspace,
  }
  if (inputs.profile !== undefined) env[LAUNCH_ENV.PROFILE] = inputs.profile
  return { env, session }
}
