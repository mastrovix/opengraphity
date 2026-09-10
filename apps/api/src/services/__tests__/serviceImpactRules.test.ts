/**
 * services/serviceImpact/rules.ts — regole d'impatto come funzione pura:
 * la tabella del contratto (esempio Billing e casi limite), il percorso
 * `via`, l'ordinamento e il tetto delle cause, `nodeContributes`.
 *
 * Revisione 2 · R1: le due manutenzioni sono distinte — il ciclo di vita
 * (`lifecycleMaintenance`) toglie il nodo dal calcolo senza mettere il servizio
 * in manutenzione, solo la finestra di change (`inChangeWindow`) su un critico
 * lo fa, e `down` vince su `maintenance`. `healthIfActive` e
 * `nodeExcludedReason` completano il quadro.
 */
import { describe, it, expect } from 'vitest'
import { evaluateImpact, impactPath, nodeContributes, nodeExcludedReason, type ImpactNodeInput } from '../serviceImpact/rules.js'
import { DEFAULT_SERVICE_IMPACT_RULES, NODE_EXCLUDED_REASONS, SERVICE_MAX_CAUSES, type ServiceImpactRules } from '../../lib/serviceVocabularies.js'

const RULES: ServiceImpactRules = { ...DEFAULT_SERVICE_IMPACT_RULES }

function node(over: Partial<ImpactNodeInput> & { ciId: string }): ImpactNodeInput {
  return { level: 2, role: 'infrastructure', propagate: 'weighted', weight: 5, critical: false, health: 'operational', inChangeWindow: false, lifecycleMaintenance: false, via: 'api-03', ...over }
}

/** Esempio del progetto: Enterprise Billing. */
function billing(h: { api?: ImpactNodeInput['health']; db?: ImpactNodeInput['health']; cache?: ImpactNodeInput['health']; cert?: ImpactNodeInput['health'] } = {}, over: Partial<Record<'api' | 'db' | 'cache' | 'cert', Partial<ImpactNodeInput>>> = {}): ImpactNodeInput[] {
  // `null` = nessuna salute (voluto): non va confuso con «non specificato».
  const hv = (v: ImpactNodeInput['health'] | undefined) => (v === undefined ? 'operational' : v)
  return [
    node({ ciId: 'api-03', level: 1, role: 'entry', weight: 8, critical: true, via: null, health: hv(h.api), ...over.api }),
    node({ ciId: 'db-01', weight: 5, health: hv(h.db), ...over.db }),
    node({ ciId: 'cache-02', weight: 3, health: hv(h.cache), ...over.cache }),
    node({ ciId: 'cert-billing', role: 'certificate', propagate: 'never', weight: 3, health: hv(h.cert), ...over.cert }),
  ]
}

describe('evaluateImpact — tabella del contratto', () => {
  it('Billing: db-01 giù + cache-02 degradato → degraded 41 (peso 16, giù 6,5), cause db-01 (via api-03) poi cache-02', () => {
    const r = evaluateImpact(billing({ db: 'down', cache: 'degraded' }), RULES)
    expect(r.health).toBe('degraded')
    expect(r.impactScore).toBe(41)
    expect(r.causes).toEqual([
      { ciId: 'db-01', health: 'down', weight: 5, critical: false, path: ['db-01', 'api-03'] },
      { ciId: 'cache-02', health: 'degraded', weight: 3, critical: false, path: ['cache-02', 'api-03'] },
    ])
  })

  it('Billing: api-03 (critico) giù → down, causa critica per prima con percorso di un solo nodo', () => {
    const r = evaluateImpact(billing({ api: 'down', cache: 'degraded' }), RULES)
    expect(r.health).toBe('down')
    expect(r.impactScore).toBe(Math.round((100 * (8 + 1.5)) / 16))
    expect(r.causes[0]).toEqual({ ciId: 'api-03', health: 'down', weight: 8, critical: true, path: ['api-03'] })
  })

  it('Billing tutto operativo → operational 0, nessuna causa; il certificato (never) non pesa nemmeno se giù', () => {
    expect(evaluateImpact(billing(), RULES)).toEqual({ health: 'operational', impactScore: 0, causes: [], healthIfActive: null })
    expect(evaluateImpact(billing({ cert: 'down' }), RULES)).toEqual({ health: 'operational', impactScore: 0, causes: [], healthIfActive: null })
  })

  it('quota giù ≥ down_share_pct senza critici → down (db-01 e cache-02 giù: 8/16 = 50 %)', () => {
    const r = evaluateImpact(billing({ db: 'down', cache: 'down' }), RULES)
    expect(r.health).toBe('down')
    expect(r.impactScore).toBe(50)
    const under = evaluateImpact(billing({ db: 'down', cache: 'down' }), { ...RULES, down_share_pct: 51 })
    expect(under.health).toBe('degraded')
  })

  it('nessun nodo con salute nota → unknown 0, con ENTRAMBE le modalità (un servizio non monitorato non è «operativo»)', () => {
    const nodes = billing({ api: null, db: null, cache: null, cert: null })
    expect(evaluateImpact(nodes, { ...RULES, unknown_nodes: 'ignore' })).toEqual({ health: 'unknown', impactScore: 0, causes: [], healthIfActive: null })
    expect(evaluateImpact(nodes, { ...RULES, unknown_nodes: 'operational' })).toEqual({ health: 'unknown', impactScore: 0, causes: [], healthIfActive: null })
    // basta un nodo con salute nota (operativo) perché il servizio sia operativo
    expect(evaluateImpact(billing({ api: 'operational', db: null, cache: null, cert: null }), RULES).health).toBe('operational')
  })

  it('unknown_nodes: un nodo senza salute è ignorato (peso escluso dal totale) o operativo (peso nel totale, default), mai giù', () => {
    const nodes = billing({ api: null, db: 'down' })
    expect(evaluateImpact(nodes, { ...RULES, unknown_nodes: 'ignore' }).impactScore).toBe(Math.round((100 * 5) / 8))     // totale 8: db-01 + cache-02
    expect(evaluateImpact(nodes, { ...RULES, unknown_nodes: 'operational' }).impactScore).toBe(Math.round((100 * 5) / 16))
    // db giù pesa 5/8 = 62,5 % ≥ 50 → down con ignore; 5/16 = 31 % → degraded con operational (il default)
    expect(evaluateImpact(nodes, { ...RULES, unknown_nodes: 'ignore' }).health).toBe('down')
    expect(evaluateImpact(nodes, { ...RULES, unknown_nodes: 'operational' }).health).toBe('degraded')
    expect(evaluateImpact(nodes, RULES).health).toBe('degraded')
  })

  it('tutti i nodi con propagate = never → unknown', () => {
    const nodes = billing({ db: 'down' }).map((n) => ({ ...n, propagate: 'never' as const }))
    expect(evaluateImpact(nodes, RULES)).toEqual({ health: 'unknown', impactScore: 0, causes: [], healthIfActive: null })
  })

  it('nodo critico in finestra di change → maintenance con healthIfActive; il nodo in finestra non pesa e non è causa', () => {
    // il resto è sano: senza la finestra il servizio sarebbe operativo
    const r = evaluateImpact(billing({}, { api: { inChangeWindow: true } }), RULES)
    expect(r.health).toBe('maintenance')
    expect(r.healthIfActive).toBe('operational')
    expect(r.impactScore).toBe(0)
    expect(r.causes).toEqual([])
    // con un componente degradato: in manutenzione, ma «sarebbe» degradato
    const degraded = evaluateImpact(billing({ cache: 'degraded' }, { api: { inChangeWindow: true } }), RULES)
    expect(degraded.health).toBe('maintenance')
    expect(degraded.healthIfActive).toBe('degraded')
    expect(degraded.impactScore).toBe(Math.round((100 * 1.5) / 8))   // api-03 (8) fuori dal totale
    expect(degraded.causes.map((c) => c.ciId)).toEqual(['cache-02'])
  })

  it('R1: `down` vince su `maintenance` — un critico in finestra non nasconde un guasto sotto', () => {
    // db-01 giù pesa 5 su 8 (api-03 in finestra è fuori dal totale) = 62,5 % ≥ 50
    const r = evaluateImpact(billing({ db: 'down' }, { api: { inChangeWindow: true } }), RULES)
    expect(r.health).toBe('down')
    expect(r.healthIfActive).toBeNull()   // valorizzata solo quando la salute È maintenance
    expect(r.causes.map((c) => c.ciId)).toEqual(['db-01'])
    // e con un SECONDO critico giù, qualunque sia la quota
    const twoCriticals = evaluateImpact(
      billing({ db: 'down' }, { api: { inChangeWindow: true }, db: { critical: true } }),
      { ...RULES, down_share_pct: 100 },
    )
    expect(twoCriticals.health).toBe('down')
  })

  it('nodo NON critico in finestra → non pesa e non è causa, il servizio segue il resto (nessuna manutenzione)', () => {
    const r = evaluateImpact(billing({ db: 'down' }, { db: { inChangeWindow: true } }), RULES)
    expect(r).toEqual({ health: 'operational', impactScore: 0, causes: [], healthIfActive: null })
  })

  // ── R1: ciclo di vita ≠ finestra di change ────────────────────────────────

  it('R1: ciclo di vita `maintenance` su un critico → il nodo non conta, il servizio NON è in manutenzione', () => {
    // api-03 (critico, peso 8) fuori dal calcolo: restano db-01 e cache-02 sani
    const r = evaluateImpact(billing({}, { api: { lifecycleMaintenance: true } }), RULES)
    expect(r.health).toBe('operational')
    expect(r.healthIfActive).toBeNull()
    // …e non nasconde il guasto di un altro componente
    const withDown = evaluateImpact(billing({ db: 'down' }, { api: { lifecycleMaintenance: true } }), RULES)
    expect(withDown.health).toBe('down')       // 5/8 = 62,5 % ≥ 50
    expect(withDown.causes.map((c) => c.ciId)).toEqual(['db-01'])
  })

  it('R1: critico in ciclo di vita `maintenance` + altro critico giù → down (mai maintenance)', () => {
    const r = evaluateImpact(
      billing({ db: 'down' }, { api: { lifecycleMaintenance: true }, db: { critical: true } }),
      { ...RULES, down_share_pct: 100 },
    )
    expect(r.health).toBe('down')
    expect(r.healthIfActive).toBeNull()
  })

  it('R1: un nodo in ciclo di vita `maintenance` non compare MAI fra le cause, nemmeno se è giù', () => {
    const r = evaluateImpact(billing({ db: 'down' }, { db: { lifecycleMaintenance: true } }), RULES)
    expect(r.causes).toEqual([])
    expect(r.health).toBe('operational')
  })

  it('R1: ciclo di vita e finestra insieme sullo stesso critico → maintenance (la finestra decide), healthIfActive senza la finestra', () => {
    const r = evaluateImpact(billing({}, { api: { inChangeWindow: true, lifecycleMaintenance: true } }), RULES)
    expect(r.health).toBe('maintenance')
    // senza la finestra il nodo resta fuori per il ciclo di vita: gli altri sono sani
    expect(r.healthIfActive).toBe('operational')
  })

  it('min_nodes: un solo nodo non operativo con min_nodes = 2 → operational (ma il punteggio resta); due → degraded', () => {
    const rules = { ...RULES, min_nodes: 2 }
    const one = evaluateImpact(billing({ cache: 'degraded' }), rules)
    expect(one.health).toBe('operational')
    expect(one.impactScore).toBe(Math.round((100 * 1.5) / 16))
    expect(evaluateImpact(billing({ cache: 'degraded', db: 'degraded' }), rules).health).toBe('degraded')
  })

  it('degraded_share_pct: sotto la soglia il servizio resta operational anche con una causa', () => {
    const r = evaluateImpact(billing({ cache: 'degraded' }), { ...RULES, degraded_share_pct: 10 })
    expect(r.health).toBe('operational')
    expect(r.impactScore).toBe(9)
    expect(r.causes).toHaveLength(1)
  })

  it('down_share_pct = 0 non rende giù un servizio senza nodi giù', () => {
    expect(evaluateImpact(billing(), { ...RULES, down_share_pct: 0 }).health).toBe('operational')
    expect(evaluateImpact(billing({ cache: 'degraded' }), { ...RULES, down_share_pct: 0 }).health).toBe('degraded')
    expect(evaluateImpact(billing({ cache: 'down' }), { ...RULES, down_share_pct: 0 }).health).toBe('down')
  })

  it('always pesa come weighted (peso pieno)', () => {
    const a = evaluateImpact(billing({ db: 'down' }, { db: { propagate: 'always' } }), RULES)
    const w = evaluateImpact(billing({ db: 'down' }), RULES)
    expect(a).toEqual(w)
  })

  it('cause ordinate: critici prima, poi peso desc, poi livello asc, poi id; al più SERVICE_MAX_CAUSES', () => {
    const nodes: ImpactNodeInput[] = [
      node({ ciId: 'l3-w5', level: 3, weight: 5, health: 'degraded' }),
      node({ ciId: 'l2-w5', level: 2, weight: 5, health: 'degraded' }),
      node({ ciId: 'w9', level: 2, weight: 9, health: 'down' }),
      node({ ciId: 'crit-w1', level: 2, weight: 1, critical: true, health: 'degraded' }),
      node({ ciId: 'a-l2-w5', level: 2, weight: 5, health: 'down' }),
      ...Array.from({ length: 30 }, (_, i) => node({ ciId: `many-${String(i).padStart(2, '0')}`, level: 4, weight: 2, health: 'degraded' })),
    ]
    const r = evaluateImpact(nodes, { ...RULES, down_share_pct: 100 })
    expect(r.causes.map((c) => c.ciId).slice(0, 5)).toEqual(['crit-w1', 'w9', 'a-l2-w5', 'l2-w5', 'l3-w5'])
    expect(r.causes).toHaveLength(SERVICE_MAX_CAUSES)
    expect(SERVICE_MAX_CAUSES).toBe(20)
  })

  it('peso non intero o < 1 su un nodo che conta → errore (dato corrotto, non un default)', () => {
    expect(() => evaluateImpact([node({ ciId: 'x', weight: 0 })], RULES)).toThrow(/node x has an invalid weight 0/)
    expect(() => evaluateImpact([node({ ciId: 'x', weight: 2.5 })], RULES)).toThrow(/invalid weight 2.5/)
    // un nodo che non conta (never) non viene validato: non entra nel calcolo
    expect(() => evaluateImpact([node({ ciId: 'x', weight: 0, propagate: 'never' })], RULES)).not.toThrow()
  })
})

describe('impactPath e nodeContributes', () => {
  it('risale via fino al livello 1; un via fuori dalla mappa chiude il percorso; un ciclo non manda in loop', () => {
    const byId = new Map<string, ImpactNodeInput>([
      ['l1', node({ ciId: 'l1', level: 1, via: null })],
      ['l2', node({ ciId: 'l2', level: 2, via: 'l1' })],
      ['l3', node({ ciId: 'l3', level: 3, via: 'l2' })],
      ['orphan', node({ ciId: 'orphan', level: 3, via: 'gone' })],
      ['c1', node({ ciId: 'c1', via: 'c2' })],
      ['c2', node({ ciId: 'c2', via: 'c1' })],
    ])
    expect(impactPath('l3', byId)).toEqual(['l3', 'l2', 'l1'])
    expect(impactPath('orphan', byId)).toEqual(['orphan', 'gone'])
    expect(impactPath('c1', byId)).toEqual(['c1', 'c2'])
    expect(impactPath('unknown', byId)).toEqual(['unknown'])
  })

  it('nodeContributes: never / in finestra / ciclo di vita / senza salute (ignore) → false; senza salute con operational → true', () => {
    expect(nodeContributes(node({ ciId: 'a' }), RULES)).toBe(true)
    expect(nodeContributes(node({ ciId: 'a', propagate: 'never' }), RULES)).toBe(false)
    expect(nodeContributes(node({ ciId: 'a', inChangeWindow: true }), RULES)).toBe(false)
    expect(nodeContributes(node({ ciId: 'a', lifecycleMaintenance: true }), RULES)).toBe(false)
    expect(nodeContributes(node({ ciId: 'a', health: null }), { ...RULES, unknown_nodes: 'ignore' })).toBe(false)
    expect(nodeContributes(node({ ciId: 'a', health: null }), { ...RULES, unknown_nodes: 'operational' })).toBe(true)
  })

  it('nodeExcludedReason: il motivo in un vocabolario chiuso, nell\'ordine in cui decide; null se il nodo conta', () => {
    expect(nodeExcludedReason(node({ ciId: 'a' }), RULES)).toBeNull()
    expect(nodeExcludedReason(node({ ciId: 'a', propagate: 'never', inChangeWindow: true }), RULES)).toBe('never')
    expect(nodeExcludedReason(node({ ciId: 'a', inChangeWindow: true, lifecycleMaintenance: true }), RULES)).toBe('change_window')
    expect(nodeExcludedReason(node({ ciId: 'a', lifecycleMaintenance: true }), RULES)).toBe('lifecycle_maintenance')
    expect(nodeExcludedReason(node({ ciId: 'a', health: null }), { ...RULES, unknown_nodes: 'ignore' })).toBe('unknown_health')
    expect(nodeExcludedReason(node({ ciId: 'a', health: null }), { ...RULES, unknown_nodes: 'operational' })).toBeNull()
    // ogni motivo prodotto è nel vocabolario
    for (const n of [node({ ciId: 'a', propagate: 'never' }), node({ ciId: 'a', inChangeWindow: true }), node({ ciId: 'a', lifecycleMaintenance: true })]) {
      expect(NODE_EXCLUDED_REASONS).toContain(nodeExcludedReason(n, RULES))
    }
  })
})
