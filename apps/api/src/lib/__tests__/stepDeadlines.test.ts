/**
 * Verifica «Cosa resta cablato», ondata 3: lo scatto delle scadenze dei passi.
 *
 *  - quando scade: 24×7 o con un calendario (un giorno = una giornata di servizio);
 *  - chi la esegue la prende in carico, rilegge tutto, passa dal varco, valida i
 *    campi PRIMA di spostare, sposta come «step_deadline», poi imposta i campi;
 *  - l'esito resta sull'esecuzione del passo: moved, refused, failed.
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
vi.mock('@opengraphity/sla', async () => {
  const policy = await import('../../../../../packages/sla/src/policy.js')
  const calendar = await import('../../../../../packages/sla/src/calendar.js')
  return {
    calculateDeadline: policy.calculateDeadline,
    minutesOfDay: calendar.minutesOfDay,
    getServiceCalendarById: vi.fn(async (_t: string, id: string) => calendarsById[id]),
    getTenantTimezone: vi.fn(async () => 'Europe/Rome'),
  }
})

const transition = vi.fn()
vi.mock('@opengraphity/workflow', () => ({ workflowEngine: { transition: (...a: unknown[]) => transition(...a) } }))

const automaticTransitionAllowed = vi.fn(async () => true)
vi.mock('../../graphql/resolvers/change/windowGate.js', () => ({ automaticTransitionAllowed: (...a: unknown[]) => automaticTransitionAllowed(...a) }))
const requestApprovalWouldBeSkipped = vi.fn(async () => false)
vi.mock('../requestApproval.js', () => ({ requestApprovalWouldBeSkipped: (...a: unknown[]) => requestApprovalWouldBeSkipped(...a) }))

vi.mock('../stepFieldWrites.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  stepFieldMetas: vi.fn(async () => new Map([
    ['outcome', { name: 'outcome', fieldType: 'enum', enumValues: ['successful', 'failed'], enumTypeName: 'change_outcome' }],
  ])),
}))
const writeTicketField = vi.fn(async () => ({ before: {}, after: {} }))
vi.mock('../ticketFieldWrite.js', () => ({ writeTicketField: (...a: unknown[]) => writeTicketField(...a) }))
const publishTicketUpdated = vi.fn(async () => {})
vi.mock('../ticketUpdated.js', () => ({ publishTicketUpdated: (...a: unknown[]) => publishTicketUpdated(...a) }))
const audit = vi.fn(async () => {})
vi.mock('../audit.js', () => ({ audit: (...a: unknown[]) => audit(...a) }))
const outcomes = vi.fn()
vi.mock('../../middleware/metrics.js', () => ({ stepDeadlineOutcomesTotal: { inc: (...a: unknown[]) => outcomes(...a) } }))
vi.mock('../logger.js', () => ({ logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) } }))

const { stepDeadlineDueAt, fireStepDeadline, runStepDeadlineSweep } = await import('../stepDeadlines.js')

const REVIEW: StepDeadline = { after: 7, unit: 'days', calendar_id: null, to_step: 'closed', set_fields: [{ field: 'outcome', value: 'successful' }] }
const NOW = new Date('2026-09-20T10:00:00Z')

const candidate = (over: Partial<Parameters<typeof fireStepDeadline>[0]> = {}) => ({
  tenantId: 'c-test', instanceId: 'wi-1', entityId: 'chg-1', entityType: 'change', stepName: 'review',
  execId: 'ex-1', enteredAt: '2026-09-10T10:00:00Z', deadline: JSON.stringify(REVIEW), previousOutcome: null, ...over,
})

/** Le letture di `fireStepDeadline`, in ordine: presa in carico, stato, arco. */
function scriptReads({ claimed = true, state = { currentStep: 'review', deadline: JSON.stringify(REVIEW), entity: { change_type: 'normal' } } as Record<string, unknown> | null, arc = true } = {}) {
  runQueryOne
    .mockResolvedValueOnce(claimed ? { id: 'ex-1' } : null)
    .mockResolvedValueOnce(state)
    .mockResolvedValueOnce(arc ? { name: 'closed' } : null)
}

/** Le scritture dell'esito (`recordOutcome`): i parametri dell'ultima. */
const lastOutcome = () => {
  const call = runQuery.mock.calls.filter((c) => String(c[1]).includes('deadline_outcome  = $outcome')).at(-1)
  return call?.[2] as Record<string, unknown> | undefined
}

beforeEach(() => {
  vi.clearAllMocks()
  // Le risposte «una volta» che un test non consuma non devono finire nel successivo.
  runQueryOne.mockReset()
  runQuery.mockReset()
  runQuery.mockResolvedValue([])
  transition.mockResolvedValue({ success: true })
  automaticTransitionAllowed.mockResolvedValue(true)
  requestApprovalWouldBeSkipped.mockResolvedValue(false)
})

describe('stepDeadlineDueAt', () => {
  const entered = new Date('2026-09-14T07:30:00Z')   // lunedì 09:30 a Roma

  it('24×7: ore e giorni di orologio', () => {
    expect(stepDeadlineDueAt(entered, { ...REVIEW, after: 72, unit: 'hours' }, 'Europe/Rome', null).toISOString()).toBe('2026-09-17T07:30:00.000Z')
    expect(stepDeadlineDueAt(entered, { ...REVIEW, after: 7, unit: 'days' }, 'Europe/Rome', null).toISOString()).toBe('2026-09-21T07:30:00.000Z')
  })

  it('con un calendario: le ore sono di servizio, e un giorno è una giornata intera di servizio', () => {
    const cal = { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00', holidays: [] }
    // 4 ore di servizio da lunedì 09:30 → lunedì 13:30.
    expect(stepDeadlineDueAt(entered, { ...REVIEW, after: 4, unit: 'hours' }, 'Europe/Rome', cal).toISOString()).toBe('2026-09-14T11:30:00.000Z')
    // 2 giornate di servizio (18 ore) da lunedì 09:30 → mercoledì 09:30, non 4 giorni e mezzo.
    expect(stepDeadlineDueAt(entered, { ...REVIEW, after: 2, unit: 'days' }, 'Europe/Rome', cal).toISOString()).toBe('2026-09-16T07:30:00.000Z')
    // Venerdì 17:00 + 2 ore di servizio → lunedì 10:00: il fine settimana non conta.
    expect(stepDeadlineDueAt(new Date('2026-09-18T15:00:00Z'), { ...REVIEW, after: 2, unit: 'hours' }, 'Europe/Rome', cal).toISOString()).toBe('2026-09-21T08:00:00.000Z')
  })
})

describe('fireStepDeadline', () => {
  it('l\'esempio del proprietario: la change in review va a closed come «step_deadline» e riceve l\'esito', async () => {
    scriptReads()
    await expect(fireStepDeadline(candidate(), NOW)).resolves.toBe('moved')

    expect(automaticTransitionAllowed).toHaveBeenCalledWith(session, expect.objectContaining({ changeId: 'chg-1', changeType: 'normal', currentStep: 'review', toStep: 'closed' }), 'step_deadline')
    expect(transition).toHaveBeenCalledWith(session,
      { instanceId: 'wi-1', toStepName: 'closed', triggeredBy: 'step_deadline', triggerType: 'timer', tenantId: 'c-test' },
      expect.objectContaining({ userId: 'automation' }))
    expect(writeTicketField).toHaveBeenCalledWith(session, 'c-test', 'change', 'chg-1', 'outcome', 'successful')
    /**
     * CONTRATTO RINEGOZIATO (revisione totale · C-13): i campi si scrivono
     * PRIMA di spostare. Nell'ordine vecchio una scrittura fallita lasciava il
     * ticket già spostato e l'esito «failed» su un'esecuzione con `exited_at`:
     * mai ritentata, e invisibile nella diagnostica, che guarda solo le
     * esecuzioni aperte. Restava un log.
     */
    expect(writeTicketField.mock.invocationCallOrder[0]!).toBeLessThan(transition.mock.invocationCallOrder[0]!)
    expect(lastOutcome()).toMatchObject({ outcome: 'moved', toStep: 'closed', retryAt: null })
    // Dal vivo: senza `userEmail` la scrittura dell'audit falliva (parametro mancante) e la voce spariva.
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'c-test', userId: 'automation', userEmail: 'automation' }), 'workflow.step_deadline_moved', 'Change', 'chg-1', expect.objectContaining({ fromStep: 'review', toStep: 'closed' }))
  })

  it('già presa da un\'altra passata (o il ticket è uscito dal passo) → non fa nulla', async () => {
    scriptReads({ claimed: false })
    await expect(fireStepDeadline(candidate(), NOW)).resolves.toBe('skipped')
    expect(transition).not.toHaveBeenCalled()
  })

  it('la scadenza è stata tolta mentre la passata girava → rilascia la presa, nessuno spostamento', async () => {
    scriptReads({ state: { currentStep: 'review', deadline: null, entity: {} } })
    await expect(fireStepDeadline(candidate(), NOW)).resolves.toBe('skipped')
    expect(transition).not.toHaveBeenCalled()
    expect(runQuery.mock.calls.some((c) => String(c[1]).includes("WHERE ex.deadline_outcome = 'running'"))).toBe(true)
  })

  it('il passo di arrivo si legge ADESSO: la scadenza cambiata vale', async () => {
    const changed = { ...REVIEW, to_step: 'cancelled', set_fields: [] }
    runQueryOne
      .mockResolvedValueOnce({ id: 'ex-1' })
      .mockResolvedValueOnce({ currentStep: 'review', deadline: JSON.stringify(changed), entity: { change_type: 'normal' } })
      .mockResolvedValueOnce({ name: 'cancelled' })
    await fireStepDeadline(candidate(), NOW)
    expect(transition).toHaveBeenCalledWith(session, expect.objectContaining({ toStepName: 'cancelled' }), expect.anything())
  })

  it('senza più l\'arco → failed, con la ragione; si riprova fra un\'ora', async () => {
    scriptReads({ arc: false })
    await expect(fireStepDeadline(candidate(), NOW)).resolves.toBe('failed')
    expect(lastOutcome()).toMatchObject({ outcome: 'failed', reason: 'no_arc', retryAt: '2026-09-20T11:00:00.000Z' })
    expect(transition).not.toHaveBeenCalled()
  })

  it('il varco rifiuta → refused, la change resta dov\'è', async () => {
    scriptReads()
    automaticTransitionAllowed.mockResolvedValue(false)
    await expect(fireStepDeadline(candidate(), NOW)).resolves.toBe('refused')
    expect(lastOutcome()).toMatchObject({ outcome: 'refused', reason: 'approval_gate' })
    expect(transition).not.toHaveBeenCalled()
    expect(outcomes).toHaveBeenCalledWith({ outcome: 'refused', reason: 'approval_gate' })
  })

  it('una richiesta che salterebbe l\'approvazione → refused', async () => {
    scriptReads()
    requestApprovalWouldBeSkipped.mockResolvedValue(true)
    await expect(fireStepDeadline(candidate({ entityType: 'service_request' }), NOW)).resolves.toBe('refused')
    expect(lastOutcome()).toMatchObject({ reason: 'request_approval' })
  })

  it('un valore uscito dal vocabolario → failed PRIMA di spostare', async () => {
    const bad = { ...REVIEW, set_fields: [{ field: 'outcome', value: 'riuscita' }] }
    runQueryOne
      .mockResolvedValueOnce({ id: 'ex-1' })
      .mockResolvedValueOnce({ currentStep: 'review', deadline: JSON.stringify(bad), entity: { change_type: 'normal' } })
      .mockResolvedValueOnce({ name: 'closed' })
    await expect(fireStepDeadline(candidate({ deadline: JSON.stringify(bad) }), NOW)).resolves.toBe('failed')
    expect(lastOutcome()).toMatchObject({ outcome: 'failed', reason: 'field' })
    expect(transition).not.toHaveBeenCalled()
    expect(writeTicketField).not.toHaveBeenCalled()
  })

  it('il motore rifiuta la transizione → failed con il suo errore; i campi erano già scritti (C-13)', async () => {
    scriptReads()
    transition.mockResolvedValue({ success: false, error: 'condition not met' })
    await expect(fireStepDeadline(candidate(), NOW)).resolves.toBe('failed')
    expect(lastOutcome()).toMatchObject({ reason: 'transition', detail: 'condition not met' })
    // I campi sono già scritti: il ticket non si è mosso, l'esecuzione è
    // ancora aperta, e la passata dopo un'ora riprova con gli stessi valori.
    expect(writeTicketField).toHaveBeenCalledTimes(1)
  })

  /**
   * C-13: una scrittura dei campi che falisce lascia il ticket DOV'ERA, con
   * l'esito «failed» su un'esecuzione ancora aperta — quindi visibile nella
   * diagnostica e ritentata.
   */
  it('la scrittura dei campi che fallisce non sposta il ticket, e l\'esito è ritentabile (C-13)', async () => {
    scriptReads()
    writeTicketField.mockRejectedValueOnce(new Error('vincolo violato'))
    await expect(fireStepDeadline(candidate(), NOW)).resolves.toBe('failed')
    expect(transition).not.toHaveBeenCalled()
    expect(lastOutcome()).toMatchObject({ reason: 'field_write', detail: 'vincolo violato' })
    expect(lastOutcome()!['retryAt']).not.toBeNull()
  })
})

describe('runStepDeadlineSweep', () => {
  it('sposta solo i ticket scaduti', async () => {
    runQuery.mockResolvedValueOnce([
      { ...candidate(), previousOutcome: null },                                             // entrato il 10: 7 giorni passati
      { ...candidate({ execId: 'ex-2', entityId: 'chg-2', enteredAt: '2026-09-19T10:00:00Z' }), previousOutcome: null }, // entrato ieri
    ])
    scriptReads()
    const summary = await runStepDeadlineSweep(NOW)
    expect(summary).toMatchObject({ candidates: 2, moved: 1, notDue: 1 })
    expect(transition).toHaveBeenCalledTimes(1)
  })

  it('un calendario che non si trova → failed, e la passata continua', async () => {
    runQuery.mockResolvedValueOnce([
      { ...candidate({ deadline: JSON.stringify({ ...REVIEW, calendar_id: 'cal-sparito' }) }), previousOutcome: null },
    ])
    const { getServiceCalendarById } = await import('@opengraphity/sla')
    vi.mocked(getServiceCalendarById).mockRejectedValueOnce(new Error('Service calendar cal-sparito does not exist'))
    const summary = await runStepDeadlineSweep(NOW)
    expect(summary).toMatchObject({ failed: 1, moved: 0 })
    expect(lastOutcome()).toMatchObject({ outcome: 'failed', reason: 'config' })
  })
})
