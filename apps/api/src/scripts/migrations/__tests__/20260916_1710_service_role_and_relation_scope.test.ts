/**
 * Migrazione 20260916_1710: `service_role` sui tipi CI che non lo dichiarano
 * (dal seme dei tipi spediti, altrimenti dalle famiglie di catena) e
 * `tenant_id`/`scope` sulle definizioni di relazione che non ne avevano
 * (ondata 6 · A-10 / C-3).
 *
 * Va PRIMA del codice nuovo: aperto il filtro delle etichette al metamodello
 * del tenant, un tipo senza ruolo farebbe fallire la costruzione della mappa.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { serviceRoleAndRelationScope } from '../20260916_1710_service_role_and_relation_scope.js'
import { MIGRATIONS } from '../index.js'
import { ROLE_BY_CI_LABEL } from '../../../lib/serviceVocabularies.js'

type Row = Record<string, unknown>

function fakeSession(roles: Row[] = [], rels: Row[] = [], orphans = 0) {
  const calls: Array<{ cypher: string; params: Record<string, unknown> | undefined }> = []
  return {
    calls,
    run: vi.fn(async (cypher: string, params?: Record<string, unknown>) => {
      calls.push({ cypher, params })
      const rows = cypher.includes('NOT EXISTS') ? [{ n: orphans }]
        : cypher.includes('t.service_role IS NULL') ? roles
        : rels
      return { records: rows.map((r) => ({ get: (k: string) => r[k] })) }
    }),
  }
}

describe('20260916_1710_service_role_and_relation_scope', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('registrata in coda (dopo l\'ultima dell\'ondata 5), id nel formato, nessun autocommit', () => {
    const ids = MIGRATIONS.map((m) => m.id)
    expect(ids).toContain('20260916_1710_service_role_and_relation_scope')
    expect(ids.indexOf('20260916_1710_service_role_and_relation_scope'))
      .toBeGreaterThan(ids.indexOf('20260914_1520_step_entered_notification_rules'))
    expect(serviceRoleAndRelationScope.id).toMatch(/^\d{8}_\d{4}_[a-z0-9_]+$/)
    expect(serviceRoleAndRelationScope.autocommit).toBeUndefined()
  })

  it('scrive il ruolo SOLO dove manca, dal seme o dalle famiglie di catena, e salta ITIL e __base__', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const s = fakeSession([{ name: 'server', tenantId: 'system', role: 'infrastructure', fromSeed: true }])
    await serviceRoleAndRelationScope.up(s as never)
    const q = s.calls[0]!
    expect(q.cypher).toContain('WHERE t.service_role IS NULL')
    expect(q.cypher).toContain("AND t.name <> '__base__'")
    expect(q.cypher).toContain("AND coalesce(t.scope, 'base') <> 'itil'")
    expect(q.cypher).toContain('WHEN seeded IS NOT NULL THEN seeded')
    expect(q.cypher).toContain('WHEN t.chain_families = \'["Application"]\' THEN \'component\'')
    expect(q.cypher).toContain("ELSE 'infrastructure'")
    // il seme viaggia come PARAMETRO (mai interpolato) ed è la tabella dei tipi spediti
    expect(q.params).toEqual({ seed: ROLE_BY_CI_LABEL })
    expect(ROLE_BY_CI_LABEL['Certificate']).toBe('certificate')
  })

  it('il proprietario di una definizione di relazione viene dal TIPO che la possiede, solo dove manca', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const s = fakeSession([], [{ typeName: 'load_balancer', relName: 'bilancia', relType: 'BILANCIA', tenantId: 'c-two' }])
    await serviceRoleAndRelationScope.up(s as never)
    const q = s.calls[1]!
    expect(q.cypher).toContain('MATCH (t:CITypeDefinition)-[:HAS_RELATION]->(r:CIRelationDefinition)')
    expect(q.cypher).toContain('WHERE r.tenant_id IS NULL OR r.scope IS NULL')
    expect(q.cypher).toContain('SET r.tenant_id = coalesce(r.tenant_id, t.tenant_id)')
    expect(q.cypher).toContain("CASE WHEN t.scope = 'tenant' THEN 'tenant' ELSE 'base' END")
  })

  it('una definizione orfana non si indovina: si conta e si dice', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await serviceRoleAndRelationScope.up(fakeSession([], [], 3) as never)
    expect(log.mock.calls.flat().join(' ')).toMatch(/3 CIRelationDefinition senza tenant_id/)
  })

  it('database già a posto: niente da scrivere, e lo dice (idempotente)', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await serviceRoleAndRelationScope.up(fakeSession([], [], 0) as never)
    const out = log.mock.calls.flat().join(' ')
    expect(out).toMatch(/nessun tipo CI senza service_role/)
    expect(out).toMatch(/nessuna definizione di relazione senza proprietario/)
  })
})
