/**
 * «Questo tipo di CI è in uso?» (ondata 6 · A-8 / D-10). Prima di
 * quest'ondata nessuno lo chiedeva: `deleteCIType` faceva `DETACH DELETE` e i
 * CI restavano nel grafo invisibili a tutto il prodotto.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const runQueryOne = vi.fn()
vi.mock('@opengraphity/neo4j', () => ({ runQueryOne }))

const { loadCITypeUsage, describeCITypeUsage, CI_TYPE_USAGE_CYPHER } = await import('../ciTypeUsage.js')

const ZERO = {
  cis: 0, itil_relation_rules: 0, assessment_questions: 0, dynamic_ci_groups: 0,
  field_visibility_rules: 0, field_requirement_rules: 0, business_rules: 0,
  auto_triggers: 0, custom_widgets: 0, report_nodes: 0,
}

beforeEach(() => vi.clearAllMocks())

describe('loadCITypeUsage', () => {
  it('una sola lettura, con etichetta e nome come PARAMETRI (mai interpolati)', async () => {
    runQueryOne.mockResolvedValue(ZERO)
    await loadCITypeUsage({} as never, 'c-two', 'ct-1', 'bilanciatore', 'Bilanciatore')
    expect(runQueryOne).toHaveBeenCalledTimes(1)
    const [, cypher, params] = runQueryOne.mock.calls[0] as [unknown, string, Record<string, unknown>]
    expect(cypher).toBe(CI_TYPE_USAGE_CYPHER)
    expect(cypher).toContain('$label IN labels(ci)')
    expect(cypher).not.toContain('Bilanciatore')
    expect(params).toEqual({ tenantId: 'c-two', typeId: 'ct-1', name: 'bilanciatore', label: 'Bilanciatore' })
  })

  it('tipo non usato: nessun CI, nessun riferimento', async () => {
    runQueryOne.mockResolvedValue(ZERO)
    const usage = await loadCITypeUsage({} as never, 'c-two', 'ct-1', 'bilanciatore', 'Bilanciatore')
    expect(usage).toEqual({ cis: 0, references: [] })
    expect(describeCITypeUsage(usage)).toBe('')
  })

  it('conta i CI e SOLO i riferimenti che esistono, in ordine di dichiarazione', async () => {
    runQueryOne.mockResolvedValue({ ...ZERO, cis: 12, itil_relation_rules: 2, custom_widgets: 1 })
    const usage = await loadCITypeUsage({} as never, 'c-two', 'ct-1', 'bilanciatore', 'Bilanciatore')
    expect(usage.cis).toBe(12)
    expect(usage.references).toEqual([
      { kind: 'itil_relation_rules', count: 2 },
      { kind: 'custom_widgets', count: 1 },
    ])
    expect(describeCITypeUsage(usage)).toBe('2 regole di relazione ITIL (Impostazioni → Relazioni ITIL); 1 widget della dashboard')
  })

  it('nessuna riga o un conteggio non numerico → errore (mai «non è usato» per difetto)', async () => {
    runQueryOne.mockResolvedValue(null)
    await expect(loadCITypeUsage({} as never, 'c-two', 'ct-1', 'x', 'X')).rejects.toThrow(/non ha restituito righe/)
    runQueryOne.mockResolvedValue({ ...ZERO, cis: 'molti' })
    await expect(loadCITypeUsage({} as never, 'c-two', 'ct-1', 'x', 'X')).rejects.toThrow(/non numerico/)
  })

  it('i criteri di un gruppo dinamico sono un CSV: il confronto è sulla voce, non sulla sottostringa', () => {
    expect(CI_TYPE_USAGE_CYPHER).toContain("$name IN [x IN split(g.criteria_ci_types, ',') | trim(x)]")
  })
})
