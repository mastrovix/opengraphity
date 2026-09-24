/**
 * Step deadlines (lib/stepDeadlines.ts) — the paths the sibling test does not
 * reach.
 *
 * Why they matter:
 *  - a calendar deadline is computed with the tenant's calendar AND timezone,
 *    each fetched once per sweep (not once per ticket: a sweep can see
 *    hundreds of tickets in the same step);
 *  - the sweep's summary counts refusals and failures, which the diagnostics
 *    and the metrics read;
 *  - a ticket that left the step, or an entity type with no label, is skipped
 *    and its claim released — never moved on stale data;
 *  - non-change tickets publish "ticket updated" for each field the deadline
 *    writes (notifications and automations listen to it); changes and KB
 *    articles do not have that channel;
 *  - the fields the deadline writes reach the pipeline of the transitions,
 *    whose conditions must see them (the pipeline and the registered step
 *    actions are tested on their own: services/__tests__/ticketTransition,
 *    workflow/__tests__/stepActions);
 *  - a retried refusal/failure is logged quietly (debug) — only the FIRST one
 *    is loud, otherwise the log fills with the same line every hour;
 *  - any unexpected error ends as `failed` on the execution (retried in an
 *    hour), never as an exception that kills the sweep.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { StepDeadline } from '@opengraphity/types'

const runQuery    = vi.fn()
const runQueryOne = vi.fn()
const session = { close: vi.fn(async () => {}) }
vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(() => session),
  runQuery:    (...a: unknown[]) => runQuery(...a),
  runQueryOne: (...a: unknown[]) => runQueryOne(...a),
}))

const calendarsById: Record<string, unknown> = {}
const getServiceCalendarById = vi.fn(async (_t: string, id: string) => calendarsById[id])
const getTenantTimezone = vi.fn(async (_t: string) => 'Europe/Rome')
vi.mock('@opengraphity/sla', async () => {
  const policy = await import('../../../../../packages/sla/src/policy.js')
  const calendar = await import('../../../../../packages/sla/src/calendar.js')
  return {
    calculateDeadline: policy.calculateDeadline,
    minutesOfDay: calendar.minutesOfDay,
    getServiceCalendarById: (t: string, id: string) => getServiceCalendarById(t, id),
    getTenantTimezone: (t: string) => getTenantTimezone(t),
  }
})

// The pipeline of the transitions (wave 7 · B1): the guards and the move.
const checkTicketTransition = vi.fn(async (..._a: unknown[]): Promise<unknown> => null)
const transitionTicket = vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ moved: true, actionErrors: [] }))
vi.mock('../../services/ticketTransition.js', () => ({
  checkTicketTransition: (...a: unknown[]) => checkTicketTransition(...a),
  transitionTicket: (...a: unknown[]) => transitionTicket(...a),
}))
const refusal = (guard: string, message = 'held') => ({ guard, message, code: 'CONFLICT', final: true })

vi.mock('../stepFieldWrites.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  stepFieldMetas: vi.fn(async () => new Map([
    ['outcome', { name: 'outcome', fieldType: 'enum', enumValues: ['successful', 'failed'], enumTypeName: 'change_outcome' }],
  ])),
}))
const writeTicketField = vi.fn(async (..._a: unknown[]) => ({ before: { outcome: null }, after: { outcome: 'successful' } }))
vi.mock('../ticketFieldWrite.js', () => ({ writeTicketField: (...a: unknown[]) => writeTicketField(...a) }))
const publishTicketUpdated = vi.fn(async (..._a: unknown[]) => {})
vi.mock('../ticketUpdated.js', () => ({ publishTicketUpdated: (...a: unknown[]) => publishTicketUpdated(...a) }))
vi.mock('../audit.js', () => ({ audit: vi.fn(async () => {}) }))
vi.mock('../../middleware/metrics.js', () => ({ stepDeadlineOutcomesTotal: { inc: vi.fn() } }))
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
vi.mock('../logger.js', () => ({ logger: { child: () => log } }))

const { fireStepDeadline, runStepDeadlineSweep } = await import('../stepDeadlines.js')

const REVIEW: StepDeadline = { after: 7, unit: 'days', calendar_id: null, to_step: 'closed', set_fields: [{ field: 'outcome', value: 'successful' }] }
const NOW = new Date('2026-09-20T10:00:00Z')

type Candidate = Parameters<typeof fireStepDeadline>[0]
const candidate = (over: Partial<Candidate> = {}): Candidate => ({
  tenantId: 'c-test', instanceId: 'wi-1', entityId: 'chg-1', entityType: 'change', stepName: 'review',
  execId: 'ex-1', enteredAt: '2026-09-10T10:00:00Z', deadline: JSON.stringify(REVIEW), previousOutcome: null, ...over,
})

function scriptReads(state: Record<string, unknown> | null = { currentStep: 'review', deadline: JSON.stringify(REVIEW), entity: { change_type: 'normal' } }) {
  runQueryOne
    .mockResolvedValueOnce({ id: 'ex-1' })
    .mockResolvedValueOnce(state)
    .mockResolvedValueOnce({ name: 'closed' })
}

const outcomeWrites = () => runQuery.mock.calls.filter((c) => String(c[1]).includes('deadline_outcome  = $outcome')).map((c) => c[2] as Record<string, unknown>)
const releaseWrites = () => runQuery.mock.calls.filter((c) => String(c[1]).includes("WHERE ex.deadline_outcome = 'running'")).map((c) => c[2] as Record<string, unknown>)

beforeEach(() => {
  vi.clearAllMocks()
  runQueryOne.mockReset()
  runQuery.mockReset()
  runQuery.mockResolvedValue([])
  checkTicketTransition.mockResolvedValue(null)
  transitionTicket.mockResolvedValue({ moved: true, actionErrors: [] })
  for (const k of Object.keys(calendarsById)) delete calendarsById[k]
})

describe('runStepDeadlineSweep', () => {
  it('a step whose deadline was cleared is ignored: no outcome written, nothing moved', async () => {
    runQuery.mockResolvedValueOnce([{ ...candidate({ deadline: '' }) }])
    const summary = await runStepDeadlineSweep('t1', NOW)
    expect(summary).toEqual({ candidates: 1, moved: 0, refused: 0, failed: 0, notDue: 0 })
    expect(outcomeWrites()).toEqual([])
    expect(runQueryOne).not.toHaveBeenCalled()
  })

  it('with a calendar: service hours in the tenant timezone, calendar and timezone fetched once per sweep', async () => {
    calendarsById['cal-1'] = { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00', holidays: [] }
    const withCal = JSON.stringify({ ...REVIEW, after: 4, unit: 'hours', calendar_id: 'cal-1' })
    // Entered Friday 18 Sep 16:00 Rome: 2 service hours on Friday, 2 more on Monday → due Monday 11:00 Rome,
    // so on Sunday 20 Sep it is NOT due (24×7 would have fired on Friday at 20:00).
    runQuery.mockResolvedValueOnce([
      candidate({ deadline: withCal, enteredAt: '2026-09-18T14:00:00Z' }),
      candidate({ deadline: withCal, enteredAt: '2026-09-18T14:00:00Z', execId: 'ex-2', entityId: 'chg-2' }),
    ])
    const summary = await runStepDeadlineSweep('t1', NOW)
    expect(summary).toMatchObject({ candidates: 2, notDue: 2, moved: 0, failed: 0 })
    expect(getServiceCalendarById).toHaveBeenCalledTimes(1)
    expect(getServiceCalendarById).toHaveBeenCalledWith('c-test', 'cal-1')
    expect(getTenantTimezone).toHaveBeenCalledTimes(1)
  })

  it('counts refused and failed deadlines in the summary', async () => {
    runQuery.mockResolvedValueOnce([
      candidate({ execId: 'ex-1' }),
      candidate({ execId: 'ex-2', entityId: 'chg-2' }),
    ])
    // First: the approval gate refuses. Second: the arc is gone → failed.
    checkTicketTransition.mockResolvedValueOnce(refusal('change_window'))
    runQueryOne
      .mockResolvedValueOnce({ id: 'ex-1' }).mockResolvedValueOnce({ currentStep: 'review', deadline: JSON.stringify(REVIEW), entity: {} }).mockResolvedValueOnce({ name: 'closed' })
      .mockResolvedValueOnce({ id: 'ex-2' }).mockResolvedValueOnce({ currentStep: 'review', deadline: JSON.stringify(REVIEW), entity: {} }).mockResolvedValueOnce(null)
    const summary = await runStepDeadlineSweep('t1', NOW)
    expect(summary).toEqual({ candidates: 2, moved: 0, refused: 1, failed: 1, notDue: 0 })
  })

  it('a stored deadline that is not valid JSON → failed (config), reported with the parser message', async () => {
    runQuery.mockResolvedValueOnce([candidate({ deadline: '{not json' })])
    const summary = await runStepDeadlineSweep('t1', NOW)
    expect(summary.failed).toBe(1)
    expect(outcomeWrites()[0]).toMatchObject({ outcome: 'failed', reason: 'config', detail: expect.stringContaining('not valid JSON') })
  })

  it('a non-Error rejection while reading the calendar is still recorded as text', async () => {
    runQuery.mockResolvedValueOnce([candidate({ deadline: JSON.stringify({ ...REVIEW, calendar_id: 'cal-x' }) })])
    getServiceCalendarById.mockRejectedValueOnce('calendar store offline')
    await runStepDeadlineSweep('t1', NOW)
    expect(outcomeWrites()[0]).toMatchObject({ reason: 'config', detail: 'calendar store offline' })
  })
})

describe('fireStepDeadline — skipped paths release the claim', () => {
  it('the ticket already left the step → skipped, claim released to the previous outcome', async () => {
    scriptReads({ currentStep: 'implement', deadline: JSON.stringify(REVIEW), entity: {} })
    await expect(fireStepDeadline(candidate({ previousOutcome: 'refused' }), NOW)).resolves.toBe('skipped')
    expect(releaseWrites()).toEqual([{ execId: 'ex-1', tenantId: 'c-test', previous: 'refused' }])
    expect(transitionTicket).not.toHaveBeenCalled()
  })

  it('the instance vanished → skipped', async () => {
    scriptReads(null)
    await expect(fireStepDeadline(candidate(), NOW)).resolves.toBe('skipped')
    expect(releaseWrites()).toHaveLength(1)
  })

  it('an entity type with no label is never moved; a stale "running" claim is released to null', async () => {
    scriptReads({ currentStep: 'review', deadline: JSON.stringify(REVIEW), entity: {} })
    await expect(fireStepDeadline(candidate({ entityType: 'task', previousOutcome: 'running' }), NOW)).resolves.toBe('skipped')
    // Releasing to "running" would leave the execution claimed until it goes stale: back to "never tried".
    expect(releaseWrites()).toEqual([{ execId: 'ex-1', tenantId: 'c-test', previous: null }])
    expect(transitionTicket).not.toHaveBeenCalled()
  })
})

describe('fireStepDeadline — field writes and the target step', () => {
  it('an incident publishes "ticket updated" for each field the deadline writes, as the automation actor', async () => {
    scriptReads({ currentStep: 'review', deadline: JSON.stringify(REVIEW), entity: {} })
    await expect(fireStepDeadline(candidate({ entityType: 'incident', entityId: 'inc-1' }), NOW)).resolves.toBe('moved')
    expect(publishTicketUpdated).toHaveBeenCalledWith(
      { tenantId: 'c-test', userId: 'automation' }, 'incident', 'inc-1', { outcome: null }, { outcome: 'successful' },
    )
  })

  it('a KB article writes its fields without publishing "ticket updated"', async () => {
    scriptReads({ currentStep: 'review', deadline: JSON.stringify(REVIEW), entity: {} })
    await expect(fireStepDeadline(candidate({ entityType: 'kb_article' }), NOW)).resolves.toBe('moved')
    expect(writeTicketField).toHaveBeenCalledTimes(1)
    expect(publishTicketUpdated).not.toHaveBeenCalled()
  })

  it('the written fields reach the pipeline, whose conditions must see them (it loads the assignee itself)', async () => {
    scriptReads({ currentStep: 'review', deadline: JSON.stringify(REVIEW), entity: { change_type: 'normal', outcome: null }, assignedTo: 'u-7', assignedTeam: null })
    await fireStepDeadline(candidate(), NOW)
    expect(transitionTicket).toHaveBeenCalledWith(session, expect.objectContaining({ extraEntityData: { outcome: 'successful' } }))
    // No callbacks travel any more: the step actions are the registered handlers (workflow/stepActions.ts).
    expect(Object.keys(transitionTicket.mock.calls[0]![1] as object).sort()).toEqual(['actor', 'extraEntityData', 'instanceId', 'tenantId', 'toStep', 'triggerType'])
  })

  it('moved with some target-step actions failed → still moved (the pipeline says it out loud)', async () => {
    scriptReads()
    transitionTicket.mockResolvedValue({ moved: true, actionErrors: ['notify: channel missing'] })
    await expect(fireStepDeadline(candidate(), NOW)).resolves.toBe('moved')
    expect(outcomeWrites().at(-1)).toMatchObject({ outcome: 'moved' })
  })

  it('the engine refusing the move is recorded as failed, with its message', async () => {
    scriptReads()
    transitionTicket.mockResolvedValue({ moved: false, refusal: refusal('workflow', 'The workflow refused the transition') })
    await expect(fireStepDeadline(candidate(), NOW)).resolves.toBe('failed')
    expect(outcomeWrites().at(-1)).toMatchObject({ reason: 'transition', detail: 'The workflow refused the transition' })
  })

  it('a guard that changed between the check and the move → refused with its reason', async () => {
    scriptReads()
    transitionTicket.mockResolvedValue({ moved: false, refusal: refusal('named_approval') })
    await expect(fireStepDeadline(candidate(), NOW)).resolves.toBe('refused')
    expect(outcomeWrites().at(-1)).toMatchObject({ outcome: 'refused', reason: 'approval_request' })
  })
})

describe('fireStepDeadline — unexpected errors and log levels', () => {
  it('an unexpected error becomes a retried "failed" (reason error), and the session is closed', async () => {
    runQueryOne.mockResolvedValueOnce({ id: 'ex-1' }).mockRejectedValueOnce(new Error('neo4j went away'))
    await expect(fireStepDeadline(candidate(), NOW)).resolves.toBe('failed')
    expect(outcomeWrites().at(-1)).toMatchObject({ outcome: 'failed', reason: 'error', detail: 'neo4j went away', retryAt: '2026-09-20T11:00:00.000Z' })
    expect(session.close).toHaveBeenCalled()
  })

  it('a non-Error throw is recorded as text; a field write failing with a non-Error too', async () => {
    runQueryOne.mockResolvedValueOnce({ id: 'ex-1' }).mockRejectedValueOnce('plain string')
    await fireStepDeadline(candidate(), NOW)
    expect(outcomeWrites().at(-1)).toMatchObject({ reason: 'error', detail: 'plain string' })

    scriptReads()
    writeTicketField.mockRejectedValueOnce('constraint')
    await fireStepDeadline(candidate(), NOW)
    expect(outcomeWrites().at(-1)).toMatchObject({ reason: 'field_write', detail: 'constraint' })
  })

  it('first refusal is a warning; the same refusal retried an hour later is only debug', async () => {
    scriptReads()
    checkTicketTransition.mockResolvedValue(refusal('change_window'))
    await fireStepDeadline(candidate({ previousOutcome: null }), NOW)
    expect(log.warn).toHaveBeenCalledTimes(1)

    vi.clearAllMocks()
    scriptReads()
    await fireStepDeadline(candidate({ previousOutcome: 'refused' }), NOW)
    expect(log.warn).not.toHaveBeenCalled()
    expect(log.debug).toHaveBeenCalledTimes(1)
  })

  it('first failure is an error; a repeated failure is only debug', async () => {
    runQueryOne.mockResolvedValueOnce({ id: 'ex-1' }).mockResolvedValueOnce({ currentStep: 'review', deadline: JSON.stringify(REVIEW), entity: {} }).mockResolvedValueOnce(null)
    await fireStepDeadline(candidate({ previousOutcome: 'refused' }), NOW)
    expect(log.error).toHaveBeenCalledTimes(1)

    vi.clearAllMocks()
    runQueryOne.mockResolvedValueOnce({ id: 'ex-1' }).mockResolvedValueOnce({ currentStep: 'review', deadline: JSON.stringify(REVIEW), entity: {} }).mockResolvedValueOnce(null)
    await fireStepDeadline(candidate({ previousOutcome: 'failed' }), NOW)
    expect(log.error).not.toHaveBeenCalled()
    expect(log.debug).toHaveBeenCalledTimes(1)
  })
})
