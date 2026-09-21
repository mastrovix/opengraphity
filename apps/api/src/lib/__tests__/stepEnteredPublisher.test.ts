/**
 * Revisione totale · C-1: gli eventi di dominio dell'ingresso in un passo (il
 * tipo stabile `<entità>.step_entered` e l'alias storico `<entità>.<passo>`,
 * quelli a cui sono agganciate le regole di notifica e i webhook in uscita) li
 * pubblicavano SOLO la transizione manuale dell'incident e quella del problem.
 * Ogni cammino automatico — l'azione `transition_workflow` di regole e
 * trigger, la scadenza di un passo, il job `timer_wait`, la change che risolve
 * il problem, la riapertura dal portale — muoveva il ticket senza che partisse
 * nulla, e senza un errore.
 *
 * Qui si pinna il contratto del publisher condiviso, che l'hook del motore
 * chiama per ogni transizione di qualunque cammino.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const runQueryOne = vi.fn()
const close = vi.fn()
vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(() => ({ close })),
  runQueryOne: (...a: unknown[]) => runQueryOne(...a),
  runQuery: vi.fn(async () => []),
}))
const publishEvent = vi.fn()
vi.mock('../publishEvent.js', () => ({ publishEvent: (...a: unknown[]) => publishEvent(...a) }))
const loadStepFacts = vi.fn()
vi.mock('../stepEvent.js', () => ({ loadStepFacts: (...a: unknown[]) => loadStepFacts(...a) }))
const warn = vi.fn()
vi.mock('../logger.js', () => ({ logger: { child: () => ({ warn, info: vi.fn(), error: vi.fn() }) } }))

const { publishStepEnteredForEntity } = await import('../stepEnteredPublisher.js')

const FACTS = { step_id: 'st-7', step_name: 'in_attesa_fornitore', step_label: 'In attesa del fornitore', step_purpose: null, step_category: 'waiting' }
const info = (over: Record<string, unknown> = {}) => ({
  tenantId: 'tenant-1', actorId: 'user-1', entityType: 'incident', entityId: 'inc-1',
  stepName: 'in_attesa_fornitore', enteredAt: '2026-09-16T10:00:00.000Z', ...over,
}) as Parameters<typeof publishStepEnteredForEntity>[0]

beforeEach(() => {
  vi.clearAllMocks()
  loadStepFacts.mockResolvedValue(FACTS)
  runQueryOne.mockResolvedValue({
    id: 'inc-1', number: 'INC00000012', title: 'DB down', severity: 'critical', priority: 'critical',
    status: 'in_attesa_fornitore', ciName: 'srv-1', assignedTo: 'Mario',
  })
})

describe('publishStepEnteredForEntity', () => {
  it('pubblica il tipo stabile E l\'alias del passo, stesso payload e stesso istante', async () => {
    await publishStepEnteredForEntity(info())
    const types = publishEvent.mock.calls.map((c) => c[0])
    expect(types).toEqual(['incident.step_entered', 'incident.in_attesa_fornitore'])
    for (const call of publishEvent.mock.calls) {
      expect(call[1]).toBe('tenant-1')
      expect(call[2]).toBe('user-1')
      expect(call[3]).toMatchObject({
        id: 'inc-1', number: 'INC00000012', title: 'DB down', severity: 'critical',
        ciName: 'srv-1', assignedTo: 'Mario', ...FACTS,
      })
      expect(call[4]).toBe('2026-09-16T10:00:00.000Z')
    }
  })

  it('la lettura del ticket è tenant-scoped e usa l\'etichetta del tipo', async () => {
    await publishStepEnteredForEntity(info({ entityType: 'problem', entityId: 'prb-1', stepName: 'in_progress' }))
    const [, cypher, params] = runQueryOne.mock.calls[0] as [unknown, string, Record<string, unknown>]
    expect(cypher).toContain('MATCH (e:Problem {id: $entityId, tenant_id: $tenantId})')
    expect(params).toEqual({ entityId: 'prb-1', tenantId: 'tenant-1' })
    // Per un problem la gravità è la sua priorità, spedita come `severity`
    // (è il campo che i consumatori leggono) e anche come `priority`.
    expect(cypher).toContain("coalesce(e.priority, 'medium') AS severity")
    expect(publishEvent.mock.calls.map((c) => c[0])).toEqual(['problem.step_entered', 'problem.in_progress'])
  })

  it('un passo che non esiste nel workflow attivo ferma l\'evento invece di inventarne i fatti', async () => {
    loadStepFacts.mockRejectedValueOnce(new Error('step "fantasma" does not exist'))
    await expect(publishStepEnteredForEntity(info({ stepName: 'fantasma' }))).rejects.toThrow(/fantasma/)
    expect(publishEvent).not.toHaveBeenCalled()
  })

  it('ticket non più nel grafo: nessun evento, ma un warn (non un silenzio)', async () => {
    runQueryOne.mockResolvedValueOnce(null)
    await publishStepEnteredForEntity(info())
    expect(publishEvent).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('entità senza ticket nel grafo (es. un workflow di un\'altra cosa): nessun evento e nessuna lettura', async () => {
    await publishStepEnteredForEntity(info({ entityType: 'qualcosa_altro' }))
    expect(runQueryOne).not.toHaveBeenCalled()
    expect(publishEvent).not.toHaveBeenCalled()
  })

  it('la sessione viene chiusa a ogni lettura, anche quando i fatti del passo falliscono', async () => {
    loadStepFacts.mockRejectedValueOnce(new Error('boom'))
    await publishStepEnteredForEntity(info()).catch(() => null)
    expect(close).toHaveBeenCalledTimes(2)
  })
})
