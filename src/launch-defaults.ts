// The launch hard defaults.
//
// What a session gets when NOTHING is set — no launcher, no env, no file. The single source
// for the SCALAR defaults. Baked-in, NOT configurable: the configurable layer is
// agent-profiles. See [[decision - 2608221130 - the agent launch surface is a two-layer model
// owned by the au-mcp family, au-mcp.yaml dropped::au-harness]].
//
// The adapter applies these when env (and, until it is dropped, the workspace file) says
// nothing; the future launcher references them to know what "unset" means.

/**
 * NATIVE-tool allowlist default: ALL, expressed as `undefined` (no allowlist) — a bare session
 * permits every native tool. Distinct from an empty allowlist (`[]` = no native tool). The native
 * counterpart to `DEFAULT_TOOLS`.
 */
export const DEFAULT_NATIVE_TOOL_ALLOWLIST: string[] | undefined = undefined

/**
 * TOOLS default: ALL, expressed as `undefined` (no allowlist) — a launch that names no tools
 * is unrestricted. Distinct from an empty allowlist (`[]` = no tool).
 */
export const DEFAULT_TOOLS: string[] | undefined = undefined

// BEHAVIORAL defaults are POLICIES, not scalar constants, so they are documented here but
// implemented where materialize lives (au-mcp), not exported as values:
// - SKILLS default = ALL discovered skills (an absent `select` materializes all).
// - INJECT default = the ROLE-SCOPED set: `entry` + `edit` member injects only (the trust
//   boundary — the authoring surfaces the human owns); `dep`/`discover` injects are opt-in.
