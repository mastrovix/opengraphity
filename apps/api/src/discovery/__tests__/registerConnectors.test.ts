/**
 * Discovery connector registration at API start-up.
 *
 * Why it matters: if a connector is missing from the registry, every sync
 * source of that type fails with "Connector not registered". Hot reload
 * registers them a second time, and that one case must be tolerated; any
 * other registration error must stop the start-up loudly instead of being
 * mislabeled as a harmless duplicate.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const registerConnector = vi.fn()
vi.mock('@opengraphity/discovery', () => ({ registerConnector: (c: unknown) => registerConnector(c) }))
vi.mock('../connectors/aws.js',        () => ({ awsConnector:        { type: 'aws' } }))
vi.mock('../connectors/azure.js',      () => ({ azureConnector:      { type: 'azure' } }))
vi.mock('../connectors/gcp.js',        () => ({ gcpConnector:        { type: 'gcp' } }))
vi.mock('../connectors/kubernetes.js', () => ({ kubernetesConnector: { type: 'kubernetes' } }))
vi.mock('../connectors/csv.js',        () => ({ csvConnector:        { type: 'csv' } }))
vi.mock('../connectors/json.js',       () => ({ jsonConnector:       { type: 'json' } }))
const logInfo = vi.fn()
const logDebug = vi.fn()
vi.mock('../../lib/logger.js', () => ({ logger: { info: logInfo, debug: logDebug, warn: vi.fn(), error: vi.fn() } }))

const { registerAllConnectors } = await import('../registerConnectors.js')

const registeredTypes = () => registerConnector.mock.calls.map((c) => (c[0] as { type: string }).type)

beforeEach(() => {
  vi.clearAllMocks()
  registerConnector.mockReset()
})

describe('registerAllConnectors', () => {
  it('registers every shipped connector type', () => {
    registerAllConnectors()
    expect(registeredTypes()).toEqual(['aws', 'azure', 'gcp', 'kubernetes', 'csv', 'json'])
    expect(logInfo).toHaveBeenCalledWith({ count: 6 }, expect.any(String))
  })

  it('a duplicate registration (hot reload) is skipped and the others still register', () => {
    registerConnector.mockImplementation((c: { type: string }) => {
      if (c.type === 'gcp') throw new Error('Connector "gcp" is already registered')
    })
    expect(() => registerAllConnectors()).not.toThrow()
    // The loop must continue past the duplicate: the connectors after it matter too.
    expect(registeredTypes()).toEqual(['aws', 'azure', 'gcp', 'kubernetes', 'csv', 'json'])
    expect(logDebug).toHaveBeenCalledWith({ type: 'gcp' }, expect.stringContaining('already registered'))
  })

  it('any other failure propagates instead of being passed off as a duplicate', () => {
    registerConnector.mockImplementation((c: { type: string }) => {
      if (c.type === 'azure') throw new Error('invalid connector shape')
    })
    expect(() => registerAllConnectors()).toThrow('invalid connector shape')
    expect(logInfo).not.toHaveBeenCalled()
  })

  it('a non-Error throw is not mistaken for the duplicate case either', () => {
    registerConnector.mockImplementation(() => { throw 'already registered' })
    expect(() => registerAllConnectors()).toThrow('already registered')
  })
})
