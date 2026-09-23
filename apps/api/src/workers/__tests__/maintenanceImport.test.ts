/**
 * IMPORTING THE MAINTENANCE WORKER READS NO CONFIGURATION (review of 23 Sep 2026).
 *
 * worker.ts imports this module in every worker process, and `events-worker`
 * has no BACKUP_DIR. The module read it at import, so the deploy of the wave
 * that moved the backup to the `worker` stopped `events-worker` at start —
 * every test imported the module with the variable set, and none saw it.
 * What must hold: in production, without BACKUP_DIR, the import succeeds and
 * only STARTING the maintenance group fails, naming the variable.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { resetConfigCache } from '../../lib/config.js'

// The driver package connects at import: out of the way, this test is about configuration.
vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), getDriver: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn(), toNative: (v: unknown) => v, toNumber: Number }))
vi.mock('../../lib/bullmq.js', () => ({
  createWorker: vi.fn(() => ({ name: 'maintenance' })),
  getQueue: vi.fn(() => ({ removeJobScheduler: vi.fn(async () => {}), upsertJobScheduler: vi.fn(async () => {}) })),
}))

// What `events-worker` has: the connections, not the backup's variables. Fake values: nothing connects at import.
const ENV: Record<string, string | undefined> = {
  NODE_ENV: 'production', BACKUP_DIR: undefined,
  NEO4J_URI: 'bolt://neo4j:7687', NEO4J_USER: 'neo4j', NEO4J_PASSWORD: 'x',
  REDIS_URL: 'redis://redis:6379', REDIS_PASSWORD: 'x',
}
const saved = Object.fromEntries(Object.keys(ENV).map((k) => [k, process.env[k]]))
const apply = (env: Record<string, string | undefined>) => {
  for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  resetConfigCache()
}
beforeAll(() => apply(ENV))
afterAll(() => apply(saved))

describe('maintenance.worker import', () => {
  it('in production without BACKUP_DIR the import succeeds; only starting the group fails, naming the variable', async () => {
    const mod = await import('../maintenance.worker.js')
    expect(typeof mod.startMaintenanceWorker).toBe('function')
    await expect(mod.startMaintenanceWorker()).rejects.toThrow(/BACKUP_DIR/)
  })
})
