import { describe, it, expect } from 'vitest'
import { createDaemonClient, DaemonConnectionError, ContractVersionError } from '../src/client.ts'
import { MCP_CONTRACT_VERSION } from '../src/wire.ts'
import type { ClientRequest, DaemonResponse, DaemonTransport } from '../src/wire.ts'
import type { AdapterInfo } from '../src/adapter.ts'

/**
 * A fake transport that never answers on its own, so the test drives every outcome:
 * `respond` delivers a reply, `drop` simulates the socket closing (daemon restart).
 */
function fakeTransport() {
  let onResponse: ((r: DaemonResponse) => void) | null = null
  let onClose: ((reason?: Error) => void) | null = null
  const sent: ClientRequest[] = []
  const transport: DaemonTransport = {
    send: (req) => {
      sent.push(req)
    },
    receive: (h) => {
      onResponse = h
      return () => {
        onResponse = null
      }
    },
    onClose: (h) => {
      onClose = h
    },
  }
  return {
    transport,
    sent,
    respond: (r: DaemonResponse) => onResponse?.(r),
    drop: (reason?: Error) => onClose?.(reason),
  }
}

describe('daemon client — never hangs on a dead daemon', () => {
  it('rejects a request that never gets a reply, as a timeout (a wedged daemon)', async () => {
    const t = fakeTransport()
    const client = createDaemonClient(t.transport, { requestTimeoutMs: 20 })
    const err = await client.ping().then(
      () => null,
      (e) => e,
    )
    expect(err).toBeInstanceOf(DaemonConnectionError)
    expect((err as DaemonConnectionError).code).toBe('timeout')
  })

  it('rejects every in-flight request when the channel drops (a daemon restart)', async () => {
    const t = fakeTransport()
    const client = createDaemonClient(t.transport, { requestTimeoutMs: 0 }) // no timeout: prove the DROP path
    const inFlight = client.ping()
    t.drop(new Error('ECONNRESET'))
    const err = await inFlight.then(
      () => null,
      (e) => e,
    )
    expect(err).toBeInstanceOf(DaemonConnectionError)
    expect((err as DaemonConnectionError).code).toBe('connection-lost')
  })

  it('still resolves normally when a reply arrives, and clears the timeout', async () => {
    const t = fakeTransport()
    const client = createDaemonClient(t.transport, { requestTimeoutMs: 50 })
    const p = client.ping()
    // The first request mints id 1; reply to it.
    t.respond({ kind: 'pong', id: 1, contractVersion: 0, workspace: '/ws' })
    await expect(p).resolves.toEqual({ contractVersion: 0, workspace: '/ws' })
  })
})

describe('daemon client — wire contract handshake (exact equality, loud fail-closed)', () => {
  // The faked transport lets the daemon report any version; info content is irrelevant here.
  const info = {} as AdapterInfo

  it('sessionOpen throws ContractVersionError on a skewed daemon, never passing through', async () => {
    const t = fakeTransport()
    const client = createDaemonClient(t.transport)
    const p = client.sessionOpen(info)
    t.respond({ kind: 'opened', id: 1, contractVersion: MCP_CONTRACT_VERSION + 1 })
    const err = await p.then(
      () => null,
      (e) => e,
    )
    expect(err).toBeInstanceOf(ContractVersionError)
    expect((err as ContractVersionError).expected).toBe(MCP_CONTRACT_VERSION)
    expect((err as ContractVersionError).actual).toBe(MCP_CONTRACT_VERSION + 1)
  })

  it('sessionOpen resolves when the daemon speaks the same version', async () => {
    const t = fakeTransport()
    const client = createDaemonClient(t.transport)
    const p = client.sessionOpen(info)
    t.respond({ kind: 'opened', id: 1, contractVersion: MCP_CONTRACT_VERSION })
    await expect(p).resolves.toEqual({ contractVersion: MCP_CONTRACT_VERSION })
  })

  it('ping stays a pure PROBE — it reports a skewed version instead of throwing (so an operator can diagnose)', async () => {
    const t = fakeTransport()
    const client = createDaemonClient(t.transport)
    const p = client.ping()
    t.respond({ kind: 'pong', id: 1, contractVersion: MCP_CONTRACT_VERSION + 1, workspace: '/ws' })
    await expect(p).resolves.toEqual({ contractVersion: MCP_CONTRACT_VERSION + 1, workspace: '/ws' })
  })
})

describe('daemon client — session-retention control-plane', () => {
  const dormant = [{ id: 's1', run: 2, lastActiveMs: 111, sizeBytes: 4096 }]

  it('listDormant sends list-dormant, correlates the dormant-sessions reply (kinds differ)', async () => {
    const t = fakeTransport()
    const client = createDaemonClient(t.transport)
    const p = client.listDormant()
    expect(t.sent[0]).toEqual({ kind: 'list-dormant', id: 1 })
    t.respond({ kind: 'dormant-sessions', id: 1, sessions: dormant })
    await expect(p).resolves.toEqual(dormant)
  })

  it('retentionPreview passes windowMs and returns the preview sessions', async () => {
    const t = fakeTransport()
    const client = createDaemonClient(t.transport)
    const p = client.retentionPreview(60_000)
    expect(t.sent[0]).toEqual({ kind: 'retention-preview', id: 1, windowMs: 60_000 })
    t.respond({ kind: 'retention-preview', id: 1, sessions: dormant })
    await expect(p).resolves.toEqual(dormant)
  })

  it('retentionConfig returns the applied window', async () => {
    const t = fakeTransport()
    const client = createDaemonClient(t.transport)
    const p = client.retentionConfig()
    expect(t.sent[0]).toEqual({ kind: 'retention-config', id: 1 })
    t.respond({ kind: 'retention-config', id: 1, windowDays: 30, windowMs: 2_592_000_000 })
    await expect(p).resolves.toEqual({ windowDays: 30, windowMs: 2_592_000_000 })
  })

  it('setRetentionWindow sends days and reads back the shared retention-config reply', async () => {
    const t = fakeTransport()
    const client = createDaemonClient(t.transport)
    const p = client.setRetentionWindow(7)
    expect(t.sent[0]).toEqual({ kind: 'set-retention-window', id: 1, windowDays: 7 })
    t.respond({ kind: 'retention-config', id: 1, windowDays: 7, windowMs: 604_800_000 })
    await expect(p).resolves.toEqual({ windowDays: 7, windowMs: 604_800_000 })
  })

  it('retireSession names the session and resolves with the retired id', async () => {
    const t = fakeTransport()
    const client = createDaemonClient(t.transport)
    const p = client.retireSession('s1')
    expect(t.sent[0]).toEqual({ kind: 'retire-session', id: 1, session: 's1' })
    t.respond({ kind: 'retired', id: 1, session: 's1' })
    await expect(p).resolves.toEqual({ session: 's1' })
  })

  it('rejects when the daemon answers with the wrong response kind', async () => {
    const t = fakeTransport()
    const client = createDaemonClient(t.transport)
    const p = client.listDormant()
    t.respond({ kind: 'retired', id: 1, session: 's1' })
    await expect(p).rejects.toThrow(/unexpected daemon response: retired/)
  })
})
