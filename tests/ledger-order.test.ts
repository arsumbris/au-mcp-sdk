import { describe, it, expect } from 'vitest'
import { compareByProductionOrder, traceEvent, type LedgerLine, type SessionEvent } from '../src/index.ts'

describe('compareByProductionOrder — the canonical (at, run, seq) ledger ordering', () => {
  const sort = <T extends { at?: string; run: number; seq: number }>(xs: T[]): T[] => [...xs].sort(compareByProductionOrder)

  it('orders by production time `at` first', () => {
    const a = { at: '2026-08-08T00:00:02.000Z', run: 1, seq: 1 }
    const b = { at: '2026-08-08T00:00:01.000Z', run: 9, seq: 9 }
    expect(sort([a, b])).toEqual([b, a]) // earlier `at` wins despite higher run/seq
  })

  it('tie-breaks equal `at` by run, THEN seq — the resume-safety case', () => {
    const at = '2026-08-08T00:00:00.000Z'
    const r1s5 = { at, run: 1, seq: 5 }
    const r2s1 = { at, run: 2, seq: 1 }
    // run 2 seq 1 sorts AFTER run 1 seq 5: a bare-seq tie-break (1 < 5) would misorder it.
    expect(sort([r2s1, r1s5])).toEqual([r1s5, r2s1])
  })

  it('within one run, ties break by seq', () => {
    const at = '2026-08-08T00:00:00.000Z'
    const s2 = { at, run: 3, seq: 2 }
    const s1 = { at, run: 3, seq: 1 }
    expect(sort([s2, s1])).toEqual([s1, s2])
  })

  it('an absent `at` sorts as epoch 0, deterministically behind any dated event', () => {
    const dated = { at: '2026-08-08T00:00:00.000Z', run: 5, seq: 5 }
    const undatedEvent: SessionEvent = { kind: 'x', run: 1, seq: 1, session: 's', data: null } // no `at`
    expect(sort([dated, undatedEvent])).toEqual([undatedEvent, dated])
  })

  it('LedgerLine and a traceEvent-built SessionEvent both carry `run` and sort together', () => {
    const line: LedgerLine = { run: 2, seq: 1, kind: 'tool_call', at: '2026-08-08T00:00:03.000Z' }
    const ev = traceEvent('user_prompt', 's', null, '2026-08-08T00:00:01.000Z')
    expect(ev.run).toBe(0) // daemon stamps the authoritative run on append; the envelope starts 0
    expect(sort([line, { ...ev, run: 1, seq: 1 }]).map((x) => x.kind)).toEqual(['user_prompt', 'tool_call'])
  })
})
