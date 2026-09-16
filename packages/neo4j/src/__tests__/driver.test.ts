/**
 * driver.ts — NEO4J_MAX_POOL_SIZE (revisione 2 · D1.1): the pool size is
 * configurable per process, defaults to 50, and a value that is not a
 * positive integer is a configuration error (never NaN passed to the driver).
 */
import { describe, it, expect, vi } from 'vitest'

const driverCalls: Array<{ uri: string; config: Record<string, unknown> }> = []
vi.mock('neo4j-driver', () => {
  const fake = {
    driver: vi.fn((uri: string, _auth: unknown, config: Record<string, unknown>) => {
      driverCalls.push({ uri, config })
      return { verifyConnectivity: vi.fn().mockResolvedValue(undefined), session: vi.fn(), close: vi.fn() }
    }),
    auth: { basic: vi.fn(() => ({})) },
    session: { READ: 'READ', WRITE: 'WRITE' },
    isInt: () => false,
  }
  return { default: fake, ...fake }
})

describe('NEO4J_MAX_POOL_SIZE', () => {
  it('parseMaxPoolSize: default 50, positive integers accepted, anything else throws with the variable name', async () => {
    vi.stubEnv('NEO4J_MAX_POOL_SIZE', '')
    const { parseMaxPoolSize, NEO4J_DEFAULT_MAX_POOL_SIZE } = await import('../driver.js')
    expect(NEO4J_DEFAULT_MAX_POOL_SIZE).toBe(50)
    expect(parseMaxPoolSize(undefined)).toBe(50)
    expect(parseMaxPoolSize('')).toBe(50)
    expect(parseMaxPoolSize('40')).toBe(40)
    expect(parseMaxPoolSize('1')).toBe(1)
    for (const bad of ['0', '-5', '2.5', 'abc', '50x']) {
      expect(() => parseMaxPoolSize(bad)).toThrow(/NEO4J_MAX_POOL_SIZE must be a positive integer/)
    }
    vi.unstubAllEnvs()
  })

  it('the driver is created with maxConnectionPoolSize from the environment (default when unset)', async () => {
    const { getDriver } = await import('../driver.js')
    getDriver()
    expect(driverCalls.length).toBeGreaterThanOrEqual(1)
    expect(driverCalls[0]!.config).toMatchObject({ maxConnectionPoolSize: 50, connectionAcquisitionTimeout: 30_000 })
  })
})

/**
 * La sessione avvolta converte i numeri e traccia le query anche su una
 * transazione ESPLICITA (revisione totale · M-22).
 *
 * `beginTransaction` era l'unico modo di ottenere una transazione non
 * avvolta: le sue `tx.run` restituivano `neo4j.Integer` invece di numeri e le
 * sue query non finivano nel tracciamento. Un chiamante c'è davvero
 * (`backup-neo4j.ts`, che esporta tutto in una sola transazione di lettura).
 */
describe('getSession(): beginTransaction', () => {
  it('la transazione esplicita e avvolta: la sua run non e quella grezza del driver', async () => {
    vi.resetModules()
    const neo4j = (await import('neo4j-driver')).default as unknown as { driver: ReturnType<typeof vi.fn> }
    const txRun = vi.fn(async () => ({ records: [], summary: {} }))
    const rawTx = { run: txRun, commit: vi.fn(), rollback: vi.fn() }
    neo4j.driver.mockReturnValue({
      verifyConnectivity: vi.fn().mockResolvedValue(undefined),
      session: vi.fn(() => ({ beginTransaction: () => rawTx, run: vi.fn(), close: vi.fn() })),
      close: vi.fn(),
    } as never)

    const { getSession } = await import('../driver.js')
    const tx = getSession().beginTransaction()

    // È il segno del wrapping: `run` è la funzione del proxy, non quella del
    // driver — quindi passa da convertResult e dal tracciamento.
    expect(tx.run).not.toBe(txRun)
    await tx.run('RETURN 1')
    expect(txRun).toHaveBeenCalledWith('RETURN 1', undefined)
    // commit/rollback restano quelli veri: il proxy tocca solo `run`.
    expect(tx.commit).toBe(rawTx.commit)
  })
})
