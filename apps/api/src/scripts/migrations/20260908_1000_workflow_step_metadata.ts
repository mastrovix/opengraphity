/**
 * Populates is_initial / is_terminal / is_open / category / step_order on
 * every WorkflowStep (formerly the one-shot script migrate-workflow-metadata).
 *
 * Rules:
 *   - step.type = 'start' → is_initial true
 *   - step.type = 'end' or name in TERMINAL_NAMES → is_terminal true, is_open false
 *   - otherwise → is_open true
 *   - category from the step name (CATEGORY_MAP), step_order from STEP_ORDER
 *
 * Idempotent (overwrites the same values): re-runnable with `--force` through
 * `migrate:workflow-metadata` for workflows seeded with old data.
 */
import type { Migration } from '@opengraphity/neo4j'

const TERMINAL_NAMES = ['resolved', 'closed', 'completed', 'rejected', 'failed']

const CATEGORY_MAP: Record<string, string> = {
  new:                 'active',
  assigned:            'active',
  in_progress:         'active',
  pending:             'waiting',
  escalated:           'escalated',
  assessment:          'active',
  approval:            'waiting',
  cab_approval:        'waiting',
  emergency_approval:  'waiting',
  scheduled:           'waiting',
  draft:               'draft',
  security_review:     'active',
  deployment:          'active',
  validation:          'active',
  review:              'active',
  published:           'published',
  archived:            'closed',
  pending_review:      'waiting',
  resolved:            'resolved',
  closed:              'closed',
  completed:           'closed',
  rejected:            'failed',
  failed:              'failed',
  post_review:         'closed',
}

/** Suggested step_order per entity_type; unknown names fall back to 99 (bottom of the list). */
const STEP_ORDER: Record<string, Record<string, number>> = {
  change: {
    assessment: 1, approval: 2, scheduled: 3, deployment: 4, review: 5, closed: 6,
  },
  incident: {
    new: 1, assigned: 2, security_review: 3, in_progress: 4, pending: 5,
    escalated: 6, resolved: 7, closed: 8,
  },
  problem: {
    new: 1, under_investigation: 2, change_requested: 3, change_in_progress: 4,
    resolved: 5, deferred: 6, rejected: 7, closed: 8,
  },
  kb_article: {
    draft: 1, pending_review: 2, published: 3, archived: 4,
  },
  service_request: {
    new: 1, assigned: 2, in_progress: 3, pending: 4, resolved: 5, closed: 6,
  },
}

export const workflowStepMetadata: Migration = {
  id: '20260908_1000_workflow_step_metadata',
  description: 'WorkflowStep: is_initial/is_terminal/is_open/category/step_order from type and name',
  async up(session) {
    const res = await session.run(`
      MATCH (wd:WorkflowDefinition)-[:HAS_STEP]->(s:WorkflowStep)
      WITH wd, s, s.name AS n, s.type AS t
      WITH wd, s, n, t,
           (t = 'start')                                                AS isInitial,
           (t = 'end'  OR n IN $terminalNames)                          AS isTerminal,
           coalesce($stepOrder[wd.entity_type][n], 99)                  AS stepOrd
      SET s.is_initial  = isInitial,
          s.is_terminal = isTerminal,
          s.is_open     = NOT isTerminal,
          s.category    = coalesce($categoryMap[n], CASE WHEN isTerminal THEN 'closed' ELSE 'active' END),
          s.step_order  = stepOrd
      RETURN count(s) AS updated
    `, { terminalNames: TERMINAL_NAMES, categoryMap: CATEGORY_MAP, stepOrder: STEP_ORDER })
    console.log(`[${workflowStepMetadata.id}] updated ${String(res.records[0]?.get('updated') ?? 0)} WorkflowStep nodes`)
  },
}
