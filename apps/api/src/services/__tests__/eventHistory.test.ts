/**
 * services/events/history.ts — cronologia dell'allarme: il frammento
 * `historyWriteCypher` (CREATE dentro un FOREACH condizionale + cap nello
 * stesso statement, mai la first_seen), i parametri `$history*`
 * (`historyParams`: id nuovo, default monitoring/now, outcome solo su
 * correlated), `appendEventHistory` (statement scoped per tenant, evento
 * assente → errore). I punti di scrittura dentro ingest/pipeline/mutation sono
 * pinnati nei rispettivi test (eventService, eventCorrelation, events).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn() }))

const { EVENT_HISTORY_MAX, HISTORY_FIELD_PARAMS, historyWriteCypher, historyParams, appendEventHistory } = await import('../events/history.js')
const { EVENT_HISTORY_KINDS, EVENT_SDL_ENUMS } = await import('../../lib/eventVocabularies.js')
const { runQueryOne } = await import('@opengraphity/neo4j')

const session = { close: vi.fn() }
const NOW = '2026-09-10T10:00:00.000Z'

beforeEach(() => vi.clearAllMocks())

describe('historyWriteCypher', () => {
  it('CREATE (e)-[:HAS_HISTORY]->(:EventHistoryEntry {…}) con tenant_id ed event_id, dentro un FOREACH condizionale; per default tutti i campi dai parametri $history*', () => {
    const q = historyWriteCypher()
    expect(q).toMatch(/^FOREACH \(_ IN CASE WHEN true THEN \[1\] ELSE \[\] END \|\s+CREATE \(e\)-\[:HAS_HISTORY\]->\(:EventHistoryEntry \{/)
    expect(q).toContain('id: $historyId, tenant_id: $tenantId, event_id: e.id, at: $historyAt, kind: $historyKind, outcome: $historyOutcome,')
    expect(q).toContain('actor_id: $historyActorId, incident_id: $historyIncidentId, change_id: $historyChangeId, ci_id: $historyCiId, note: $historyNote, severity: $historySeverity})')
    expect(Object.values(HISTORY_FIELD_PARAMS).every((p) => q.includes(p))).toBe(true)
  })

  it('cap nello STESSO statement: unit subquery che cancella le voci oltre EVENT_HISTORY_MAX (dalla più vecchia, per at poi id), mai la first_seen, solo se la voce è stata scritta; WITH * conserva lo scope', () => {
    expect(EVENT_HISTORY_MAX).toBe(200)
    const q = historyWriteCypher({ when: 'previous <> $correlation', imports: ['previous'] })
    expect(q).toContain('FOREACH (_ IN CASE WHEN previous <> $correlation THEN [1] ELSE [] END |')
    expect(q).toMatch(/\)\s+WITH \*\s+CALL \{\s+WITH e, previous\s+UNWIND CASE WHEN previous <> \$correlation THEN \[1\] ELSE \[\] END AS _\s+MATCH \(e\)-\[:HAS_HISTORY\]->\(old:EventHistoryEntry \{tenant_id: \$tenantId\}\)\s+WHERE old\.kind <> 'first_seen'\s+WITH old ORDER BY old\.at DESC, old\.id DESC\s+SKIP 199\s+DETACH DELETE old\s+\}$/)
    expect(q).not.toMatch(/RETURN/)
    // senza import: solo `e` entra nel CALL
    expect(historyWriteCypher()).toMatch(/CALL \{\s+WITH e\s+UNWIND CASE WHEN true/)
  })

  it('campi come espressioni Cypher (ingest: kind/at/note calcolati, severità dal payload) al posto dei parametri', () => {
    const q = historyWriteCypher({ when: 'historyKind IS NOT NULL', imports: ['historyKind'], fields: { kind: 'historyKind', at: "CASE WHEN historyKind = 'first_seen' THEN $firstSeenAt ELSE $now END", severity: '$severity', outcome: 'null', actorId: "'monitoring'" } })
    expect(q).toContain("at: CASE WHEN historyKind = 'first_seen' THEN $firstSeenAt ELSE $now END, kind: historyKind, outcome: null,")
    expect(q).toContain("actor_id: 'monitoring', incident_id: $historyIncidentId")
    expect(q).toContain('severity: $severity})')
    expect(q).toContain('WITH e, historyKind\n')
  })
})

describe('historyParams', () => {
  it('id nuovo a ogni chiamata; default: at = now, attore monitoring, tutto il resto null', () => {
    const a = historyParams({ kind: 'acknowledged', actorId: 'u-1' }, NOW)
    const b = historyParams({ kind: 'acknowledged', actorId: 'u-1' }, NOW)
    expect(a).toEqual({ historyId: expect.any(String), historyKind: 'acknowledged', historyAt: NOW, historyOutcome: null, historyActorId: 'u-1', historyIncidentId: null, historyChangeId: null, historyCiId: null, historyNote: null, historySeverity: null })
    expect(a['historyId']).not.toBe(b['historyId'])
    expect(historyParams({ kind: 'first_seen', at: 'T0', severity: 'critical' }, NOW)).toMatchObject({ historyAt: 'T0', historyActorId: 'monitoring', historySeverity: 'critical' })
    expect(historyParams({ kind: 'correlated', outcome: 'attached', incidentId: 'inc-1' }, NOW)).toMatchObject({ historyOutcome: 'attached', historyIncidentId: 'inc-1' })
  })

  it('outcome ammesso solo su correlated: su un altro kind è un errore di programmazione, non un dato salvato', () => {
    expect(() => historyParams({ kind: 'storm', outcome: 'storm' }, NOW)).toThrow(/Event history entry storm cannot carry a correlation outcome \(storm\)/)
  })

  it('vocabolario: EVENT_HISTORY_KINDS è la tabella del contratto ed è l\'enum SDL EventHistoryKind', () => {
    expect([...EVENT_HISTORY_KINDS]).toEqual(['first_seen', 'cycle_firing', 'cycle_resolved', 'severity_changed', 'correlated', 'suppressed', 'unsuppressed', 'flapping', 'stable', 'storm', 'auto_resolved', 'auto_resolve_skipped', 'acknowledged', 'resolved_manually', 'linked_ci', 'incident_opened_manually', 'reevaluated'])
    expect(EVENT_SDL_ENUMS['EventHistoryKind']).toBe(EVENT_HISTORY_KINDS)
  })
})

describe('appendEventHistory', () => {
  it('UN statement nella sessione del chiamante: MATCH scoped per tenant + frammento + RETURN; parametri $history*', async () => {
    vi.mocked(runQueryOne).mockResolvedValueOnce({ id: 'ev-1' } as never)
    await appendEventHistory(session as never, 't1', 'ev-1', { kind: 'auto_resolved', incidentId: 'inc-1', note: 'passando per Assegnato' }, NOW)
    expect(runQueryOne).toHaveBeenCalledTimes(1)
    const [s, cypher, params] = vi.mocked(runQueryOne).mock.calls[0]!
    expect(s).toBe(session)
    expect(cypher).toMatch(/MATCH \(e:Event \{id: \$eventId, tenant_id: \$tenantId\}\)\s+FOREACH \(_ IN CASE WHEN true THEN \[1\] ELSE \[\] END \|/)
    expect(cypher).toContain(historyWriteCypher())
    expect(cypher).toMatch(/DETACH DELETE old\s+\}\s+RETURN e\.id AS id/)
    expect(params).toMatchObject({ eventId: 'ev-1', tenantId: 't1', historyKind: 'auto_resolved', historyIncidentId: 'inc-1', historyNote: 'passando per Assegnato', historyAt: NOW, historyActorId: 'monitoring' })
    expect(session.close).not.toHaveBeenCalled()   // la sessione è del chiamante
  })

  it('evento assente → errore esplicito (mai una voce nel vuoto o saltata in silenzio); now predefinito = adesso', async () => {
    vi.mocked(runQueryOne).mockResolvedValueOnce(null as never)
    await expect(appendEventHistory(session as never, 't1', 'ev-x', { kind: 'reevaluated', actorId: 'u-1' })).rejects.toThrow(/Event ev-x not found while appending history entry reevaluated \(tenant t1\)/)
    const at = vi.mocked(runQueryOne).mock.calls[0]![2]!['historyAt'] as string
    expect(Math.abs(Date.now() - Date.parse(at))).toBeLessThan(5_000)
  })
})
