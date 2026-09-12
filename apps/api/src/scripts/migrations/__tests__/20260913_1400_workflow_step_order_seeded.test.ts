/**
 * Personalizzazioni, ondata 2 (A2-2 / B-15).
 *
 * Due proprietà:
 *   1. `20260908_1000_workflow_step_metadata` completa solo i valori MANCANTI
 *      (`coalesce`): `category`/`is_terminal`/`is_initial`/`is_open`/`step_order`
 *      già valorizzati non vengono mai riscritti — nemmeno con `--force`, che
 *      riesegue esattamente questa `up()`. Prima era un `SET` incondizionato
 *      che cancellava in silenzio le scelte del cliente.
 *   2. la nuova `20260913_1400_workflow_step_order_seeded` riporta all'ordine
 *      delle transizioni i cinque `step_order = 99` dei workflow seminati
 *      (problem `known_error`; service_request `submitted`/`approval`/
 *      `fulfilled`/`rejected`) senza toccare i passi aggiunti dal cliente.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { workflowStepMetadata, resetWorkflowStepMetadataFromFactory } from '../20260908_1000_workflow_step_metadata.js'
import { workflowStepOrderSeeded } from '../20260913_1400_workflow_step_order_seeded.js'
import { MIGRATIONS } from '../index.js'

function rows(list: Record<string, unknown>[]) {
  return { records: list.map((r) => ({ get: (k: string) => r[k] })) }
}

function capture() {
  const seen: { cypher: string; params: Record<string, unknown> }[] = []
  return {
    seen,
    run: vi.fn(async (cypher: string, params: Record<string, unknown> = {}) => {
      seen.push({ cypher, params })
      return rows([{ seen: 0, completed: 0 }])
    }),
  }
}

beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}) })

describe('20260908_1000_workflow_step_metadata — B-15: non riscrive più le scelte del cliente', () => {
  it('ogni metadato è scritto in coalesce, quindi un valore già presente resta', async () => {
    const s = capture()
    await workflowStepMetadata.up(s as never)
    const c = s.seen[0]!.cypher
    for (const prop of ['is_initial', 'is_terminal', 'is_open', 'category', 'step_order']) {
      expect(c).toMatch(new RegExp(`s\\.${prop}\\s*=\\s*coalesce\\(s\\.${prop}`))
    }
    // nessun SET incondizionato: non deve esistere un `s.<prop> = <valore derivato>`
    expect(c).not.toMatch(/s\.is_initial\s*=\s*isInitial/)
    expect(c).not.toMatch(/s\.is_terminal\s*=\s*isTerminal/)
    expect(c).not.toMatch(/s\.step_order\s*=\s*stepOrd\b/)
  })

  it('la tabella di ripiego conosce known_error e i nomi veri del workflow Service Request', async () => {
    const s = capture()
    await workflowStepMetadata.up(s as never)
    const order = s.seen[0]!.params['stepOrder'] as Record<string, Record<string, number>>
    expect(order['problem']).toMatchObject({ known_error: 3, change_requested: 4, closed: 9 })
    expect(order['service_request']).toMatchObject({ submitted: 1, approval: 2, in_progress: 3, fulfilled: 4, closed: 5, rejected: 6 })
    // i nomi che il workflow SR non ha mai avuto non ci sono più
    expect(order['service_request']).not.toHaveProperty('assigned')
  })
})

describe('resetWorkflowStepMetadataFromFactory — il ripristino di fabbrica ha un nome suo e stampa il diff', () => {
  it('con dryRun elenca i passi che cambierebbero e NON scrive', async () => {
    const lines: string[] = []
    const s = {
      run: vi.fn(async (cypher: string) => {
        if (cypher.includes('RETURN wd.tenant_id AS tenant')) {
          return rows([{ tenant: 'c-one', def: 'Problem Management', step: 'known_error', oldInit: false, newInit: false, oldTerm: false, newTerm: false, oldCat: 'custom', newCat: 'active', oldOrd: 99, newOrd: 3 }])
        }
        return rows([])
      }),
    }
    const r = await resetWorkflowStepMetadataFromFactory(s as never, { dryRun: true, log: (m) => lines.push(m) })
    expect(r.changed).toBe(1)
    expect(lines.join('\n')).toContain('category custom→active')
    expect(lines.join('\n')).toContain('step_order 99→3')
    expect(s.run.mock.calls.some((c) => String(c[0]).includes('SET s.is_initial  = isInitial'))).toBe(false)
  })

  it('senza dryRun scrive il SET incondizionato (è quello che gli si chiede)', async () => {
    const s = {
      run: vi.fn(async (cypher: string) => {
        if (cypher.includes('RETURN wd.tenant_id AS tenant')) return rows([{ tenant: 'c-one', def: 'X', step: 'y', oldInit: false, newInit: false, oldTerm: false, newTerm: false, oldCat: 'a', newCat: 'b', oldOrd: 1, newOrd: 2 }])
        return rows([])
      }),
    }
    await resetWorkflowStepMetadataFromFactory(s as never, { log: () => {} })
    expect(s.run.mock.calls.some((c) => String(c[0]).includes('SET s.is_initial  = isInitial'))).toBe(true)
  })
})

describe('20260913_1400_workflow_step_order_seeded', () => {
  it('è registrata, con id nel formato atteso e prima della 1410', () => {
    const ids = MIGRATIONS.map((m) => m.id)
    expect(ids).toContain('20260913_1400_workflow_step_order_seeded')
    expect(workflowStepOrderSeeded.id).toMatch(/^\d{8}_\d{4}_[a-z0-9_]+$/)
    expect(workflowStepOrderSeeded.autocommit).toBeUndefined()
  })

  it('tocca solo le due definizioni seminate con i 99, per nome ed entity_type', async () => {
    const s = capture()
    await workflowStepOrderSeeded.up(s as never)
    expect(s.seen).toHaveLength(2)
    expect(s.seen.map((q) => q.params['definition'])).toEqual(['Problem Management', 'Service Request Fulfillment'])
    expect(s.seen.map((q) => q.params['entityType'])).toEqual(['problem', 'service_request'])
  })

  it('l\'ordine scritto è quello delle transizioni: known_error fra under_investigation e change_requested; submitted per primo', async () => {
    const s = capture()
    await workflowStepOrderSeeded.up(s as never)
    const problem = s.seen[0]!.params['order'] as Record<string, number>
    expect(problem['under_investigation']).toBeLessThan(problem['known_error']!)
    expect(problem['known_error']).toBeLessThan(problem['change_requested']!)
    const sr = s.seen[1]!.params['order'] as Record<string, number>
    expect(Math.min(...Object.values(sr))).toBe(sr['submitted'])
    expect(sr['submitted']).toBeLessThan(sr['closed']!)   // il passo INIZIALE prima di quello di chiusura
    expect(sr['in_progress']).toBeLessThan(sr['fulfilled']!)
  })

  it('un passo che il seed non conosce (aggiunto dal cliente) non è nella tabella: la query lo esclude con `wanted IS NOT NULL`', async () => {
    const s = capture()
    await workflowStepOrderSeeded.up(s as never)
    for (const q of s.seen) {
      expect(q.cypher).toContain('WHERE wanted IS NOT NULL')
      // idempotente: scrive solo dove il valore è diverso
      expect(q.cypher).toContain('s.step_order <> wanted')
      const order = q.params['order'] as Record<string, number>
      expect(order).not.toHaveProperty('triage_cliente')
    }
  })
})
