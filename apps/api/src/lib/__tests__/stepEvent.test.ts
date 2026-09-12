/**
 * Personalizzazioni, ondata 4 — B4-1 (D-22): l'identità dell'evento e
 * dell'azione di audit non è più il NOME del passo.
 *
 * - il tipo stabile `<entità>.step_entered` e l'alias storico convivono, e il
 *   nome del passo vive nel payload con etichetta, scopo e categoria;
 * - `workflowEventTypes` elenca i tipi VERI del tenant (era impossibile
 *   abbonare un webhook al proprio passo: `OUTBOUND_EVENTS` erano sei costanti
 *   e nessuna era un passo intermedio);
 * - l'azione di audit è stabile, con il passo nei dettagli e il vecchio nome
 *   in `legacy_action`: le voci storiche NON si riscrivono.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  stepEnteredEventType, legacyStepEventType, isStepEnteredEventType, stepEnteredEntityType,
} from '@opengraphity/types'
import type { GraphQLContext } from '../../context.js'

const runQuery    = vi.fn()
const runQueryOne = vi.fn()
const audit       = vi.fn().mockResolvedValue(undefined)

vi.mock('@opengraphity/neo4j', () => ({ runQuery, runQueryOne }))
vi.mock('../audit.js', () => ({ audit }))
vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const { loadStepFacts, workflowEventTypeRows, auditStepEntered } = await import('../stepEvent.js')
const { logger } = await import('../logger.js')

const session = {} as never
const ctx: GraphQLContext = { tenantId: 'c-two', userId: 'u1', userEmail: 'u@test.io', role: 'admin' }

beforeEach(() => vi.clearAllMocks())

describe('il contratto dei tipi (packages/types)', () => {
  it('il tipo stabile non contiene il nome del passo, l\'alias sì', () => {
    expect(stepEnteredEventType('incident')).toBe('incident.step_entered')
    expect(legacyStepEventType('incident', 'in_attesa_fornitore')).toBe('incident.in_attesa_fornitore')
    expect(isStepEnteredEventType('incident.step_entered')).toBe(true)
    expect(isStepEnteredEventType('incident.in_progress')).toBe(false)
    expect(stepEnteredEntityType('problem.step_entered')).toBe('problem')
    expect(stepEnteredEntityType('incident.created')).toBeNull()
  })
})

describe('loadStepFacts — i fatti del passo, o un errore che li nomina', () => {
  it('etichetta, scopo e categoria del passo rinominato dal cliente', async () => {
    runQueryOne.mockResolvedValue({ stepId: 'st-9', label: 'CAB settimanale', purpose: 'approval', category: 'waiting' })
    expect(await loadStepFacts(session, 'c-two', 'change', 'cab_settimanale')).toEqual({
      step_id: 'st-9', step_name: 'cab_settimanale', step_label: 'CAB settimanale',
      step_purpose: 'approval', step_category: 'waiting',
    })
  })

  it('scopo non dichiarato → null, non indovinato dal nome', async () => {
    runQueryOne.mockResolvedValue({ stepId: 'st-1', label: 'Rilascio', purpose: null, category: 'active' })
    const facts = await loadStepFacts(session, 'c-two', 'change', 'deployment')
    expect(facts.step_purpose).toBeNull()
  })

  it('etichetta assente → il nome del passo (non una stringa vuota)', async () => {
    runQueryOne.mockResolvedValue({ stepId: 'st-1', label: null, purpose: null, category: null })
    expect((await loadStepFacts(session, 'c-two', 'change', 'x')).step_label).toBe('x')
  })

  it('passo inesistente nel workflow attivo → FAIL-LOUD con tenant, entità e passo', async () => {
    runQueryOne.mockResolvedValue(null)
    await expect(loadStepFacts(session, 'c-two', 'change', 'fantasma'))
      .rejects.toThrow(/c-two.*"fantasma".*"change"/s)
  })
})

describe('workflowEventTypeRows — i tipi di evento VERI del tenant', () => {
  it('un tipo stabile per entità più un alias per passo, con l\'etichetta', async () => {
    runQuery.mockResolvedValue([
      { entityType: 'incident', stepName: 'new',        label: 'Nuovo',     purpose: null,        category: 'active',  stepOrder: 1 },
      { entityType: 'incident', stepName: 'in_attesa',  label: 'In attesa', purpose: null,        category: 'waiting', stepOrder: 2 },
      { entityType: 'change',   stepName: 'cab',        label: 'CAB',       purpose: 'approval',  category: 'waiting', stepOrder: 1 },
    ])
    const rows = await workflowEventTypeRows(session, 'c-two')
    expect(rows.filter((r) => r.stable).map((r) => r.eventType)).toEqual(['incident.step_entered', 'change.step_entered'])
    const waiting = rows.find((r) => r.eventType === 'incident.in_attesa')!
    expect(waiting).toMatchObject({ stepName: 'in_attesa', stepLabel: 'In attesa', stepCategory: 'waiting', stable: false })
    expect(rows.find((r) => r.eventType === 'change.cab')!.stepPurpose).toBe('approval')
  })

  it('due definizioni attive con lo stesso nome di passo → un tipo solo', async () => {
    runQuery.mockResolvedValue([
      { entityType: 'incident', stepName: 'resolved', label: 'Risolto', purpose: null, category: 'resolved', stepOrder: 9 },
      { entityType: 'incident', stepName: 'resolved', label: 'Risolto', purpose: null, category: 'resolved', stepOrder: 9 },
    ])
    const rows = await workflowEventTypeRows(session, 'c-two')
    expect(rows.map((r) => r.eventType)).toEqual(['incident.step_entered', 'incident.resolved'])
  })

  it('nessun workflow → nessun tipo (e nessun tipo inventato)', async () => {
    runQuery.mockResolvedValue([])
    expect(await workflowEventTypeRows(session, 'c-two')).toEqual([])
  })
})

describe('auditStepEntered — azione stabile, passo nei dettagli, storia non riscritta', () => {
  it('l\'azione NON contiene il nome del passo; il vecchio nome sta in legacy_action', async () => {
    runQueryOne.mockResolvedValue({ stepId: 'st-3', label: 'In lavorazione', purpose: 'investigation', category: 'active' })
    await auditStepEntered(session, ctx, 'incident', 'Incident', 'inc-1', 'in_progress')

    expect(audit).toHaveBeenCalledWith(ctx, 'incident.step_entered', 'Incident', 'inc-1', {
      step_id: 'st-3', step_name: 'in_progress', step_label: 'In lavorazione',
      step_purpose: 'investigation', step_category: 'active',
      legacy_action: 'incident.in_progress',
    })
  })

  it('una rinomina del passo non cambia l\'azione, solo i dettagli', async () => {
    runQueryOne.mockResolvedValue({ stepId: 'st-3', label: 'Lavorazione', purpose: 'investigation', category: 'active' })
    await auditStepEntered(session, ctx, 'incident', 'Incident', 'inc-1', 'lavorazione')
    expect(audit.mock.calls[0]![1]).toBe('incident.step_entered')
    expect((audit.mock.calls[0]![4] as Record<string, unknown>)['step_name']).toBe('lavorazione')
  })

  it('fatti del passo illeggibili → la voce si scrive comunque, e il motivo va nei log', async () => {
    runQueryOne.mockResolvedValue(null)
    await auditStepEntered(session, ctx, 'problem', 'Problem', 'prb-1', 'fantasma')

    expect(audit).toHaveBeenCalledWith(ctx, 'problem.step_entered', 'Problem', 'prb-1', {
      step_name: 'fantasma', legacy_action: 'problem.fantasma',
    })
    expect(logger.warn).toHaveBeenCalled()
  })
})
