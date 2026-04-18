/**
 * One-shot migration: populate isInitial / isTerminal / isOpen / category
 * on every WorkflowStep that hasn't got them yet.
 *
 * Rules:
 *   - step.type = 'start' → isInitial true
 *   - step.type = 'end'   → isTerminal true, isOpen false
 *   - step.name IN ('resolved','closed','completed','rejected','failed') → isTerminal true, isOpen false
 *   - otherwise          → isOpen true
 *   - category derived from step name
 *
 * Idempotent: re-running the script overwrites the properties every time,
 * so it also works for workflows already seeded with old data.
 */

import neo4j from 'neo4j-driver'
import { getSession } from '@opengraphity/neo4j'

const TERMINAL_NAMES = new Set([
  'resolved', 'closed', 'completed', 'rejected', 'failed',
])

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

/**
 * Suggested `step_order` per entity_type. Missing names fall back to 99
 * (end of list) so they still render, just at the bottom.
 */
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

async function migrate() {
  const session = getSession(undefined, neo4j.session.WRITE)
  try {
    const result = await session.executeWrite(async (tx) => {
      const res = await tx.run(`
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
      `, {
        terminalNames: Array.from(TERMINAL_NAMES),
        categoryMap: CATEGORY_MAP,
        stepOrder: STEP_ORDER,
      })
      return res.records[0].get('updated') as unknown
    })
    console.log(`[migrate-workflow-metadata] Updated ${result} WorkflowStep nodes`)
  } finally {
    await session.close()
  }
}

migrate()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1) })
