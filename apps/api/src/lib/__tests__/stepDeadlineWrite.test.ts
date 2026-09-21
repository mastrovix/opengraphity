/**
 * Verifica «Cosa resta cablato», ondata 3: una scadenza di passo si salva solo
 * se ha senso nel suo workflow. La regola del proprietario: una scadenza verso
 * un passo protetto dalle approvazioni NON si può salvare — e il controllo sta
 * nell'API, non solo nella pagina.
 */
import { describe, it, expect, vi } from 'vitest'
import { GraphQLError } from 'graphql'

vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn() }))

const { assertDefinitionDeadlines, normalizeStepDeadlineInput } = await import('../stepDeadlineWrite.js')

interface StepRow { name: string; label?: string; purpose?: string | null; deadline?: object | null; targets?: string[] }

/** Una transazione finta: la prima lettura è la definizione, la seconda (se c'è) il calendario. */
function fakeTx(entityType: string, steps: StepRow[], calendars: string[] = []) {
  return {
    run: vi.fn(async (cypher: string, params: Record<string, unknown>) => {
      if (cypher.includes('ServiceCalendar')) {
        return { records: calendars.includes(String(params['id'])) ? [{ get: () => 'Turno NOC' }] : [] }
      }
      return {
        records: steps.map((s) => {
          const row: Record<string, unknown> = {
            entityType, definitionName: 'Change RFC', name: s.name, label: s.label ?? s.name, purpose: s.purpose ?? null,
            deadline: s.deadline ? JSON.stringify(s.deadline) : null, targets: s.targets ?? [],
          }
          return { get: (k: string) => row[k] }
        }),
      }
    }),
  }
}

const deadline = (to_step: string, extra: object = {}) => ({ after: 7, unit: 'days', calendar_id: null, to_step, set_fields: [], ...extra })

const failure = async (p: Promise<unknown>): Promise<GraphQLError> => {
  const e = await p.then(() => null, (err: unknown) => err)
  expect(e).toBeInstanceOf(GraphQLError)
  return e as GraphQLError
}
const keyOf = (e: GraphQLError) => (e.extensions['i18n'] as { key: string }).key

describe('normalizeStepDeadlineInput — la convenzione dello scopo', () => {
  it('assente = invariata, vuota = tolta, altrimenti valida e normalizzata', () => {
    expect(normalizeStepDeadlineInput(undefined, 'x')).toEqual({ given: false, deadline: null })
    expect(normalizeStepDeadlineInput('', 'x')).toEqual({ given: true, deadline: null })
    expect(normalizeStepDeadlineInput(JSON.stringify({ after: 7, unit: 'days', to_step: ' closed ' }), 'x').deadline)
      .toEqual({ after: 7, unit: 'days', calendar_id: null, to_step: 'closed', set_fields: [] })
  })

  it('una forma sbagliata è rifiutata con la chiave del problema', () => {
    const e = (() => { try { normalizeStepDeadlineInput(JSON.stringify({ after: 0, unit: 'days', to_step: 'closed' }), 'deadline of step "review"') } catch (err) { return err as GraphQLError } })()
    expect(keyOf(e!)).toBe('errors.stepDeadline.after')
    const u = (() => { try { normalizeStepDeadlineInput(JSON.stringify({ after: 3, unit: 'weeks', to_step: 'closed' }), 'x') } catch (err) { return err as GraphQLError } })()
    expect(keyOf(u!)).toBe('errors.stepDeadline.unit')
  })
})

describe('assertDefinitionDeadlines', () => {
  it('l\'esempio del proprietario: change in review da 7 giorni → closed, si salva', async () => {
    const tx = fakeTx('change', [
      { name: 'review', purpose: 'review', deadline: deadline('closed', { set_fields: [{ field: 'outcome', value: 'successful' }] }), targets: ['closed'] },
      { name: 'closed' },
    ])
    await expect(assertDefinitionDeadlines(tx as never, 'c-test', 'def-1')).resolves.toBeUndefined()
  })

  it('senza un arco verso il passo di arrivo è rifiutata: una scadenza segue un arco', async () => {
    const tx = fakeTx('incident', [{ name: 'resolved', deadline: deadline('closed'), targets: ['in_progress'] }, { name: 'closed' }, { name: 'in_progress' }])
    const e = await failure(assertDefinitionDeadlines(tx as never, 'c-test', 'def-1'))
    expect(keyOf(e)).toBe('errors.stepDeadline.noArc')
  })

  it.each(['approval', 'scheduled', 'implementation'])('change verso un passo di scopo «%s» → rifiutata', async (purpose) => {
    const tx = fakeTx('change', [
      { name: 'planning', purpose: 'planning', deadline: deadline('target'), targets: ['target'] },
      { name: 'target', label: 'Programmata', purpose },
    ])
    const e = await failure(assertDefinitionDeadlines(tx as never, 'c-test', 'def-1'))
    expect(keyOf(e)).toBe('errors.stepDeadline.protectedTarget')
    expect(e.message).toContain('Programmata')
  })

  it('change che esce dal passo di approvazione → rifiutata', async () => {
    const tx = fakeTx('change', [
      { name: 'approval', purpose: 'approval', deadline: deadline('cancelled'), targets: ['cancelled'] },
      { name: 'cancelled' },
    ])
    expect(keyOf(await failure(assertDefinitionDeadlines(tx as never, 'c-test', 'def-1')))).toBe('errors.stepDeadline.protectedSource')
  })

  it('il varco è delle change: una richiesta verso un passo di approvazione si salva', async () => {
    const tx = fakeTx('service_request', [
      { name: 'new', deadline: deadline('awaiting_approval', { unit: 'hours', after: 4 }), targets: ['awaiting_approval'] },
      { name: 'awaiting_approval', purpose: 'approval' },
    ])
    await expect(assertDefinitionDeadlines(tx as never, 'c-test', 'def-1')).resolves.toBeUndefined()
  })

  it('verso lo stesso passo non ha senso', async () => {
    const tx = fakeTx('incident', [{ name: 'pending', deadline: deadline('pending'), targets: ['pending'] }])
    expect(keyOf(await failure(assertDefinitionDeadlines(tx as never, 'c-test', 'def-1')))).toBe('errors.stepDeadline.sameStep')
  })

  it('un calendario che non esiste più è rifiutato; uno che esiste passa', async () => {
    const steps = [{ name: 'pending', deadline: deadline('in_progress', { calendar_id: 'cal-9' }), targets: ['in_progress'] }, { name: 'in_progress' }]
    expect(keyOf(await failure(assertDefinitionDeadlines(fakeTx('incident', steps) as never, 'c-test', 'def-1')))).toBe('errors.stepDeadline.calendarMissing')
    await expect(assertDefinitionDeadlines(fakeTx('incident', steps, ['cal-9']) as never, 'c-test', 'def-1')).resolves.toBeUndefined()
  })

  it('una scadenza corrotta nel grafo ferma la scrittura, invece di passare inosservata', async () => {
    const tx = fakeTx('incident', [{ name: 'pending', targets: [] }])
    tx.run.mockResolvedValueOnce({ records: [{ get: (k: string) => ({ entityType: 'incident', name: 'pending', label: 'pending', purpose: null, deadline: '{rotto', targets: [] } as Record<string, unknown>)[k] }] })
    expect(keyOf(await failure(assertDefinitionDeadlines(tx as never, 'c-test', 'def-1')))).toBe('errors.stepDeadline.invalid_json')
  })
})
