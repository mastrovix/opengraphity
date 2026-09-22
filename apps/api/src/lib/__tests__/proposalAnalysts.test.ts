/**
 * The configuration analyst (no AI): turns diagnostics findings into proposals.
 *
 * Why these behaviours matter:
 *  - only findings that can be closed deterministically and reversibly become
 *    proposals; everything else stays a diagnostic for a human to decide;
 *  - the stale portal severities proposal must never propose emptying the
 *    portal (the person would be left with no severity to choose);
 *  - the proposal's scope must not contain the stale values themselves, or every
 *    vocabulary change would spawn a duplicate proposal for the same problem;
 *  - an adapter that crashes must not stop the tenant's scan, but must be logged.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const configurationIssues = vi.fn()
vi.mock('../configurationIssues.js', () => ({ configurationIssues: (t: string) => configurationIssues(t) }))
const portalSeverityOptions = vi.fn()
vi.mock('../portalSeverityOptions.js', () => ({ portalSeverityOptions: (t: string) => portalSeverityOptions(t) }))
const logError = vi.fn()
vi.mock('../logger.js', () => ({ logger: { error: (...a: unknown[]) => logError(...a), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }))

const { analizzaConfigurazione } = await import('../proposalAnalysts.js')

const stale = (values: unknown) => ({ kind: 'portal_severities_stale', severity: 'warning', params: values === undefined ? {} : { values } })
const options = (n: number) => Array.from({ length: n }, (_, i) => ({ value: `s${String(i)}` }))

beforeEach(() => {
  configurationIssues.mockReset()
  portalSeverityOptions.mockReset()
  logError.mockReset()
})

describe('analizzaConfigurazione', () => {
  it('stale portal severities → one proposal removing them, scoped to the tenant', async () => {
    configurationIssues.mockResolvedValueOnce([stale(' critical , blocker,, ')])
    portalSeverityOptions.mockResolvedValueOnce(options(4))
    const out = await analizzaConfigurazione('t1')
    expect(out).toEqual([{
      tenantId: 't1',
      area: 'configuration',
      kind: 'proposal.portalSeveritiesStale',
      params: { values: 'critical, blocker', count: '2' },
      scope: 'portal_severities',
      evidence: { n: 2, windowDays: 0, refs: [], extra: { stale: 'critical, blocker', remaining: 2 } },
      action: { type: 'portal_severities.remove_stale', params: {} },
    }])
    expect(configurationIssues).toHaveBeenCalledWith('t1')
    expect(portalSeverityOptions).toHaveBeenCalledWith('t1')
  })

  it('the scope does not carry the stale values: the same problem keeps the same fingerprint', async () => {
    configurationIssues.mockResolvedValueOnce([stale('a')]).mockResolvedValueOnce([stale('b, c')])
    portalSeverityOptions.mockResolvedValue(options(5))
    const [first] = await analizzaConfigurazione('t1')
    const [second] = await analizzaConfigurazione('t1')
    expect(first!.scope).toBe(second!.scope)
  })

  it('never proposes emptying the portal: if removing would leave nothing, no proposal', async () => {
    configurationIssues.mockResolvedValueOnce([stale('a, b')])
    portalSeverityOptions.mockResolvedValueOnce(options(2))
    expect(await analizzaConfigurazione('t1')).toEqual([])
  })

  it('no portal severities configured → nothing to remove', async () => {
    configurationIssues.mockResolvedValueOnce([stale('a')])
    portalSeverityOptions.mockResolvedValueOnce(null)
    expect(await analizzaConfigurazione('t1')).toEqual([])
  })

  it('a finding with no usable values → no proposal', async () => {
    configurationIssues.mockResolvedValueOnce([stale(undefined), stale(' , ')])
    portalSeverityOptions.mockResolvedValue(options(3))
    expect(await analizzaConfigurazione('t1')).toEqual([])
  })

  it('findings that need a human decision are left to the diagnostics', async () => {
    configurationIssues.mockResolvedValueOnce([
      { kind: 'timezone_not_set', severity: 'warning', params: {} },
      { kind: 'default_language_not_set', severity: 'warning', params: {} },
    ])
    expect(await analizzaConfigurazione('t1')).toEqual([])
    // Not even asked: the adapter only reads what its own finding needs.
    expect(portalSeverityOptions).not.toHaveBeenCalled()
  })

  it('a crashing adapter is logged and does not stop the other findings', async () => {
    configurationIssues.mockResolvedValueOnce([stale('a'), stale('b')])
    portalSeverityOptions.mockRejectedValueOnce(new Error('neo4j down')).mockResolvedValueOnce(options(3))
    const out = await analizzaConfigurazione('t1')
    expect(out).toHaveLength(1)
    expect(out[0]!.params['values']).toBe('b')
    expect(logError).toHaveBeenCalledTimes(1)
    expect(logError.mock.calls[0]![0]).toMatchObject({ tenantId: 't1', kind: 'portal_severities_stale', err: 'neo4j down' })
  })

  it('a non-Error throw is still logged with its text', async () => {
    configurationIssues.mockResolvedValueOnce([stale('a')])
    portalSeverityOptions.mockRejectedValueOnce('plain string')
    expect(await analizzaConfigurazione('t1')).toEqual([])
    expect(logError.mock.calls[0]![0]).toMatchObject({ err: 'plain string' })
  })
})
