// A socket-backed DaemonTransport — the client side of the wire.
//
// Connects to a daemon listening on a Unix socket and presents the SDK's
// DaemonTransport, so `createDaemonClient` works over a real socket. A client
// utility shipped with the SDK (like au-engine-sdk's socket client); used by the
// au-mcp CLI, the e2e test, and the CC client surfaces (the adapter + shim).

import { realpathSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ClientRequest, DaemonResponse, DaemonTransport } from './wire.ts'
import { encodeFrame, FrameDecoder } from './frame.ts'

// FNV-1a-64 of a byte string — reproduced from au_engine::socket_file_name (and
// mirrored in engine-sdk). u64 wrapping arithmetic in BigInt, masked to 64 bits
// after each multiply. Reproduced (not imported) to keep this contract SDK free of
// an engine-sdk dependency; pinned to the canonical vectors ("" -> cbf29ce484222325,
// "a" -> af63dc4c8601ec8c, "foobar" -> 85944171f73967e8).
const U64_MASK = 0xffffffffffffffffn
function fnv1a64(bytes: Uint8Array): bigint {
  let hash = 0xcbf29ce484222325n
  for (const b of bytes) {
    hash ^= BigInt(b)
    hash = (hash * 0x100000001b3n) & U64_MASK
  }
  return hash
}

/** The `<hash>.sock` filename for an entry — the FNV-1a-64 of its bytes, 16 hex. */
export function socketFileName(entry: string): string {
  const hash = fnv1a64(Buffer.from(entry, 'utf8'))
  return `${hash.toString(16).padStart(16, '0')}.sock`
}

/**
 * Where the au-mcp daemon listens for the workspace `entry` (a folder-repo
 * DIRECTORY carrying `.arsumbris/repo.yaml`, schema 16): a HASHED out-of-repo path
 * `$HOME/.arsumbris/au-mcp/run/<hash>.sock`. Mirrors the engine's SUN_LEN fix
 * (schema 12) so a deep entry path never overruns `sun_path` (the old in-repo
 * `<workspace>/.arsumbris/mcp.sock` join also overran it on deep paths). It lives
 * under au-mcp's OWN device tenant (`~/.arsumbris/<owner>/<category>/`), so the mcp
 * daemon's hashed name never collides with the engine daemon's (`au-engine/run/`)
 * for the same entry. Client knowledge (how to reach the daemon), so it ships with
 * the SDK.
 */
// DELIBERATE MIRROR of engine-sdk's `auDeviceDir(owner, category)` — its
// `$HOME/.arsumbris/<owner>/<category>` convention, raw `$HOME` with an `os.tmpdir()`
// fallback (NOT canonicalized, matching what the daemon binds). Reproduced, NOT imported,
// to keep this contract SDK free of an engine-sdk dependency — exactly as `fnv1a64` above
// is. DRIFT CHECK: if engine-sdk changes the device-path shape or the `$HOME` derivation,
// update this to match. The two must agree byte-for-byte.
/**
 * The per-machine device directory for a tenant's runtime state: `$HOME/.arsumbris/<owner>/<category>/`.
 * The framework's home for machine-local, ephemeral runtime state that lives OUT of any workspace
 * (the daemon socket, the kernel's crash-recovery, an adapter's transcript-lift cursor). NOT for
 * repo-owned content — that belongs in the in-repo `.arsumbris/`. Callers own creating the dir.
 */
export function auDeviceDir(owner: string, category: string): string {
  const home = process.env.HOME ?? tmpdir()
  return join(home, '.arsumbris', owner, category)
}

export function socketPath(entry: string): string {
  const canonical = realpathSync(entry)
  return join(auDeviceDir('au-mcp', 'run'), socketFileName(canonical))
}

export interface SocketTransport extends DaemonTransport {
  /** Close the underlying socket. */
  close(): void
}

/** Connect a DaemonTransport to a daemon listening on `socketPath`. */
export function connectSocket(socketPath: string): Promise<SocketTransport> {
  return new Promise((resolve, reject) => {
    const socket: Socket = connect(socketPath)
    const decoder = new FrameDecoder()
    let onResponse: ((response: DaemonResponse) => void) | null = null
    let onDrop: ((reason?: Error) => void) | null = null
    // The channel drops exactly once (a daemon restart closes the socket, a mid-flight
    // failure errors it). Fire the drop handler a single time, on whichever lands first,
    // so the client can fail its pending requests instead of hanging on a dead socket.
    let dropped = false
    const drop = (reason?: Error) => {
      if (dropped) return
      dropped = true
      onDrop?.(reason)
    }

    socket.on('data', (chunk: Buffer) => {
      let frames: unknown[]
      try {
        frames = decoder.push(chunk)
      } catch {
        socket.destroy()
        return
      }
      for (const frame of frames) onResponse?.(frame as DaemonResponse)
    })
    socket.once('connect', () => {
      socket.off('error', reject)
      // Post-connect error/close no longer rejects the connect promise (already resolved);
      // it signals a DROP so the client can reject its pending requests fast.
      socket.on('error', (err: Error) => drop(err))
      socket.on('close', () => drop())
      resolve({
        send: (request: ClientRequest) => {
          socket.write(encodeFrame(request))
        },
        receive: (handler) => {
          onResponse = handler
          return () => {
            onResponse = null
          }
        },
        onClose: (handler) => {
          onDrop = handler
        },
        close: () => socket.destroy(),
      })
    })
    socket.once('error', reject)
  })
}
