/**
 * services/events/suppression.ts — the paths the pipeline suite
 * (services/__tests__/eventCorrelation.test.ts) does not reach.
 *
 * Why these behaviours matter:
 *  - resolveChangeWindowSteps may run inside a caller's session (the
 *    monitored-services load). If it closed that session, the caller's next
 *    query would fail; if it opened its own and forgot to close it, the
 *    driver pool would drain one alarm at a time.
 *  - A workflow without a `scheduled` step is a legitimate process shape:
 *    it is counted every time but WARNED once per tenant and process,
 *    otherwise every alarm would repeat the same warning and people would
 *    learn to ignore warnings.
 *  - pickChangeWindow must skip a malformed candidate (no step) and keep
 *    looking, not stop and leave a CI un-silenced during a real release.
 *  - With no window step at all nothing can be in a window: no query runs.
 *  - applySuppression must fail loudly when the event or the change vanished
 *    mid-write, and must not announce a suppression that was never written.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn(),
  toNumber: (v: unknown) => (v == null ? 0 : Number(v)),
}))
vi.mock('../../../lib/publishEvent.js', () => ({ publishEvent: vi.fn() }))
vi.mock('../../../lib/audit.js', () => ({ audit: vi.fn() }))
const logger = vi.hoisted(() => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => child }
})
vi.mock('../../../lib/logger.js', () => ({ logger }))
vi.mock('../../../lib/workflowHelpers.js', () => ({ getWorkflowSteps: vi.fn(), getStepNamesByPurpose: vi.fn() }))
vi.mock('../../../lib/ciMetamodelForTenant.js', () => ({ suppressionRelPatternForTenant: vi.fn(async () => 'DEPENDS_ON') }))
const metrics = vi.hoisted(() => ({ eventsSuppressedTotal: { inc: vi.fn() }, workflowPurposeMissingTotal: { inc: vi.fn() } }))
vi.mock('../../../middleware/metrics.js', () => metrics)

const { resolveChangeWindowSteps, pickChangeWindow, changeWindowsForCIs, applySuppression } = await import('../suppression.js')
const { getSession, runQuery, runQueryOne } = await import('@opengraphity/neo4j')
const { getStepNamesByPurpose, getWorkflowSteps } = await import('../../../lib/workflowHelpers.js')
const { publishEvent } = await import('../../../lib/publishEvent.js')
const { audit } = await import('../../../lib/audit.js')

const own = { close: vi.fn(async () => undefined) }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getSession).mockReturnValue(own as never)
})

/** Purpose → step names, as the tenant's change workflow would declare them. */
function purposes(implementation: string[], planned: string[]) {
  vi.mocked(getStepNamesByPurpose).mockImplementation(async (_s, _t, _e, wanted) =>
    (wanted as readonly string[]).includes('implementation') ? implementation : planned)
}

describe('resolveChangeWindowSteps — whose session it reads in', () => {
  it('reuses a caller session that can read, and leaves it open', async () => {
    purposes(['deployment'], ['scheduled'])
    const callerSession = { executeRead: vi.fn(), close: vi.fn() }
    const steps = await resolveChangeWindowSteps('t-1', callerSession as never)
    expect(steps).toEqual({ implementation: ['deployment'], planned: ['scheduled'], all: ['deployment', 'scheduled'] })
    expect(getStepNamesByPurpose).toHaveBeenCalledWith(callerSession, 't-1', 'change', ['implementation'])
    expect(getSession).not.toHaveBeenCalled()
    expect(callerSession.close).not.toHaveBeenCalled()
  })

  it('a transaction (no executeRead) is not reused: its own session is opened and closed', async () => {
    purposes(['deployment'], ['scheduled'])
    await resolveChangeWindowSteps('t-1', { run: vi.fn() } as never)
    expect(getSession).toHaveBeenCalledTimes(1)
    expect(own.close).toHaveBeenCalledTimes(1)
  })
})

describe('resolveChangeWindowSteps — missing `scheduled` purpose', () => {
  it('counts every time but warns once per tenant, and does not stop the pipeline', async () => {
    purposes(['deployment'], [])
    vi.mocked(getWorkflowSteps).mockResolvedValue([{ name: 'deployment' }] as never)

    const first = await resolveChangeWindowSteps('t-warn-once')
    await resolveChangeWindowSteps('t-warn-once')

    expect(first).toEqual({ implementation: ['deployment'], planned: [], all: ['deployment'] })
    expect(metrics.workflowPurposeMissingTotal.inc).toHaveBeenCalledTimes(2)
    expect(metrics.workflowPurposeMissingTotal.inc).toHaveBeenCalledWith({ rule: 'change_window_planned' })
    expect(logger.warn).toHaveBeenCalledTimes(1)

    // Another tenant with the same gap gets its own single warning.
    await resolveChangeWindowSteps('t-other')
    expect(logger.warn).toHaveBeenCalledTimes(2)
  })
})

describe('pickChangeWindow', () => {
  const steps = { implementation: ['deployment'], planned: [], all: ['deployment'] }
  const row = (over: Record<string, unknown>) => ({
    changeId: 'c', code: 'CHG', step: 'deployment', viaCiId: 'ci-1', viaCiName: 'db', upstream: false, plans: null, ...over,
  })

  it('skips a candidate without a step and keeps looking', async () => {
    const picked = pickChangeWindow([
      row({ changeId: 'broken', step: null }),
      row({ changeId: 'good', code: 'CHG2', upstream: 'yes' }),
    ] as never, Date.now(), steps)
    // `upstream` is true only when it is literally true: a truthy string is not an upstream hit.
    expect(picked).toEqual({ changeId: 'good', code: 'CHG2', step: 'deployment', viaCiId: 'ci-1', viaCiName: 'db', upstream: false })
  })

  it('no candidate in a window → null', () => {
    expect(pickChangeWindow([row({ step: 'assessment' })] as never, Date.now(), steps)).toBeNull()
    expect(pickChangeWindow(undefined, Date.now(), steps)).toBeNull()
  })
})

describe('changeWindowsForCIs — no window step in the tenant', () => {
  it('returns an empty map without querying', async () => {
    const out = await changeWindowsForCIs({} as never, 't-1', ['ci-1'], 1, '2026-09-22T10:00:00Z', { implementation: [], planned: [], all: [] })
    expect(out.size).toBe(0)
    expect(runQuery).not.toHaveBeenCalled()
  })
})

describe('applySuppression — the event or change vanished mid-write', () => {
  it('throws, and neither announces nor audits a suppression that was not written', async () => {
    vi.mocked(runQueryOne).mockResolvedValueOnce(null)
    const ev = { props: { id: 'ev-1', status: 'firing', fingerprint: 'f', title: 't', severity: 'critical' }, ciId: 'ci-1' }
    await expect(applySuppression({} as never, 't-1', ev, { changeId: 'chg-1', code: 'CHG1', step: 'deployment' }, 'actor', 'now', 'ingest'))
      .rejects.toThrow(/Event ev-1 or Change chg-1 vanished while suppressing \(tenant t-1\)/)
    // The write is tenant-scoped on both the event and the change.
    expect(vi.mocked(runQueryOne).mock.calls[0]![1]).toMatch(/Event \{id: \$eventId, tenant_id: \$tenantId\}[\s\S]*Change \{id: \$changeId, tenant_id: \$tenantId\}/)
    expect(metrics.eventsSuppressedTotal.inc).not.toHaveBeenCalled()
    expect(publishEvent).not.toHaveBeenCalled()
    expect(audit).not.toHaveBeenCalled()
  })
})
