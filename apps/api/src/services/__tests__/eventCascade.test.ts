/**
 * services/events/cascade.ts — la politica delle cancellazioni (revisione 2 ·
 * D4.1, D4.3): eliminare una sorgente chiude i suoi allarmi accesi nella stessa
 * transazione e rimette a posto salute e incident dopo il commit; eliminare un
 * CI o una mappa di servizio lascia gli incident aperti ma con un commento che
 * dice perché nessuno li chiuderà più.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn() }))
vi.mock('../../lib/logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => child } }
})
vi.mock('../incidentService.js', () => ({ addIncidentComment: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../events/ciHealth.js', () => ({ recomputeCIHealth: vi.fn().mockResolvedValue('operational') }))
vi.mock('../events/pipeline.js', () => ({ runEventPipeline: vi.fn().mockResolvedValue({ outcome: 'auto_resolved', status: 'resolved', suppressedByChangeId: null, incidentId: 'inc-1' }) }))
vi.mock('../events/incidentWorkflow.js', () => ({
  incidentStepInfo: vi.fn(async () => ({ resolvedStep: 'resolved', terminalSteps: ['closed'] })),
}))

const cascade = await import('../events/cascade.js')
const {
  deleteSourceAndResolveEvents, noteIncidentsBeforeCIDeletion, noteServiceMapDeletion,
  findIncidentsLosingTheirOnlyCI, ciDeletedComment, serviceMapDeletedComment, SOURCE_DELETED_NOTE,
} = cascade
const { getSession, runQuery, runQueryOne } = await import('@opengraphity/neo4j')
const { recomputeCIHealth } = await import('../events/ciHealth.js')
const { runEventPipeline } = await import('../events/pipeline.js')
const incidentService = await import('../incidentService.js')

const session = { close: vi.fn().mockResolvedValue(undefined) }
const DELETE_RE = /MATCH \(w:InboundWebhook \{id: \$sourceId, tenant_id: \$tenantId\}\)/
const ONLY_CI_RE = /AFFECTED_BY\]->\(ci:ConfigurationItem \{id: \$ciId, tenant_id: \$tenantId\}\)/
const MAP_OF_CI_RE = /HAS_SERVICE_MAP\]->\(m:ServiceMap \{tenant_id: \$tenantId\}\)/
const MAP_INCIDENTS_RE = /IMPACTS_SERVICE\]->\(m:ServiceMap \{id: \$mapId, tenant_id: \$tenantId\}\)/

/** Dispatch dei mock per frammento di Cypher (l'ultima regola che combacia vince). */
function onCypher(rules: Array<[RegExp, unknown]>) {
  const impl = async (_s: unknown, cypher: string, params?: Record<string, unknown>) => {
    for (const [re, value] of [...rules].reverse()) if (re.test(cypher)) return typeof value === 'function' ? (value as (p?: Record<string, unknown>) => unknown)(params) : value
    throw new Error(`unexpected cypher in test:\n${cypher}`)
  }
  vi.mocked(runQueryOne).mockImplementation(impl as never)
  vi.mocked(runQuery).mockImplementation((async (s: unknown, c: string, p?: Record<string, unknown>) => { const r = await impl(s, c, p); return r == null ? [] : Array.isArray(r) ? r : [r] }) as never)
}
const calls = () => [...vi.mocked(runQueryOne).mock.calls, ...vi.mocked(runQuery).mock.calls].map(([, cypher, params]) => ({ cypher: cypher as string, params: params as Record<string, unknown> }))
const callMatching = (re: RegExp) => calls().find((c) => re.test(c.cypher))

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getSession).mockReturnValue(session as never)
})

describe('D4.1 — deleteInboundWebhook: la sorgente se ne va e i suoi allarmi rientrano', () => {
  it('3 allarmi accesi su 2 CI: risolti NELLA STESSA transazione della cancellazione (voce di cronologia, residui azzerati, correlazione invariata), poi salute dei CI e pipeline per la chiusura degli incident', async () => {
    onCypher([[DELETE_RE, { eventIds: ['ev-1', 'ev-2', 'ev-3'], ciIds: ['ci-1', 'ci-2'] }]])
    await expect(deleteSourceAndResolveEvents('t1', 'hook-1', 'adm-1')).resolves.toEqual({ deleted: true, resolvedEvents: 3, affectedCIs: 2 })

    const q = callMatching(DELETE_RE)!
    // una sola scrittura: risoluzione degli allarmi + DETACH DELETE della sorgente
    expect(calls()).toHaveLength(1)
    expect(q.cypher).toMatch(/OPTIONAL MATCH \(e:Event \{tenant_id: \$tenantId, source_id: \$sourceId\}\)\s+WHERE e\.status <> 'resolved'/)
    expect(q.cypher).toContain("SET e.status = 'resolved', e.resolved_at = $now, e.resolved_by = $actorId")
    expect(q.cypher).toContain('e.resolution_note = $note, e.suppressed_by_change_id = null, e.flapping_since = null')
    expect(q.cypher).not.toContain('e.correlation =')        // la correlazione resta: l'allarme è rientrato, non "de-correlato"
    expect(q.cypher).toContain('DETACH DELETE w')
    // una voce di cronologia per evento: id NUOVO a ogni riga (un solo $historyId violerebbe il vincolo di unicità)
    expect(q.cypher).toContain('CREATE (e)-[:HAS_HISTORY]->(:EventHistoryEntry {id: randomUUID()')
    expect(q.params).toMatchObject({ sourceId: 'hook-1', tenantId: 't1', actorId: 'adm-1', note: SOURCE_DELETED_NOTE, historyKind: 'resolved_manually', historyActorId: 'adm-1', historyNote: SOURCE_DELETED_NOTE })

    // dopo il commit: prima la salute di ogni CI toccato (una volta sola, con tutti gli allarmi già risolti), poi gli incident
    expect(vi.mocked(recomputeCIHealth).mock.calls).toEqual([['t1', 'ci-1', 'adm-1'], ['t1', 'ci-2', 'adm-1']])
    expect(vi.mocked(runEventPipeline).mock.calls.map(([a]) => a)).toEqual([
      expect.objectContaining({ tenantId: 't1', eventId: 'ev-1', actorId: 'adm-1', mode: 'reevaluate' }),
      expect.objectContaining({ eventId: 'ev-2' }),
      expect.objectContaining({ eventId: 'ev-3' }),
    ])
    expect(vi.mocked(recomputeCIHealth).mock.invocationCallOrder.at(-1)!).toBeLessThan(vi.mocked(runEventPipeline).mock.invocationCallOrder[0]!)
    expect(session.close).toHaveBeenCalled()
  })

  it('sorgente inesistente → deleted false, nessun ricalcolo e nessuna pipeline; sorgente senza allarmi accesi → deleted true con 0', async () => {
    onCypher([[DELETE_RE, null]])
    await expect(deleteSourceAndResolveEvents('t1', 'hook-x', 'adm-1')).resolves.toEqual({ deleted: false, resolvedEvents: 0, affectedCIs: 0 })
    expect(recomputeCIHealth).not.toHaveBeenCalled()
    expect(runEventPipeline).not.toHaveBeenCalled()

    onCypher([[DELETE_RE, { eventIds: [], ciIds: [] }]])
    await expect(deleteSourceAndResolveEvents('t1', 'hook-1', 'adm-1')).resolves.toEqual({ deleted: true, resolvedEvents: 0, affectedCIs: 0 })
    expect(recomputeCIHealth).not.toHaveBeenCalled()
  })

  it('riconciliazione fallita dopo il commit: gli altri eventi vengono comunque valutati e l\'errore propaga con il conteggio (fail-loud, la cancellazione resta)', async () => {
    onCypher([[DELETE_RE, { eventIds: ['ev-1', 'ev-2'], ciIds: ['ci-1'] }]])
    vi.mocked(runEventPipeline).mockRejectedValueOnce(new Error('Neo4j down'))
    await expect(deleteSourceAndResolveEvents('t1', 'hook-1', 'adm-1'))
      .rejects.toThrow(/source hook-1 was deleted and 2 alerts resolved, but 1 re-evaluations failed \(event ev-1\)/)
    expect(runEventPipeline).toHaveBeenCalledTimes(2)   // il fallimento del primo non ferma il secondo
  })
})

describe('D4.3 — commenti prima di una cancellazione a cascata', () => {
  it('CI eliminato che era l\'UNICO CI impattato di un incident aperto → un commento sull\'incident; con un altro CI impattato nessun commento', async () => {
    onCypher([[ONLY_CI_RE, [{ incidentId: 'inc-1', ciName: 'db-01' }]], [MAP_OF_CI_RE, null]])
    await noteIncidentsBeforeCIDeletion('t1', 'ci-1', session as never)
    const q = callMatching(ONLY_CI_RE)!
    // solo incident NON terminali, e solo quelli senza altri CI impattati
    expect(q.cypher).toContain('WHERE NOT wi.current_step IN $terminalSteps')
    expect(q.cypher).toMatch(/OPTIONAL MATCH \(i\)-\[:AFFECTED_BY\]->\(other:ConfigurationItem \{tenant_id: \$tenantId\}\)\s+WHERE other\.id <> \$ciId/)
    expect(q.cypher).toContain('WHERE others = 0')
    expect(q.params).toEqual({ tenantId: 't1', ciId: 'ci-1', terminalSteps: ['closed'] })
    expect(incidentService.addIncidentComment).toHaveBeenCalledWith('inc-1', expect.objectContaining({ tenantId: 't1', userId: 'monitoring' }), ciDeletedComment('db-01'))
    expect(ciDeletedComment('db-01')).toContain('"db-01"')

    vi.clearAllMocks()
    onCypher([[ONLY_CI_RE, []], [MAP_OF_CI_RE, null]])
    await noteIncidentsBeforeCIDeletion('t1', 'ci-1', session as never)
    expect(incidentService.addIncidentComment).not.toHaveBeenCalled()
  })

  it('BusinessApplication con una mappa: gli incident di servizio ancora aperti ricevono la nota della mappa eliminata', async () => {
    onCypher([[ONLY_CI_RE, []], [MAP_OF_CI_RE, { id: 'map-1' }], [MAP_INCIDENTS_RE, [{ incidentId: 'inc-svc', serviceName: 'Fatturazione' }]]])
    await noteIncidentsBeforeCIDeletion('t1', 'ba-1', session as never)
    expect(incidentService.addIncidentComment).toHaveBeenCalledWith('inc-svc', expect.objectContaining({ tenantId: 't1' }), serviceMapDeletedComment('Fatturazione'))
    expect(serviceMapDeletedComment('Fatturazione')).toMatch(/non è più monitorato/)
  })

  it('deleteServiceMap: un commento per incident aperto della mappa; nessun incident → nessun commento; un commento che fallisce non ferma la cancellazione', async () => {
    onCypher([[MAP_INCIDENTS_RE, [{ incidentId: 'inc-svc', serviceName: 'Fatturazione' }, { incidentId: 'inc-2', serviceName: 'Fatturazione' }]]])
    await expect(noteServiceMapDeletion('t1', 'map-1')).resolves.toBe(2)
    expect(incidentService.addIncidentComment).toHaveBeenCalledTimes(2)

    vi.clearAllMocks()
    onCypher([[MAP_INCIDENTS_RE, []]])
    await expect(noteServiceMapDeletion('t1', 'map-1')).resolves.toBe(0)
    expect(incidentService.addIncidentComment).not.toHaveBeenCalled()

    vi.clearAllMocks()
    onCypher([[MAP_INCIDENTS_RE, [{ incidentId: 'inc-svc', serviceName: 'Fatturazione' }]]])
    vi.mocked(incidentService.addIncidentComment).mockRejectedValueOnce(new Error('Incident sparito'))
    await expect(noteServiceMapDeletion('t1', 'map-1')).resolves.toBe(0)   // loggato, mai propagato
  })

  it('l\'incident senza nome del CI (proprietà mancante) usa l\'id: nessuna stringa inventata', async () => {
    onCypher([[ONLY_CI_RE, [{ incidentId: 'inc-1', ciName: null }]]])
    await expect(findIncidentsLosingTheirOnlyCI(session as never, 't1', 'ci-1')).resolves.toEqual({ ciName: 'ci-1', incidentIds: ['inc-1'] })
  })
})
