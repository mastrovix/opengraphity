/**
 * Tour of 24 Sep 2026 (G16): the factory arc of the incident from «Assigned»
 * to «In Progress» was called «Take charge» / «Prendi in carico», and it
 * promised «I take it» — pressed by someone else, the incident moved on and
 * stayed with its assignee. The arc starts the work: it is called so now,
 * «Start work» / «Inizia la lavorazione».
 *
 * Only where the label is still the factory one: a label the customer wrote
 * in the designer stays as it is, and the count says so. Idempotent.
 */
import type { Migration } from '@opengraphity/neo4j'

export const incidentStartWorkLabel: Migration = {
  id: '20261011_1030_incident_start_work_label',
  description: 'Incident factory arc assigned → in_progress: «Take charge» becomes «Start work» where not customized',
  async up(session) {
    const res = await session.run(`
      MATCH (wd:WorkflowDefinition {entity_type: 'incident'})-[:HAS_STEP]->(a:WorkflowStep {name: 'assigned'})
      MATCH (a)-[tr:TRANSITIONS_TO {trigger: 'manual'}]->(b:WorkflowStep {name: 'in_progress'})
      WHERE b.definition_id = a.definition_id
      WITH tr, tr.label IN ['Take charge', 'Prendi in carico'] AS factory
      FOREACH (_ IN CASE WHEN factory THEN [1] ELSE [] END |
        SET tr.label = 'Start work', tr.labels = '{"it":"Inizia la lavorazione"}')
      RETURN sum(CASE WHEN factory THEN 1 ELSE 0 END) AS updated, sum(CASE WHEN factory THEN 0 ELSE 1 END) AS customized
    `)
    const n = (k: string) => Number(res.records[0]?.get(k) ?? 0)
    console.log(`[${incidentStartWorkLabel.id}] updated ${n('updated')}, left as the customer wrote them ${n('customized')}`)
  },
}
