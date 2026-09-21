/**
 * Il peso dell'ambiente nel rischio della change come dato del cliente
 * (giro nel browser del 14 set 2026, #32): era `ENV_WEIGHT = 5` nel codice.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ raw: undefined as unknown, exists: true, writes: [] as Array<Record<string, unknown>> }))
vi.mock('@opengraphity/neo4j', () => ({
  getSession: () => ({
    close: vi.fn().mockResolvedValue(undefined),
    executeRead: async (fn: (tx: unknown) => unknown) => fn({ run: async () => ({ records: h.exists ? [{ get: () => h.raw }] : [] }) }),
    executeWrite: async (fn: (tx: unknown) => unknown) => fn({ run: async (_c: string, p: Record<string, unknown>) => { h.writes.push(p); return { records: h.exists ? [{ get: () => 't1' }] : [] } } }),
  }),
}))
vi.mock('../schemaInvalidator.js', () => ({ invalidateSchema: vi.fn(), registerMetamodelCacheClearer: vi.fn() }))

const { changeEnvironmentWeight, setChangeEnvironmentWeight, clearEnvironmentWeightCache, FACTORY_ENVIRONMENT_WEIGHT } = await import('../changeEnvironmentWeight.js')
const { invalidateSchema } = await import('../schemaInvalidator.js')

beforeEach(() => { clearEnvironmentWeightCache(); h.raw = undefined; h.exists = true; h.writes = []; vi.clearAllMocks() })

describe('changeEnvironmentWeight', () => {
  it('proprietà assente → il 5 di prima, dichiarato come default', async () => {
    h.raw = null
    expect(await changeEnvironmentWeight('t1')).toEqual({ weight: FACTORY_ENVIRONMENT_WEIGHT, isDefault: true })
  })

  it('il valore del cliente vale; un valore corrotto è un errore, non un ripiego', async () => {
    h.raw = 1
    expect(await changeEnvironmentWeight('t1')).toEqual({ weight: 1, isDefault: false })
    clearEnvironmentWeightCache()
    h.raw = 'molto'
    await expect(changeEnvironmentWeight('t1')).rejects.toThrow(/integer between 0 and 20/)
  })

  it('tenant inesistente → errore', async () => {
    h.exists = false
    await expect(changeEnvironmentWeight('tx')).rejects.toThrow(/does not exist/)
  })

  it('il salvataggio valida l\'intervallo e tira la leva delle cache', async () => {
    await expect(setChangeEnvironmentWeight('t1', 21)).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } })
    await expect(setChangeEnvironmentWeight('t1', 1.5)).rejects.toThrow(/integer/)
    expect(h.writes).toHaveLength(0)
    expect(await setChangeEnvironmentWeight('t1', 0)).toEqual({ weight: 0, isDefault: false })
    expect(h.writes[0]).toMatchObject({ tenantId: 't1', weight: 0 })
    expect(invalidateSchema).toHaveBeenCalledWith('t1')
  })
})
