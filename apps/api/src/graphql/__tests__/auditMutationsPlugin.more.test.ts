/**
 * graphql/auditMutationsPlugin.ts — the shape of the arguments written to the
 * Audit Log, and the entity type when nothing better is known.
 *
 * Every mutation without its own entry lands in the registry with its
 * arguments. If lists were not truncated, a bulk import would write megabytes
 * per entry; if exotic values (bigint, functions) were passed through, the
 * JSON serialisation of the entry would throw and the entry would be lost;
 * if the type fallback returned an empty string, the entry would be
 * unsearchable by entity type.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../../lib/audit.js', () => ({ audit: vi.fn() }))
vi.mock('../../lib/logger.js', () => ({ logger: { child: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }) } }))

const { auditableArgs, auditEntityType, auditEntityId } = await import('../auditMutationsPlugin.js')

describe('auditableArgs', () => {
  it('keeps short lists, maps each item', () => {
    expect(auditableArgs({ ids: ['a', 'b'], nested: [{ token: 'x', n: 1 }] })).toEqual({ ids: ['a', 'b'], nested: [{ token: '[redacted]', n: 1 }] })
  })

  it('cuts a list after 50 items and says how many there were', () => {
    const out = auditableArgs(Array.from({ length: 60 }, (_, i) => i)) as unknown[]
    expect(out).toHaveLength(51)
    expect(out[49]).toBe(49)
    expect(out[50]).toBe('… (60 items)')
  })

  it('cuts a long string and says its length', () => {
    const out = auditableArgs('x'.repeat(600)) as string
    expect(out.startsWith('x'.repeat(500))).toBe(true)
    expect(out.endsWith('… (600 chars)')).toBe(true)
  })

  it('stops at depth 4 instead of copying an arbitrarily deep object', () => {
    expect(auditableArgs({ a: { b: { c: { d: { e: 1 } } } } })).toEqual({ a: { b: { c: { d: '[…]' } } } })
  })

  it('turns values JSON cannot carry into strings', () => {
    // A bigint would make JSON.stringify throw and the whole entry would be lost.
    expect(auditableArgs(10n)).toBe('10')
    expect(auditableArgs({ n: 10n })).toEqual({ n: '10' })
  })

  it('keeps a null secret as null: "redacted" would claim a value existed', () => {
    expect(auditableArgs({ password: null, apiKey: undefined })).toEqual({ password: null, apiKey: undefined })
  })
})

describe('auditMutationsPlugin scope', () => {
  it('does not hook field resolution for queries: reads never reach the Audit Log', async () => {
    const { auditMutationsPlugin } = await import('../auditMutationsPlugin.js')
    const listener = await auditMutationsPlugin().requestDidStart!({} as never)
    const hooks = await listener!.executionDidStart!({ operation: { operation: 'query' } } as never)
    expect(hooks).toBeUndefined()
  })
})

describe('auditEntityType / auditEntityId fallbacks', () => {
  it('a mutation that is only a verb, returning a scalar, keeps its own name as type', () => {
    expect(auditEntityType('sync', 'Boolean!')).toBe('sync')
  })

  it('a lower-case return type is not taken as an entity type', () => {
    expect(auditEntityType('createThing', 'weird')).toBe('Thing')
  })

  it('a container argument that is empty falls back to the ordinary rules', () => {
    // `addCIToChange` with an empty changeId must not write an entry with an empty id.
    expect(auditEntityType('addCIToChange', 'ChangeAffectedCI!', { changeId: '' })).toBe('ChangeAffectedCI')
    expect(auditEntityId({ changeId: '', ciId: 'ci-1' }, null, 'addCIToChange')).toBe('ci-1')
  })

  it('a numeric id is stringified', () => {
    expect(auditEntityId({ id: 42 }, null)).toBe('42')
    expect(auditEntityId({ changeId: 7 }, null, 'addCIToChange')).toBe('7')
  })
})
