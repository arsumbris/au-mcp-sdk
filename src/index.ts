// @arsumbris/au-mcp-sdk
//
// The wire/client contract for the au-mcp kernel daemon. Peer to @arsumbris/sdk
// (engine) and @arsumbris/au-host-sdk (host). Clients are thin and speak this.
//
// Layout (au-engine-sdk style):
// - wire    : the client <-> daemon message protocol.
// - plugin  : the plugin contract (hook shapes + manifest + Decision).
// - adapter : the per-harness adapter interface.
// - trace   : the consult-trace query interface.
// - client  : a typed client over a DaemonTransport.
//
// The agent-facing base type-defs (the harness-owned base `mcp` + `mcp.tool`) live
// in ./type as engine vocabulary. No TS mirror is kept: the daemon reads a def's
// meta generically off the engine (discovery's `manifestFrom` over a
// `Record<string, unknown>`), so no consumer needs a hand-typed face. See the
// archived [[todo - 2606111400 - swap hand-mirrored TS for au-type-codegen output when it lands]].
//
// The generic SESSION-EVENT vocabulary (event kinds + data shapes, messageBlock)
// is a contract spoken by the daemon, redirect, the adapter,
// and trace, so it lives here too (./vocabulary). See decision 2606121303. The trace
// plugin owns only the on-disk format.
//
// Session capture's LEDGER line schema lives here (./vocabulary): event kinds, data
// shapes, the span-boundary events (SpanOpen/SpanClose/…) + SpanDeclarer, messageBlock.
// This is the base contract the daemon, redirect, adapter, and recorder all speak.
//
// The lifted SPAN INDEX vocabulary (session-spans + the span family) is NOT here: it is
// the recorder's OUTPUT format, so it moved to au-provenance (the recorder's owner). See
// [[decision - 2608031816 - the span-index vocab moves to au-provenance, the ledger schema stays in au-mcp-sdk::au-provenance]].

export * from './wire.ts'
export * from './plugin.ts'
export * from './adapter.ts'
export * from './trace.ts'
export * from './client.ts'
export * from './vocabulary.ts'
export * from './frame.ts'
export * from './socket.ts'
export * from './launch-env.ts'
export * from './launch-defaults.ts'
