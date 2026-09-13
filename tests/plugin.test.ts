import { describe, it, expect } from 'vitest'
import type { Plugin, Stamp, Stamper, WriteContext, WriteKind } from '../src/plugin.ts'

// The `stamper` shape is a first-class part of the plugin contract: a plugin declares
// `shapes: ['stamper']` and exports a `stamp(ctx)` returning the stamps for a write. These
// tests lock the shape's surface (it typechecks as a Plugin, it is shape-detectable at runtime,
// and its stamp fn returns the Stamp list the kernel collects).

const launch = {} // SessionLaunch: only optional fields now (config retired)
const ctx = (kind: WriteKind, over: Partial<WriteContext> = {}): WriteContext => ({
  session: 's1',
  kind,
  path: '/ws/note.md',
  launch,
  ...over,
})

describe('the stamper plugin shape', () => {
  it('a plugin can declare the stamper shape and expose a stamp fn', () => {
    const plugin: Plugin = {
      manifest: { id: 'mcp.demo-stamper', name: 'Demo Stamper', kind: 'hook', contractVersion: 0, shapes: ['stamper'] },
      stamp(c: WriteContext): Stamp[] {
        return [{ field: 'spine', record: { kind: c.kind, session: c.session } }]
      },
    }
    // hook kind + shape-detectable off the manifest, and the runtime carries the stamp fn.
    expect(plugin.manifest.kind).toBe('hook')
    if (plugin.manifest.kind === 'hook') expect(plugin.manifest.shapes).toContain('stamper')
    expect(typeof plugin.stamp).toBe('function')
  })

  it('stamp maps the kernel-derived KIND to consumer records, and may decline with []', async () => {
    const stamper: Stamper = {
      stamp(c) {
        if (c.kind === 'rename') return [] // decline
        return [{ field: 'spine', record: { type: `change.${c.kind}`, session: c.session }, matchOn: { type: `change.${c.kind}` } }]
      },
    }
    expect(await stamper.stamp(ctx('create'))).toEqual([{ field: 'spine', record: { type: 'change.create', session: 's1' }, matchOn: { type: 'change.create' } }])
    expect(await stamper.stamp(ctx('edit'))).toEqual([{ field: 'spine', record: { type: 'change.edit', session: 's1' }, matchOn: { type: 'change.edit' } }])
    expect(await stamper.stamp(ctx('rename', { from: '/ws/old.md', at: '2026-08-06T00:00:00Z' }))).toEqual([])
  })

  it('stamp may be async (a stamper that consults the engine for coverage)', async () => {
    const stamper: Stamper = {
      async stamp(c) {
        return c.kind === 'create' ? [{ field: 'spine', record: { session: c.session } }] : []
      },
    }
    await expect(stamper.stamp(ctx('create'))).resolves.toHaveLength(1)
    await expect(stamper.stamp(ctx('edit'))).resolves.toHaveLength(0)
  })

  it('a plugin can combine mediator + stamper (one plugin, two shapes)', () => {
    const plugin: Plugin = {
      manifest: { id: 'mcp.guard-and-spine', name: 'Guard + Spine', kind: 'hook', contractVersion: 0, shapes: ['mediator', 'stamper'] },
      decide: () => ({ kind: 'allow' }),
      stamp: () => [{ field: 'spine', record: {} }],
    }
    expect(plugin.manifest.kind).toBe('hook')
    if (plugin.manifest.kind === 'hook') expect(plugin.manifest.shapes).toEqual(['mediator', 'stamper'])
    expect(typeof plugin.decide).toBe('function')
    expect(typeof plugin.stamp).toBe('function')
  })
})
