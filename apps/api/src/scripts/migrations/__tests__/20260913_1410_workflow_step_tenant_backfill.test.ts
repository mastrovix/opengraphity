/**
 * Migrazione 20260913_1410: completa i WorkflowStep creati dal disegnatore
 * (che nascevano senza `tenant_id` né metadata). Solo dove il dato manca,
 * idempotente, e si ferma su un passo appeso a nessuna definizione.
 */
import { describe, it, expect, vi } from 'vitest'
import { workflowStepTenantBackfill } from '../20260913_1410_workflow_step_tenant_backfill.js'
import { MIGRATIONS } from '../index.js'

type Row = Record<string, unknown>
const rec = (r: Row) => ({ get: (k: string) => (k in r ? r[k] : null) })

/** Sessione finta: restituisce i risultati in ordine di chiamata. */
function fakeSession(results: Array<Row[]>) {
  const calls: Array<{ cypher: string; params: Record<string, unknown> | undefined }> = []
  let i = 0
  return {
    calls,
    run: vi.fn(async (cypher: string, params?: Record<string, unknown>) => {
      calls.push({ cypher, params })
      return { records: (results[i++] ?? []).map(rec) }
    }),
  }
}

describe('20260913_1410_workflow_step_tenant_backfill', () => {
  it('è registrata e ha un id nel formato YYYYMMDD_HHMM_name', () => {
    expect(MIGRATIONS.map((m) => m.id)).toContain(workflowStepTenantBackfill.id)
    expect(workflowStepTenantBackfill.id).toMatch(/^\d{8}_\d{4}_[a-z0-9_]+$/)
  })

  it('niente da completare → una sola lettura in più e nessuna scrittura', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const s = fakeSession([[], []])          // nessun orfano, nessun passo incompleto
    await workflowStepTenantBackfill.up(s as never)
    expect(s.run).toHaveBeenCalledTimes(2)
    expect(s.calls.some((c) => c.cypher.includes('SET s.tenant_id'))).toBe(false)
  })

  it('passo senza tenant_id → eredita quello della definizione, con step_order in coda', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const s = fakeSession([
      [],                                                              // orfani
      [{ stepId: 's-new', stepName: 'standard_attesa_x', stepType: 'standard', noOrder: true, noTenant: true, defId: 'def-1', defName: 'Incident Management', tenantId: 'c-one' }],
      [{ maxOrder: 8 }],                                               // massimo della definizione
      [],                                                              // la SET
    ])
    await workflowStepTenantBackfill.up(s as never)
    const set = s.calls.find((c) => c.cypher.includes('SET s.tenant_id'))!
    expect(set.params).toMatchObject({ stepId: 's-new', tenantId: 'c-one', order: 9 })
    // solo dove manca: mai una sovrascrittura
    expect(set.cypher).toContain('coalesce(s.tenant_id, $tenantId)')
    expect(set.cypher).toContain("coalesce(s.is_initial, s.type = 'start')")
    expect(set.cypher).toContain("coalesce(s.category, CASE WHEN terminal THEN 'closed' ELSE 'active' END)")
  })

  it('due passi nuovi nella stessa definizione prendono posti diversi', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const base = { stepType: 'standard', noOrder: true, noTenant: true, defId: 'def-1', defName: 'D', tenantId: 'c-one' }
    const s = fakeSession([
      [],
      [{ ...base, stepId: 's-1', stepName: 'a' }, { ...base, stepId: 's-2', stepName: 'b' }],
      [{ maxOrder: 3 }],
      [], [],
    ])
    await workflowStepTenantBackfill.up(s as never)
    const orders = s.calls.filter((c) => c.cypher.includes('SET s.tenant_id')).map((c) => c.params!['order'])
    expect(orders).toEqual([4, 5])
    // il massimo si legge UNA volta per definizione
    expect(s.calls.filter((c) => c.cypher.includes('AS maxOrder'))).toHaveLength(1)
  })

  it('passo appeso a nessuna definizione → si ferma nominandolo (niente tenant inventato)', async () => {
    const s = fakeSession([[{ id: 's-orfano', name: 'orfano', definitionId: 'def-morta' }]])
    await expect(workflowStepTenantBackfill.up(s as never)).rejects.toThrow(/orfano \(id s-orfano, definition_id def-morta\)/)
    expect(s.run).toHaveBeenCalledOnce()
  })
})
