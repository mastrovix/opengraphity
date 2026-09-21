/**
 * Layout a livelli (funzione pura): un nodo per componente sulla riga del
 * suo livello, il servizio in cima, archi vivi + il tratto servizio → livello
 * 1, percorso d'impatto marcato con la severità peggiore, segmenti del
 * percorso senza arco vivo disegnati ma marcati non vivi.
 */
import { describe, it, expect } from 'vitest'
import {
  layoutServiceMap, causeSequence,
  NODE_H, NODE_W, GAP_X, GAP_Y, PAD, CHIP_W, FOCUS_ROW_MAX, ROOT_REL,
} from './serviceMapLayout'
import type { ImpactCause, ServiceMapEdge, ServiceMapNode } from '@/types/services'

const n = (id: string, level: number, via: string | null, over: Partial<ServiceMapNode> = {}): ServiceMapNode => ({
  ci: { id, name: id, type: 'server' }, level, role: 'infrastructure', propagate: 'weighted', weight: 5, critical: false,
  via, addedBy: 'auto', health: 'operational', inMaintenance: false, contributes: true, excludedReason: null, ...over,
})
const e = (source: string, target: string, relType = 'DEPENDS_ON'): ServiceMapEdge => ({ source, target, relType })
const cause = (id: string, health: 'down' | 'degraded', path: string[]): ImpactCause =>
  ({ ci: { id, name: id, type: 'server' }, health, weight: 5, critical: false, path: path.map((p) => ({ id: p, name: p })) })

const NODES = [n('api-03', 1, null), n('db-01', 2, 'api-03', { health: 'down' }), n('cache-02', 2, 'api-03', { health: 'degraded' }), n('cert', 2, 'api-03', { health: null }), n('san-01', 3, 'db-01')]
const EDGES = [e('api-03', 'db-01'), e('api-03', 'cache-02'), e('api-03', 'cert', 'USES_CERTIFICATE'), e('db-01', 'san-01', 'HOSTED_ON')]

describe('layoutServiceMap', () => {
  it('un nodo per componente sulla riga del suo livello, il servizio in cima; righe compattate ma con il livello vero', () => {
    const l = layoutServiceMap('svc', NODES, EDGES, [])
    expect(l.levels).toEqual([0, 1, 2, 3])
    expect(l.nodes).toHaveLength(NODES.length + 1)
    const root = l.nodes.find((p) => p.node === null)!
    expect(root.id).toBe('svc'); expect(root.level).toBe(0); expect(root.y).toBe(PAD)
    const byLevel = (lvl: number) => l.nodes.filter((p) => p.level === lvl)
    expect(byLevel(1).map((p) => p.id)).toEqual(['api-03'])
    expect(byLevel(2).map((p) => p.id).sort()).toEqual(['cache-02', 'cert', 'db-01'])
    expect(byLevel(3).map((p) => p.id)).toEqual(['san-01'])
    // stessa y per riga, y crescente con il livello
    for (const p of byLevel(2)) expect(p.y).toBe(PAD + 2 * (NODE_H + GAP_Y))
    expect(byLevel(3)[0]!.y).toBe(PAD + 3 * (NODE_H + GAP_Y))
    // nella riga le x sono distinte
    expect(new Set(byLevel(2).map((p) => p.x)).size).toBe(3)

    // livello 4 vuoto e livello 5 popolato → la riga 5 è la quarta riga (compattata), etichettata 5
    const gap = layoutServiceMap('svc', [n('a', 1, null), n('b', 5, 'a')], [], [])
    expect(gap.levels).toEqual([0, 1, 5])
    expect(gap.nodes.find((p) => p.id === 'b')!.y).toBe(PAD + 2 * (NODE_H + GAP_Y))
  })

  it('archi: il servizio è collegato al livello 1 (REALIZES), gli archi vivi sono tutti presenti, un arco verso un nodo non incluso è scartato', () => {
    const l = layoutServiceMap('svc', NODES, [...EDGES, e('api-03', 'ghost')], [])
    expect(l.edges.map((x) => `${x.source}→${x.target}`).sort()).toEqual(['api-03→cache-02', 'api-03→cert', 'api-03→db-01', 'db-01→san-01', 'svc→api-03'].sort())
    const rootEdge = l.edges.find((x) => x.source === 'svc')!
    expect(rootEdge.relType).toBe(ROOT_REL)
    expect(l.edges.every((x) => x.live)).toBe(true)
    expect(l.edges.every((x) => x.highlight === null)).toBe(true)
  })

  it('percorso d\'impatto: nodi e segmenti delle cause marcati con la severità peggiore (giù > degradato), fino al servizio', () => {
    const causes = [cause('db-01', 'down', ['api-03']), cause('cache-02', 'degraded', ['cache-02', 'api-03'])]
    const l = layoutServiceMap('svc', NODES, EDGES, causes)
    const p = (id: string) => l.nodes.find((x) => x.id === id)!
    expect(p('db-01').onPath).toBe('down');        expect(p('db-01').isCause).toBe(true)
    expect(p('cache-02').onPath).toBe('degraded'); expect(p('cache-02').isCause).toBe(true)
    expect(p('api-03').onPath).toBe('down')        // attraversato da entrambi: vince giù
    expect(p('svc').onPath).toBe('down')
    expect(p('cert').onPath).toBeNull();           expect(p('cert').isCause).toBe(false)
    expect(p('san-01').onPath).toBeNull()
    const edge = (s: string, t: string) => l.edges.find((x) => x.source === s && x.target === t)!
    expect(edge('svc', 'api-03').highlight).toBe('down')
    expect(edge('api-03', 'db-01').highlight).toBe('down')
    expect(edge('api-03', 'cache-02').highlight).toBe('degraded')
    expect(edge('api-03', 'cert').highlight).toBeNull()
    expect(edge('db-01', 'san-01').highlight).toBeNull()
  })

  it('un segmento del percorso senza arco vivo viene disegnato lo stesso, marcato non vivo (la mappa non è più allineata alla CMDB)', () => {
    const l = layoutServiceMap('svc', NODES, EDGES.filter((x) => x.target !== 'db-01'), [cause('db-01', 'down', ['api-03'])])
    const synthetic = l.edges.find((x) => x.source === 'api-03' && x.target === 'db-01')!
    expect(synthetic).toBeDefined()
    expect(synthetic.live).toBe(false)
    expect(synthetic.highlight).toBe('down')
    // non viene duplicato quando l'arco vivo c'è
    const ok = layoutServiceMap('svc', NODES, EDGES, [cause('db-01', 'down', ['api-03'])])
    expect(ok.edges.filter((x) => x.source === 'api-03' && x.target === 'db-01')).toHaveLength(1)
  })

  it('causeSequence: il nodo malato una volta sola, che il server lo metta o no in path', () => {
    expect(causeSequence(cause('db-01', 'down', ['api-03']))).toEqual(['db-01', 'api-03'])
    expect(causeSequence(cause('cache-02', 'degraded', ['cache-02', 'api-03']))).toEqual(['cache-02', 'api-03'])
  })

  it('mappa vuota: solo il servizio, nessun arco', () => {
    const l = layoutServiceMap('svc', [], [], [])
    expect(l.levels).toEqual([0])
    expect(l.nodes).toHaveLength(1)
    expect(l.edges).toEqual([])
    expect(l.collapsed).toEqual([])
  })

  it('una causa il cui percorso non arriva al livello 1: il servizio è comunque sul percorso, ma nessun arco viene inventato', () => {
    // il capo del percorso è a livello 2: non c'è adiacenza col servizio da disegnare
    const l = layoutServiceMap('svc', NODES, EDGES, [cause('san-01', 'down', ['db-01'])])
    expect(l.nodes.find((p) => p.id === 'svc')!.onPath).toBe('down')
    expect(l.edges.find((x) => x.source === 'svc')!.highlight).toBeNull()
    expect(l.edges.filter((x) => x.source === 'svc')).toHaveLength(1)     // solo REALIZES verso api-03
  })

  it('due archi fra la stessa coppia con relType diversi: tutti e due disegnati, il percorso evidenzia entrambi', () => {
    const l = layoutServiceMap('svc', NODES, [...EDGES, e('api-03', 'db-01', 'HOSTED_ON')], [cause('db-01', 'down', ['api-03'])])
    const pair = l.edges.filter((x) => x.source === 'api-03' && x.target === 'db-01')
    expect(pair.map((x) => x.relType).sort()).toEqual(['DEPENDS_ON', 'HOSTED_ON'])
    expect(pair.every((x) => x.highlight === 'down')).toBe(true)
    expect(new Set(pair.map((x) => x.key)).size).toBe(2)                  // chiavi distinte: React non si lamenta
  })

  it('un `via` che punta a un nodo non incluso non rompe l\'ordine: il nodo resta sulla sua riga', () => {
    const l = layoutServiceMap('svc', [n('api-03', 1, null), n('orfano', 2, 'sparito'), n('db-01', 2, 'api-03')], [], [])
    const row2 = l.nodes.filter((p) => p.level === 2).map((p) => p.id)
    expect(row2).toHaveLength(2)
    expect(row2).toContain('orfano')
    expect(l.nodes.find((p) => p.id === 'orfano')!.x).toBeGreaterThan(l.nodes.find((p) => p.id === 'db-01')!.x)  // senza predecessore va in fondo
  })
})

/** C-9: la mappa alla scala vera — il servizio dev'essere nel primo schermo. */
describe('layoutServiceMap alla scala', () => {
  const wide = (count: number) => Array.from({ length: count }, (_, i) => n(`srv-${String(i).padStart(3, '0')}`, 2, 'api-03'))
  const rootX = (l: ReturnType<typeof layoutServiceMap>) => l.nodes.find((p) => p.node === null)!.x

  it('righe allineate a sinistra: con 8 e con 120 nodi su un livello il servizio resta in alto a sinistra', () => {
    for (const count of [8, 120]) {
      const l = layoutServiceMap('svc', [n('api-03', 1, null), ...wide(count)], [], [])
      expect(rootX(l)).toBe(PAD)                               // primo posto della riga, non il centro della riga più larga
      expect(l.nodes.find((p) => p.id === 'api-03')!.x).toBe(PAD)
      // la colonna delle etichette sta FUORI dall'area che scorre: non entra nelle coordinate
      expect(l.width).toBe(PAD * 2 + count * NODE_W + (count - 1) * GAP_X)
    }
  })

  it('«Isola»: resta solo la catena del componente — lui, i suoi antenati e i suoi discendenti', () => {
    const nodes = [n('api-03', 1, null), n('db-01', 2, 'api-03'), n('cache-02', 2, 'api-03'), n('san-01', 3, 'db-01'), n('disk-9', 4, 'san-01'), n('altro', 1, null)]
    const l = layoutServiceMap('svc', nodes, EDGES, [], { isolate: 'db-01' })
    const ids = l.nodes.filter((p) => p.node !== null).map((p) => p.id).sort()
    expect(ids).toEqual(['api-03', 'db-01', 'disk-9', 'san-01'])   // antenato, lui, discendenti; niente fratelli né altri rami
    expect(l.nodes.find((p) => p.node === null)).toBeDefined()     // il servizio resta: è la radice
    expect(l.collapsed).toEqual([])                                 // isolando non ci sono chip: il nascondere è la richiesta
    // gli archi verso i nodi fuori catena spariscono con loro
    expect(l.edges.every((x) => [...ids, 'svc'].includes(x.source) && [...ids, 'svc'].includes(x.target))).toBe(true)
  })

  it('«Isola»: le righe rimaste sono compattate, un id sconosciuto non nasconde nulla, un `via` circolare non blocca', () => {
    const nodes = [n('api-03', 1, null), n('db-01', 2, 'api-03'), n('san-01', 3, 'db-01')]
    // livello 2 fuori catena → la riga sparisce e le altre si compattano
    const only = layoutServiceMap('svc', [...nodes, n('solo', 2, null)], [], [], { isolate: 'solo' })
    expect(only.levels).toEqual([0, 2])
    expect(only.nodes.filter((p) => p.node !== null).map((p) => p.id)).toEqual(['solo'])

    const unknown = layoutServiceMap('svc', nodes, [], [], { isolate: 'non-esiste' })
    expect(unknown.nodes).toHaveLength(nodes.length + 1)

    const loop = [n('a', 1, 'b'), n('b', 2, 'a')]
    expect(layoutServiceMap('svc', loop, [], [], { isolate: 'a' }).nodes.filter((p) => p.node !== null).map((p) => p.id).sort()).toEqual(['a', 'b'])
  })

  it('modalità percorso: restano le cause, i loro antenati e i fratelli diretti; il resto in un chip per livello', () => {
    const nodes = [n('api-03', 1, null), n('db-01', 2, 'api-03', { health: 'down' }), ...wide(119)]
    const causes = [cause('db-01', 'down', ['api-03'])]
    const full = layoutServiceMap('svc', nodes, [], causes)
    expect(full.nodes.filter((p) => p.level === 2)).toHaveLength(120)
    expect(full.collapsed).toEqual([])

    const focused = layoutServiceMap('svc', nodes, [], causes, { focus: true })
    const row2 = focused.nodes.filter((p) => p.level === 2)
    expect(row2.map((p) => p.id)).toContain('db-01')                 // la causa non sparisce mai
    expect(row2.length).toBeLessThanOrEqual(FOCUS_ROW_MAX + 1)
    const chip = focused.collapsed.find((c) => c.level === 2)!
    expect(chip.count).toBe(120 - row2.length)
    expect(chip.ids).not.toContain('db-01')
    expect(chip.x).toBe(PAD + row2.length * (NODE_W + GAP_X))
    expect(focused.width).toBeGreaterThanOrEqual(chip.x + CHIP_W)
    expect(focused.width).toBeLessThan(full.width)                   // è il punto: la riga si legge
    // il livello 1 (antenato) resta per intero
    expect(focused.nodes.filter((p) => p.level === 1).map((p) => p.id)).toEqual(['api-03'])
  })

  it('modalità percorso: un livello espanso torna intero, e il nodo da tenere (il selezionato) non finisce mai nel chip', () => {
    const nodes = [n('api-03', 1, null), n('db-01', 2, 'api-03', { health: 'down' }), ...wide(119)]
    const causes = [cause('db-01', 'down', ['api-03'])]
    const expanded = layoutServiceMap('svc', nodes, [], causes, { focus: true, expanded: new Set([2]) })
    expect(expanded.nodes.filter((p) => p.level === 2)).toHaveLength(120)
    expect(expanded.collapsed).toEqual([])

    const kept = layoutServiceMap('svc', nodes, [], causes, { focus: true, keep: new Set(['srv-118']) })
    expect(kept.nodes.map((p) => p.id)).toContain('srv-118')
    expect(kept.collapsed[0]!.ids).not.toContain('srv-118')
  })
})
