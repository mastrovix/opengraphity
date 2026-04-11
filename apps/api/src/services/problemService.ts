import { v4 as uuidv4 } from 'uuid'
import { workflowEngine } from '@opengraphity/workflow'
import { runQuery, runQueryOne } from '@opengraphity/neo4j'
import { withSession } from '../graphql/resolvers/ci-utils.js'
import type { ServiceCtx } from './incidentService.js'
import { evaluateTriggers, scheduleTimerTriggers } from '../lib/triggerEngine.js'
import { evaluateBusinessRules } from '../lib/rulesEngine.js'
import { publishEvent } from '../lib/publishEvent.js'

export interface ProblemEventPayload {
  id: string; title: string; priority: string; status: string; assignedTo: string
}

type Props = Record<string, unknown>

async function loadProblemPayload(
  id: string,
  tenantId: string,
): Promise<ProblemEventPayload | null> {
  return withSession(async (session) => {
    const result = await session.executeRead((tx) => tx.run(`
      MATCH (p:Problem {id: $id, tenant_id: $tenantId})
      OPTIONAL MATCH (p)-[:ASSIGNED_TO]->(u:User)
      OPTIONAL MATCH (p)-[:ASSIGNED_TO_TEAM]->(t:Team)
      RETURN p.id AS id, p.title AS title, p.priority AS priority, p.status AS status,
             u.name AS assignedTo, t.name AS teamName
    `, { id, tenantId }))
    if (!result.records.length) return null
    const r = result.records[0]
    return {
      id:         r.get('id')                                                    as string,
      title:      r.get('title')                                                 as string,
      priority:   (r.get('priority') ?? 'medium')                               as string,
      status:     r.get('status')                                                as string,
      assignedTo: ((r.get('assignedTo') ?? r.get('teamName') ?? '—')            as string),
    } satisfies ProblemEventPayload
  })
}

// buildEvent removed — using shared publishEvent

// ── Public service operations ─────────────────────────────────────────────────

export async function createProblem(
  input: { title: string; description?: string; priority: string; category?: string; affectedCIs?: string[]; relatedIncidents?: string[]; workaround?: string },
  ctx: ServiceCtx,
) {
  const id  = uuidv4()
  const now = new Date().toISOString()

  const created = await withSession(async (session) => {
    const countResult = await runQueryOne<{ cnt: unknown }>(session,
      'MATCH (p:Problem {tenant_id: $tenantId}) RETURN count(p) AS cnt',
      { tenantId: ctx.tenantId },
    )
    const rawCnt = countResult?.cnt
    const count = typeof rawCnt === 'number' ? rawCnt : typeof (rawCnt as any)?.toNumber === 'function' ? (rawCnt as any).toNumber() : Number(rawCnt ?? 0)
    const number = 'PRB' + String(count + 1).padStart(8, '0')

    const rows = await runQuery<{ props: Props }>(session, `
      CREATE (p:Problem {
        id:          $id,
        tenant_id:   $tenantId,
        number:      $number,
        title:       $title,
        description: $description,
        priority:    $priority,
        status:      'new',
        workaround:  $workaround,
        created_at:  $now,
        updated_at:  $now
      })
      RETURN properties(p) as props
    `, {
      id, tenantId: ctx.tenantId, number,
      title: input.title, description: input.description ?? null,
      priority: input.priority, workaround: input.workaround ?? null, now,
    })
    if (!rows[0]) throw new Error('Failed to create problem')
    return rows[0].props
  }, true)

  if (input.affectedCIs?.length) {
    await withSession(async (session) => {
      for (const ciId of input.affectedCIs!) {
        await runQuery(session, `
          MATCH (p:Problem {id: $id, tenant_id: $tenantId})
          MATCH (ci {id: $ciId, tenant_id: $tenantId})
          WHERE (ci:Application OR ci:Database OR ci:DatabaseInstance OR ci:Server OR ci:Certificate)
          MERGE (p)-[:AFFECTS]->(ci)
        `, { id, tenantId: ctx.tenantId, ciId })
      }
    }, true)
  }

  if (input.relatedIncidents?.length) {
    await withSession(async (session) => {
      for (const incidentId of input.relatedIncidents!) {
        await runQuery(session, `
          MATCH (p:Problem {id: $id, tenant_id: $tenantId})
          MATCH (i:Incident {id: $incidentId, tenant_id: $tenantId})
          MERGE (p)-[:CAUSED_BY]->(i)
        `, { id, tenantId: ctx.tenantId, incidentId })
      }
    }, true)
  }

  await withSession(async (session) => {
    await workflowEngine.createInstance(session, ctx.tenantId, id, 'problem', undefined, input.category ?? null)
  }, true)

  await publishEvent('problem.created', ctx.tenantId, ctx.userId, {
    id,
    title:      input.title,
    priority:   input.priority,
    status:     'new',
    assignedTo: '—',
  } satisfies ProblemEventPayload)

  const entityData = { id, title: input.title, priority: input.priority, status: 'new', category: input.category ?? null }
  void evaluateTriggers(ctx.tenantId, 'problem', 'on_create', entityData, ctx.userId)
    .then(() => evaluateBusinessRules(ctx.tenantId, 'problem', 'on_create', entityData, ctx.userId))
  void scheduleTimerTriggers(ctx.tenantId, 'problem', id)

  return created
}

export async function investigateProblem(id: string, ctx: ServiceCtx) {
  const payload = await loadProblemPayload(id, ctx.tenantId)
  await publishEvent('problem.under_investigation', ctx.tenantId, ctx.userId,
    payload ?? { id, title: `Problem ${id}`, priority: 'medium', status: 'under_investigation', assignedTo: '—' },
  )
}

export async function deferProblem(id: string, ctx: ServiceCtx) {
  const payload = await loadProblemPayload(id, ctx.tenantId)
  await publishEvent('problem.deferred', ctx.tenantId, ctx.userId,
    payload ?? { id, title: `Problem ${id}`, priority: 'medium', status: 'deferred', assignedTo: '—' },
  )
}

export async function resolveProblem(id: string, ctx: ServiceCtx) {
  const payload = await loadProblemPayload(id, ctx.tenantId)
  await publishEvent('problem.resolved', ctx.tenantId, ctx.userId,
    payload ?? { id, title: `Problem ${id}`, priority: 'medium', status: 'resolved', assignedTo: '—' },
  )
}

export async function closeProblem(id: string, ctx: ServiceCtx) {
  const payload = await loadProblemPayload(id, ctx.tenantId)
  await publishEvent('problem.closed', ctx.tenantId, ctx.userId,
    payload ?? { id, title: `Problem ${id}`, priority: 'medium', status: 'closed', assignedTo: '—' },
  )
}
