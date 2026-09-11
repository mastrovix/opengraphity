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
