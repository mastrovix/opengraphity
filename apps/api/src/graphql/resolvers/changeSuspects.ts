/**
 * THE FIRST SUSPECTS OF AN INCIDENT (owner, 25 Sep 2026): the changes on the
 * CIs it affects that were being released when it opened, or whose release
 * ended in the tenant's recent-changes window before it opened.
 *
 * Read from the step history — when the change entered its release step and
 * when it left it — because the Change node has no planned window of its own
 * (the windows are per CI, on the deploy plan). The release step is the one
 * whose purpose is `implementation`, whatever the tenant calls it.
 *
 * Shown, never linked: the only link between an incident and a change is
 * «resolved by», and a suspect is not that. As for the release window of the
 * alarms (services/events/suppression.ts): a tenant with no change workflow has
 * nothing to suspect; a change workflow with no release step is incomplete
 * configuration, and it is said.
 */
import { runQuery, runQueryOne } from '@opengraphity/neo4j'
import type { GraphQLContext } from '../../context.js'
import { withSession } from './ci-utils.js'
import { NotFoundError, ValidationError } from '../../lib/errors.js'
import { getStepNamesByPurpose, getWorkflowSteps } from '../../lib/workflowHelpers.js'
import { impactAnalysisWeights } from '../../lib/impactWeights.js'

const DAY_MS = 86_400_000

type Props = Record<string, unknown>

export interface ChangeSuspect {
  id: string
  code: string
  title: string
  status: string
  runningAtOpening: boolean
  releasedAt: string | null
  cis: Array<{ id: string; name: string }>
}

async function incidentChangeSuspects(_: unknown, args: { incidentId: string }, ctx: GraphQLContext): Promise<ChangeSuspect[]> {
  return withSession(async (session) => {
    const incident = await runQueryOne<{ openedAt: string }>(session,
      'MATCH (i:Incident {id: $incidentId, tenant_id: $tenantId}) RETURN i.created_at AS openedAt',
      { incidentId: args.incidentId, tenantId: ctx.tenantId })
    if (!incident) throw new NotFoundError('Incident', args.incidentId)
    const release = await getStepNamesByPurpose(session, ctx.tenantId, 'change', ['implementation'])
    if (release.length === 0) {
      if ((await getWorkflowSteps(session, ctx.tenantId, 'change')).length === 0) return []
      throw new ValidationError(
        'No step of the change workflow declares the «implementation» purpose: nothing says when a change was being released, '
        + 'so no change can be matched to an incident. Give the purpose to the release step, in the workflow designer.',
        { key: 'errors.change.noImplementationStep' },
      )
    }
    const { recentChangesDays } = await impactAnalysisWeights(ctx.tenantId)
    const since = new Date(Date.parse(incident.openedAt) - recentChangesDays * DAY_MS).toISOString()
    // Each release step a change entered before the incident opened: running then if it had not left it yet.
    const rows = await runQuery<{ props: Props; cis: Array<{ id: string; name: string }>; running: boolean; lastEnd: string | null }>(session, `
      MATCH (i:Incident {id: $incidentId, tenant_id: $tenantId})-[:AFFECTED_BY]->(ci:ConfigurationItem {tenant_id: $tenantId})<-[:AFFECTS_CI]-(c:Change {tenant_id: $tenantId})
      WHERE coalesce(c.deleted, false) = false
      MATCH (c)-[:HAS_WORKFLOW]->(wi:WorkflowInstance {tenant_id: $tenantId})-[:STEP_HISTORY]->(e:WorkflowStepExecution)
      WHERE e.step_name IN $release AND e.entered_at <= $openedAt
      WITH c, collect(DISTINCT {id: ci.id, name: ci.name}) AS cis,
           max(CASE WHEN e.exited_at IS NULL OR e.exited_at >= $openedAt THEN 1 ELSE 0 END) = 1 AS running,
           max(e.exited_at) AS lastEnd
      WHERE running OR lastEnd >= $since
      RETURN properties(c) AS props, cis, running, lastEnd
      ORDER BY running DESC, lastEnd DESC
      LIMIT 20`,
    { incidentId: args.incidentId, tenantId: ctx.tenantId, openedAt: incident.openedAt, since, release })
    return rows.map((r) => ({
      id:               r.props['id'] as string,
      code:             (r.props['code'] ?? r.props['number'] ?? '') as string,
      title:            r.props['title'] as string,
      status:           (r.props['status'] ?? '') as string,
      runningAtOpening: r.running,
      releasedAt:       r.running ? null : r.lastEnd,
      cis:              [...r.cis].sort((a, b) => a.name.localeCompare(b.name)),
    }))
  })
}

export const changeSuspectResolvers = {
  Query: { incidentChangeSuspects },
}
