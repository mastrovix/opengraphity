/**
 * INDEXED LOOKUPS BY ID: what `matchById` writes (D25, tour of 23 Sep 2026).
 *
 * The point of the helper is that every branch names a label, so that Neo4j
 * can seek the id index instead of reading every node: these tests pin the
 * shape of the Cypher, and that nothing unsafe can be interpolated into it.
 */
import { describe, expect, it } from 'vitest'
import { matchById, TICKET_NODE_LABELS, WORKFLOW_ENTITY_NODE_LABELS } from '../cypherLookups.js'

describe('matchById', () => {
  it('looks the four ticket labels up by default, one labelled branch each', () => {
    expect(matchById('e', { id: '$entityId' })).toBe(
      'CALL () { MATCH (e:Incident {id: $entityId, tenant_id: $tenantId}) RETURN e'
      + ' UNION MATCH (e:Problem {id: $entityId, tenant_id: $tenantId}) RETURN e'
      + ' UNION MATCH (e:Change {id: $entityId, tenant_id: $tenantId}) RETURN e'
      + ' UNION MATCH (e:ServiceRequest {id: $entityId, tenant_id: $tenantId}) RETURN e }',
    )
    expect(TICKET_NODE_LABELS).toEqual(['Incident', 'Problem', 'Change', 'ServiceRequest'])
  })

  it("'entities' adds the KB article, which also has a workflow", () => {
    expect(WORKFLOW_ENTITY_NODE_LABELS).toContain('KBArticle')
    const q = matchById('e', { labels: 'entities', id: '$entityId' })
    for (const label of WORKFLOW_ENTITY_NODE_LABELS) expect(q).toContain(`(e:${label} {id: $entityId, tenant_id: $tenantId})`)
  })

  it('imports outer variables, can be optional, and can leave the tenant out for globally unique ids', () => {
    expect(matchById('entity', { labels: ['Incident'], id: 'wi.entity_id', imports: ['wi'], optional: true }))
      .toBe('OPTIONAL CALL (wi) { MATCH (entity:Incident {id: wi.entity_id, tenant_id: $tenantId}) RETURN entity }')
    expect(matchById('t', { labels: ['AssessmentTask', 'DeployPlanTask'], id: 'tid', tenant: null, imports: ['tid'] }))
      .toBe('CALL (tid) { MATCH (t:AssessmentTask {id: tid}) RETURN t UNION MATCH (t:DeployPlanTask {id: tid}) RETURN t }')
    expect(matchById('e', { labels: ['Incident'], tenant: '$t' })).toContain('{id: $id, tenant_id: $t}')
  })

  it('refuses anything that is not an identifier where it would be interpolated', () => {
    expect(() => matchById('e) DETACH DELETE (x', { labels: ['Incident'] })).toThrow(/invalid variable/)
    expect(() => matchById('e', { labels: ['Incident) DETACH DELETE (x'] })).toThrow(/invalid label/)
    expect(() => matchById('e', { labels: [] })).toThrow(/at least one label/)
    expect(() => matchById('e', { imports: ['wi, x'] })).toThrow(/invalid imported variable/)
  })
})
