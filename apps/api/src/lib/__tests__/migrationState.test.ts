/**
 * Revisione del 14 set 2026 · F8: un deploy senza `migrate` girava con schema e
 * dati non allineati, in silenzio. Ora il prodotto SA quante migrazioni del
 * codice non sono applicate: lo dicono `/health`, la diagnostica e l'avvio.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const listMigrationStatus = vi.fn()
vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(() => ({ close: vi.fn(async () => {}) })),
  listMigrationStatus: (...a: unknown[]) => listMigrationStatus(...a),
}))
vi.mock('../../scripts/migrations/index.js', () => ({ MIGRATIONS: [{ id: 'a' }, { id: 'b' }] }))

const { pendingMigrations, clearMigrationStateCache, assertMigrationsAppliedAtBoot } = await import('../migrationState.js')

describe('stato delle migrazioni', () => {
  beforeEach(() => { listMigrationStatus.mockReset(); clearMigrationStateCache() })

  it('elenca le migrazioni del codice non applicate (non quelle sconosciute al codice)', async () => {
    listMigrationStatus.mockResolvedValueOnce([
      { id: 'a', appliedAt: '2026-09-01', unknown: false },
      { id: 'b', appliedAt: null, unknown: false },
      { id: 'old', appliedAt: '2026-01-01', unknown: true },
    ])
    expect(await pendingMigrations()).toEqual(['b'])
  })

  it('cache breve: una sonda al secondo non fa una query al secondo', async () => {
    listMigrationStatus.mockResolvedValue([{ id: 'a', appliedAt: null, unknown: false }])
    await pendingMigrations(1_000)
    await pendingMigrations(2_000)
    expect(listMigrationStatus).toHaveBeenCalledTimes(1)
  })

  it('all\'avvio: con migrazioni pendenti lo dice nei log; con REQUIRE_APPLIED_MIGRATIONS si ferma', async () => {
    listMigrationStatus.mockResolvedValue([{ id: 'b', appliedAt: null, unknown: false }])
    const log = { error: vi.fn(), info: vi.fn() }
    await expect(assertMigrationsAppliedAtBoot({ require: false, log })).resolves.toEqual(['b'])
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ pending: ['b'] }), expect.stringContaining('pending'))
    clearMigrationStateCache()
    await expect(assertMigrationsAppliedAtBoot({ require: true, log })).rejects.toThrow(/b/)
  })
})
