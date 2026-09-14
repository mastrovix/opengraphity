/**
 * Le decisioni sui valori spediti dopo la copia (revisione del 14 set 2026 · F20):
 * `adoptShippedValues` li aggiunge alla copia con le loro etichette e i loro
 * colori, `acknowledgeShippedValues` li tiene fuori; entrambe segnano come VISTA
 * la lista spedita di adesso. `newShippedValues` li mostra al Dizionario.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GraphQLContext } from '../../../context.js'

vi.mock('@opengraphity/neo4j', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@opengraphity/neo4j')>()
  return { getSession: vi.fn(), toNumber: orig.toNumber, runQuery: vi.fn() }
})
vi.mock('../../../lib/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../../lib/tenantLanguage.js', () => ({ languageFor: vi.fn(async () => 'it') }))
const drift = vi.fn()
vi.mock('../../../lib/vocabularyShippedDrift.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../lib/vocabularyShippedDrift.js')>(),
  vocabulariesBehindShipped: (...a: unknown[]) => drift(...a),
}))

const { enumTypeResolvers } = await import('../enumType.js')
const { getSession } = await import('@opengraphity/neo4j')
const { audit } = await import('../../../lib/audit.js')

const admin: GraphQLContext = { tenantId: 'tenant-1', userId: 'admin-1', userEmail: 'adm@test.io', role: 'admin' }
const operator: GraphQLContext = { ...admin, role: 'operator' }
const rec = (map: Record<string, unknown>) => ({ keys: Object.keys(map), get: (k: string) => (k in map ? map[k] : null) })

const COPY = {
  owner: 'tenant-1', name: 'priority', values: ['low', 'high'], seen: ['low', 'high'],
  valueLabels: JSON.stringify({ low: { it: 'Bassa', en: 'Low' }, high: { it: 'Alta', en: 'High' } }),
  valueColors: JSON.stringify({ high: 'warning' }),
  shipped: ['low', 'high', 'critical'],
  shippedLabels: JSON.stringify({ low: { it: 'Bassa', en: 'Low' }, high: { it: 'Alta', en: 'High' }, critical: { it: 'Critica', en: 'Critical' } }),
  shippedColors: JSON.stringify({ high: 'orange', critical: 'danger' }),
}
const OUT = { id: 'c-1', tenantId: 'tenant-1', name: 'priority', label: 'Priority', values: ['low', 'high', 'critical'], isSystem: false, scope: 'shared', defaultValue: null, createdAt: 'c', updatedAt: 'u', valueLabels: null, valueColors: null }

function fakeSession(read: Record<string, unknown> | null) {
  const txRun = vi.fn().mockImplementation(async (cypher: string) =>
    /\bSET\b/.test(cypher) ? { records: [rec(OUT)] } : { records: read ? [rec(read)] : [] })
  const tx = { run: txRun }
  const s = {
    txRun,
    executeRead:  vi.fn().mockImplementation((fn: (t: typeof tx) => unknown) => fn(tx)),
    executeWrite: vi.fn().mockImplementation((fn: (t: typeof tx) => unknown) => fn(tx)),
    close: vi.fn().mockResolvedValue(undefined),
  }
  vi.mocked(getSession).mockReturnValue(s as never)
  return s
}
const writeOf = (s: ReturnType<typeof fakeSession>) => s.txRun.mock.calls.find(([c]) => /\bSET\b/.test(String(c)))

async function code(p: Promise<unknown>): Promise<string> {
  try { await p; return 'NO ERROR' } catch (e) { return (e as { extensions?: { i18n?: { key?: string }; code?: string } }).extensions?.i18n?.key ?? (e as { extensions?: { code?: string } }).extensions?.code ?? String(e) }
}

describe('adoptShippedValues', () => {
  beforeEach(() => vi.clearAllMocks())

  it('non admin → Forbidden senza sessione', async () => {
    expect(await code(enumTypeResolvers.Mutation.adoptShippedValues(null, { id: 'c-1' }, operator))).toBe('FORBIDDEN')
    expect(getSession).not.toHaveBeenCalled()
  })

  it('sul vocabolario spedito → errore che lo dice, nessuna scrittura', async () => {
    const s = fakeSession({ ...COPY, owner: 'system' })
    expect(await code(enumTypeResolvers.Mutation.adoptShippedValues(null, { id: 'c-1' }, admin))).toBe('errors.enum.shippedValuesOnlyCopies')
    expect(writeOf(s)).toBeUndefined()
  })

  it('un vocabolario del cliente senza gemello spedito → errore, nessuna scrittura', async () => {
    const s = fakeSession({ ...COPY, shipped: null, shippedLabels: null, shippedColors: null })
    expect(await code(enumTypeResolvers.Mutation.adoptShippedValues(null, { id: 'c-1' }, admin))).toBe('errors.enum.noShippedCounterpart')
    expect(writeOf(s)).toBeUndefined()
  })

  it('aggiunge in coda i nuovi con etichette e colori spediti, senza toccare quelli del cliente; li segna visti', async () => {
    const s = fakeSession(COPY)
    await enumTypeResolvers.Mutation.adoptShippedValues(null, { id: 'c-1' }, admin)
    const [cypher, params] = writeOf(s)!
    expect(cypher).toContain('MATCH (e:EnumTypeDefinition {id: $id, tenant_id: $tenantId})')
    expect(params).toMatchObject({ id: 'c-1', tenantId: 'tenant-1', values: ['low', 'high', 'critical'], seen: ['low', 'high', 'critical'] })
    expect(JSON.parse(params.valueLabels as string)).toEqual({ low: { it: 'Bassa', en: 'Low' }, high: { it: 'Alta', en: 'High' }, critical: { it: 'Critica', en: 'Critical' } })
    // Il colore di `high` resta quello del cliente (warning), non quello spedito (orange).
    expect(JSON.parse(params.valueColors as string)).toEqual({ high: 'warning', critical: 'danger' })
    expect(audit).toHaveBeenCalledWith(admin, 'enum_type.shipped_values_adopted', 'EnumTypeDefinition', 'c-1', { name: 'priority', values: ['critical'] })
  })
})

describe('acknowledgeShippedValues', () => {
  beforeEach(() => vi.clearAllMocks())

  it('segna vista la lista spedita e non tocca i valori', async () => {
    const s = fakeSession(COPY)
    await enumTypeResolvers.Mutation.acknowledgeShippedValues(null, { id: 'c-1' }, admin)
    const [cypher, params] = writeOf(s)!
    expect(cypher).toMatch(/SET e\.shipped_values_seen = \$seen,\s+e\.updated_at = \$now/)
    expect(cypher).not.toMatch(/e\.values\s*=/)
    expect(params).toMatchObject({ id: 'c-1', tenantId: 'tenant-1', seen: ['low', 'high', 'critical'] })
    expect(audit).toHaveBeenCalledWith(admin, 'enum_type.shipped_values_declined', 'EnumTypeDefinition', 'c-1', { name: 'priority', values: ['critical'] })
  })

  it('sul vocabolario spedito → errore', async () => {
    fakeSession({ ...COPY, owner: 'system' })
    expect(await code(enumTypeResolvers.Mutation.acknowledgeShippedValues(null, { id: 'c-1' }, admin))).toBe('errors.enum.shippedValuesOnlyCopies')
  })
})

describe('EnumTypeDefinition.newShippedValues', () => {
  beforeEach(() => vi.clearAllMocks())

  it('spedito → nessuno; copia → quelli della lettura, UNA lettura per richiesta', async () => {
    fakeSession(null)
    drift.mockResolvedValue([{ id: 'c-1', name: 'priority', newValues: ['critical'] }])
    const field = enumTypeResolvers.EnumTypeDefinition.newShippedValues
    const ctx = { ...admin }
    expect(await field({ id: 's-1', isShipped: true } as never, {}, ctx)).toEqual([])
    expect(await field({ id: 'c-1', isShipped: false } as never, {}, ctx)).toEqual(['critical'])
    expect(await field({ id: 'c-2', isShipped: false } as never, {}, ctx)).toEqual([])
    expect(drift).toHaveBeenCalledTimes(1)
    expect(drift).toHaveBeenCalledWith(expect.anything(), 'tenant-1')
  })
})
