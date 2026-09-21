/**
 * Cancellare un tipo di CI — la regola del proprietario (15 set 2026).
 *
 * Dal vivo su c-test: un tipo creato un attimo prima, senza CI e senza usi,
 * non si cancellava, perché `createCIType` gli collega le domande core
 * dell'assessment e il vecchio controllo le contava come riferimenti. Ora il
 * solo impedimento è un ticket (anche chiuso) che cita un CI del tipo; CI e
 * riferimenti vanno via con lui, nella stessa transazione.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@opengraphity/neo4j', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@opengraphity/neo4j')>()
  return { ...orig, runQueryOne: vi.fn() }
})

const {
  loadCITypeDeletionImpact, assertCITypeNotInTickets, assertCITypeHasNoCIsToHide, deleteCITypeDependents,
  CI_TYPE_DELETION_IMPACT_CYPHER, DELETE_TYPE_CIS_CYPHER, UPDATE_GROUPS_CYPHER, DELETE_TYPE_REFERENCES_CYPHER,
} = await import('../ciTypeDeletion.js')
const { runQueryOne } = await import('@opengraphity/neo4j')

const TYPE = { id: 'ct-1', name: 'firewall', label: 'Firewall', neo4jLabel: 'Firewall' }
const ZERO = { cis: 0, ticketCIs: 0, tickets: 0, ticketCIExclusions: 0, groupsUpdated: 0, groupsDeleted: 0, fieldVisibilityRules: 0, fieldRequirementRules: 0, businessRules: 0, autoTriggers: 0, customWidgets: 0, reportSections: 0, assessmentQuestionLinks: 0 }
const tx = {} as never

function route(rows: { impact: Record<string, unknown>; cis?: unknown; groups?: unknown; refs?: unknown }) {
  vi.mocked(runQueryOne).mockImplementation((async (_s: unknown, cypher: string) => {
    if (cypher === CI_TYPE_DELETION_IMPACT_CYPHER) return rows.impact
    if (cypher === DELETE_TYPE_CIS_CYPHER) return rows.cis ?? null
    if (cypher === UPDATE_GROUPS_CYPHER) return rows.groups ?? null
    if (cypher === DELETE_TYPE_REFERENCES_CYPHER) return rows.refs ?? { ticketCIExclusions: 0, fieldVisibilityRules: 0, fieldRequirementRules: 0, businessRules: 0, autoTriggers: 0, customWidgets: 0, reportSections: 0 }
    throw new Error(`unexpected cypher: ${cypher}`)
  }) as never)
}

beforeEach(() => { vi.clearAllMocks() })

describe('le query', () => {
  it('nome ed etichetta sono parametri, mai interpolati; i ticket sono i quattro tipi con le loro relazioni verso i CI, anche chiusi', () => {
    for (const c of [CI_TYPE_DELETION_IMPACT_CYPHER, DELETE_TYPE_CIS_CYPHER, UPDATE_GROUPS_CYPHER, DELETE_TYPE_REFERENCES_CYPHER]) {
      expect(c).not.toContain('firewall')
      expect(c).toContain('$tenantId')
    }
    expect(CI_TYPE_DELETION_IMPACT_CYPHER).toContain('[:AFFECTED_BY|AFFECTS|AFFECTS_CI|CONCERNS_CI]')
    expect(CI_TYPE_DELETION_IMPACT_CYPHER).toContain('t:Incident OR t:Problem OR t:Change OR t:ServiceRequest')
    // nessun filtro sullo stato del ticket: vale anche lo storico
    expect(CI_TYPE_DELETION_IMPACT_CYPHER).not.toMatch(/current_step|status/)
  })

  it('un gruppo dinamico che aveva SOLO quel tipo si cancella (senza tipi varrebbe per tutti i CI); gli altri perdono solo quel tipo', () => {
    expect(UPDATE_GROUPS_CYPHER).toContain("trim(x) <> $name")
    expect(UPDATE_GROUPS_CYPHER).toContain('CASE WHEN size(rest) = 0 THEN g END')
    expect(UPDATE_GROUPS_CYPHER).toContain('DETACH DELETE x')
    // i gruppi che sparirebbero contano anche per i ticket
    expect(CI_TYPE_DELETION_IMPACT_CYPHER).toContain('typeCIs + onlyThisType AS doomed')
  })

  it('una sezione di report con un nodo del tipo va via intera (senza quel nodo sarebbe una query spezzata); le domande di assessment restano', () => {
    expect(DELETE_TYPE_REFERENCES_CYPHER).toContain('FOREACH (y IN ss | DETACH DELETE y)')
    expect(DELETE_TYPE_REFERENCES_CYPHER).not.toContain('AssessmentQuestion')
  })
})

describe('impedimenti', () => {
  it('ticket → rifiuto con chiave e numeri, per cancellare e per disattivare', () => {
    const impact = { ...ZERO, ticketCIs: 3, tickets: 5 }
    expect(() => assertCITypeNotInTickets(impact, TYPE, 'delete')).toThrow(/3 of its CIs are linked to 5 ticket/)
    try { assertCITypeNotInTickets(impact, TYPE, 'deactivate') } catch (e) {
      expect((e as { extensions: Record<string, unknown> }).extensions['i18n']).toEqual({ key: 'errors.ciType.inTicketsDeactivate', params: { label: 'Firewall', name: 'firewall', cis: 3, tickets: 5 } })
    }
    expect(() => assertCITypeNotInTickets({ ...ZERO, cis: 40, customWidgets: 2, assessmentQuestionLinks: 9 }, TYPE, 'delete')).not.toThrow()
  })

  it('disattivare con CI → rifiuto (sparirebbero dalle letture)', () => {
    expect(() => assertCITypeHasNoCIsToHide({ ...ZERO, cis: 7 }, TYPE)).toThrow(/7 CIs of type Firewall/)
    expect(() => assertCITypeHasNoCIsToHide({ ...ZERO, businessRules: 3 }, TYPE)).not.toThrow()
  })

  it('un conteggio non numerico è un errore, mai uno zero di comodo', async () => {
    route({ impact: { ...ZERO, cis: null } })
    await expect(loadCITypeDeletionImpact(tx, 't1', 'ct-1', 'firewall', 'Firewall')).rejects.toThrow(/non-numeric count cis/)
  })
})

describe('deleteCITypeDependents', () => {
  it('tipo appena creato: nulla da togliere oltre ai collegamenti alle domande, nessun errore', async () => {
    route({ impact: { ...ZERO, assessmentQuestionLinks: 2 } })
    await expect(deleteCITypeDependents(tx, 't1', TYPE)).resolves.toEqual({ impact: { ...ZERO, assessmentQuestionLinks: 2 }, deletedCIIds: [] })
  })

  it('CI, gruppi e riferimenti: cancellati nella transazione del chiamante, restituisce gli id per le mappe', async () => {
    route({
      impact: { ...ZERO, cis: 2, groupsDeleted: 1, groupsUpdated: 1, ticketCIExclusions: 1, reportSections: 1 },
      cis: { ids: ['ci-1', 'ci-2'] }, groups: { updated: 1, deletedIds: ['grp-1'] },
      refs: { ticketCIExclusions: 1, fieldVisibilityRules: 0, fieldRequirementRules: 0, businessRules: 0, autoTriggers: 0, customWidgets: 0, reportSections: 1 },
    })
    const out = await deleteCITypeDependents(tx, 't1', TYPE)
    expect(out.deletedCIIds).toEqual(['ci-1', 'ci-2', 'grp-1'])
    for (const [, , params] of vi.mocked(runQueryOne).mock.calls) expect(params).toEqual({ tenantId: 't1', typeId: 'ct-1', name: 'firewall', label: 'Firewall' })
    expect(vi.mocked(runQueryOne).mock.calls.every(([s]) => s === tx)).toBe(true)
  })

  it('in un ticket → rifiuto PRIMA di scrivere', async () => {
    route({ impact: { ...ZERO, cis: 4, ticketCIs: 1, tickets: 1 } })
    await expect(deleteCITypeDependents(tx, 't1', TYPE)).rejects.toThrow(/linked to 1 ticket/)
    expect(vi.mocked(runQueryOne).mock.calls.map(([, c]) => c)).toEqual([CI_TYPE_DELETION_IMPACT_CYPHER])
  })

  it('un conteggio scritto diverso da quello letto (qualcosa è cambiato nel mentre) → errore: la transazione si annulla', async () => {
    route({ impact: { ...ZERO, cis: 2 }, cis: { ids: ['ci-1', 'ci-2', 'ci-3'] } })
    await expect(deleteCITypeDependents(tx, 't1', TYPE)).rejects.toThrow(/cis 3\/2 — something changed while deleting/)
  })
})
