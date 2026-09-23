/**
 * THE REQUESTER CONFIRMS THE RESOLUTION (tour of 23 Sep 2026, D51).
 *
 * The factory incident workflows left «resolved» for «closed» only through
 * the 72-hour timer: nobody could say «yes, it works» and close sooner, so
 * every resolved incident waited exactly three days — the daily-work page
 * showed the step «resolved» at 72.01 hours for 1,957 incidents out of 1,958.
 * The factory now has a manual move, «Confirm resolution», which the portal
 * offers to the requester (`confirmTicketResolution`) and the ticket page to
 * the desk. The timer stays: it closes the incidents nobody confirms.
 *
 * Added where the workflow still has the factory shape: a step of category
 * `resolved` that the timer takes to a step of category `closed`, and no
 * manual move between the two. A workflow the customer redesigned — the timer
 * removed, a manual close of their own — is left as it is. Idempotent: the
 * second run finds the manual move and adds nothing.
 */
import type { Migration } from '@opengraphity/neo4j'

export const incidentConfirmResolution: Migration = {
  id: '20261008_1010_incident_confirm_resolution',
  description: 'Tour of 23 Sep 2026 (D51): the incident workflows with the factory 72-hour close get a manual «Confirm resolution» from resolved to closed',
  async up(session) {
    const res = await session.run(`
      MATCH (wd:WorkflowDefinition {entity_type: 'incident'})-[:HAS_STEP]->(r:WorkflowStep {category: 'resolved'})
      MATCH (r)-[:TRANSITIONS_TO {trigger: 'timer'}]->(c:WorkflowStep {category: 'closed'})
      WHERE (wd)-[:HAS_STEP]->(c) AND NOT (r)-[:TRANSITIONS_TO {trigger: 'manual'}]->(c)
      CREATE (r)-[:TRANSITIONS_TO {
        id: wd.id + '-tr-resolved-closed-confirmed', trigger: 'manual', label: 'Confirm resolution',
        labels: '{"it":"Conferma la risoluzione"}', condition: null, requires_input: false, input_field: null
      }]->(c)
      RETURN wd.tenant_id AS tenant, wd.name AS definition, r.name AS fromStep, c.name AS toStep
      ORDER BY tenant, definition
    `)
    for (const r of res.records) {
      console.log(`[${incidentConfirmResolution.id}] ${String(r.get('tenant'))} / "${String(r.get('definition'))}" / ${String(r.get('fromStep'))} → ${String(r.get('toStep'))}: «Confirm resolution» added`)
    }
    console.log(`[${incidentConfirmResolution.id}] ${String(res.records.length)} workflows can now be closed by the requester's confirmation`)
  },
}
