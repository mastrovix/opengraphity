/**
 * The queue around the self-analysis chain (autoanalisiWorker.ts).
 *
 * The sibling test pins the two jobs; this one pins the plumbing that decides
 * whether they run at all and run ONCE:
 *  - the enqueue uses a jobId derived from tenant + problem, so a retried
 *    mutation (or two replicas serving it) cannot open two GitHub issues for
 *    the same Problem;
 *  - the worker routes `controlla` to the periodic check and everything else
 *    to the dossier transport, and registers the recurring check at start
 *    (an upsert, so a restart does not schedule it twice);
 *  - `issueDelProblem` only returns a real number: a missing or corrupt link
 *    must read as "no issue", never as a bogus issue number shown to a user;
 *  - an empty waiting list never reaches GitHub.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Job } from 'bullmq'

const add = vi.fn()
const upsertJobScheduler = vi.fn()
let processor: ((job: Job) => Promise<void>) | undefined
const createWorker = vi.fn((_name: string, p: (job: Job) => Promise<void>) => { processor = p; return { name: 'worker' } })
vi.mock('../../lib/bullmq.js', () => ({
  getQueue: vi.fn(() => ({ add, upsertJobScheduler })),
  createWorker: (...a: unknown[]) => createWorker(...(a as [string, (job: Job) => Promise<void>])),
}))

const cfg = { valore: { repo: 'owner/repo', token: 'fake' } as { repo: string; token: string } | null }
const statoDellAnalisi = vi.fn()
const apriIssueDelFascicolo = vi.fn(async () => 7)
const chiediAnalisi = vi.fn(async () => {})
vi.mock('../../lib/autoanalisiGitHub.js', () => ({
  configurazioneAutoanalisi: () => cfg.valore,
  apriIssueDelFascicolo: (...a: unknown[]) => apriIssueDelFascicolo(...(a as [])),
  chiediAnalisi: (...a: unknown[]) => chiediAnalisi(...(a as [])),
  statoDellAnalisi: (...a: unknown[]) => statoDellAnalisi(...a),
}))
vi.mock('../../lib/problemDossier.js', () => ({ fascicoloDelProblem: async () => '## dossier' }))
vi.mock('../../lib/indagineAutomatica.js', () => ({ segnaRisolto: vi.fn() }))
const reportsClosed = vi.hoisted(() => vi.fn(async () => 0))
vi.mock('../../lib/openGrafoReports.js', () => ({ reportsClosed }))

const close = vi.fn(async () => {})
const run = vi.fn(async () => {})
const runQuery = vi.fn()
const runQueryOne = vi.fn()
vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(() => ({ run, close })),
  runQuery: (...a: unknown[]) => runQuery(...a),
  runQueryOne: (...a: unknown[]) => runQueryOne(...a),
}))

const logInfo = vi.fn()
vi.mock('../../lib/logger.js', () => ({
  logger: { child: () => ({ info: logInfo, warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}))

const {
  enqueuePortaIlFascicolo, startAutoanalisiWorker, issueDelProblem, AUTOANALISI_QUEUE, INTERVALLO_CONTROLLO_MS, _perITest,
} = await import('../autoanalisiWorker.js')

const DATA = { tenantId: 'opengrafo', problemId: 'prb-9', problemNumber: 'PRB00000009', titolo: 'bus down' }
const job = (name: string, data: unknown = {}): Job => ({ name, data } as unknown as Job)

beforeEach(() => {
  vi.clearAllMocks()
  processor = undefined
  cfg.valore = { repo: 'owner/repo', token: 'fake' }
  runQuery.mockResolvedValue([])
})

describe('enqueuePortaIlFascicolo', () => {
  it('uses one jobId per tenant+problem, so a retried mutation cannot file two issues', async () => {
    await enqueuePortaIlFascicolo(DATA)
    expect(add).toHaveBeenCalledTimes(1)
    const [name, data, opts] = add.mock.calls[0]!
    expect(name).toBe('porta-il-fascicolo')
    expect(data).toEqual(DATA)
    expect(opts).toMatchObject({ jobId: 'fascicolo-opengrafo-prb-9', attempts: 3 })
    // A different Problem must NOT collide with the first one.
    await enqueuePortaIlFascicolo({ ...DATA, problemId: 'prb-10' })
    expect(add.mock.calls[1]![2]).toMatchObject({ jobId: 'fascicolo-opengrafo-prb-10' })
  })
})

describe('startAutoanalisiWorker', () => {
  it('registers the recurring check every quarter hour on its own queue', async () => {
    const worker = await startAutoanalisiWorker()
    expect(worker).toEqual({ name: 'worker' })
    expect(createWorker).toHaveBeenCalledWith(AUTOANALISI_QUEUE, expect.any(Function))
    expect(upsertJobScheduler).toHaveBeenCalledWith(
      'autoanalisi-controlla', { every: INTERVALLO_CONTROLLO_MS }, expect.objectContaining({ name: 'controlla' }),
    )
    // The start log states whether a repository is linked: the operator reads it there.
    expect(logInfo).toHaveBeenCalledWith(expect.objectContaining({ configured: true }), 'autoanalisi worker started')
  })

  it('says "not configured" at start when no repository is linked', async () => {
    cfg.valore = null
    await startAutoanalisiWorker()
    expect(logInfo).toHaveBeenCalledWith(expect.objectContaining({ configured: false }), 'autoanalisi worker started')
  })

  it('routes `controlla` to the periodic check and any other job to the dossier transport', async () => {
    await startAutoanalisiWorker()
    await processor!(job('controlla'))
    // The check reads the waiting Problems; it never opens an issue.
    expect(runQuery).toHaveBeenCalledTimes(1)
    expect(apriIssueDelFascicolo).not.toHaveBeenCalled()

    await processor!(job('porta-il-fascicolo', DATA))
    expect(apriIssueDelFascicolo).toHaveBeenCalledTimes(1)
    expect(chiediAnalisi).toHaveBeenCalledWith(cfg.valore, { issue: 7, problemNumber: 'PRB00000009' })
  })
})

describe('controlla with nothing waiting', () => {
  it('tells the customers whose reported problems were closed, with or without GitHub (26 Sep 2026)', async () => {
    const before = cfg.valore
    cfg.valore = null as never
    await _perITest.controlla()
    expect(reportsClosed).toHaveBeenCalledTimes(1)
    reportsClosed.mockRejectedValueOnce(new Error('neo4j down'))
    await expect(_perITest.controlla()).resolves.toBeUndefined()
    cfg.valore = before
  })

  it('does not ask GitHub anything and closes the read session', async () => {
    runQuery.mockResolvedValue([])
    await _perITest.controlla()
    expect(statoDellAnalisi).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('closes the read session even when the query fails', async () => {
    runQuery.mockRejectedValueOnce(new Error('neo4j down'))
    await expect(_perITest.controlla()).rejects.toThrow('neo4j down')
    expect(close).toHaveBeenCalledTimes(1)
  })
})

describe('issueDelProblem', () => {
  it('returns the issue number linked to the Problem, scoped by tenant', async () => {
    runQueryOne.mockResolvedValueOnce({ issue: 25 })
    await expect(issueDelProblem('opengrafo', 'prb-1')).resolves.toBe(25)
    expect(runQueryOne.mock.calls[0]![2]).toEqual({ tenantId: 'opengrafo', problemId: 'prb-1' })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('reads a missing Problem, a missing link or a non-number as "no issue"', async () => {
    runQueryOne.mockResolvedValueOnce(null)
    await expect(issueDelProblem('opengrafo', 'prb-x')).resolves.toBeNull()
    runQueryOne.mockResolvedValueOnce({ issue: null })
    await expect(issueDelProblem('opengrafo', 'prb-1')).resolves.toBeNull()
    runQueryOne.mockResolvedValueOnce({ issue: '25' })
    await expect(issueDelProblem('opengrafo', 'prb-1')).resolves.toBeNull()
  })

  it('closes the session when the read fails', async () => {
    runQueryOne.mockRejectedValueOnce(new Error('boom'))
    await expect(issueDelProblem('opengrafo', 'prb-1')).rejects.toThrow('boom')
    expect(close).toHaveBeenCalledTimes(1)
  })
})
