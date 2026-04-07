import { v4 as uuidv4 } from 'uuid'
import { workflowEngine } from '@opengraphity/workflow'
import { runQuery } from '@opengraphity/neo4j'
import { withSession, getSession } from '../graphql/resolvers/ci-utils.js'
import { mapIncident } from '../lib/mappers.js'
import { NotFoundError, ValidationError } from '../lib/errors.js'
import { validateStringLength } from '../lib/validation.js'
import { evaluateTriggers, scheduleTimerTriggers } from '../lib/triggerEngine.js'
import { evaluateBusinessRules } from '../lib/rulesEngine.js'
import { publishEvent } from '../lib/publishEvent.js'

export interface IncidentEventPayload {
  id: string; title: string; severity: string; status: string
  ciName: string; assignedTo: string
  resolved_at?: string; affected_ci_ids?: string[]
}

export interface ServiceCtx {
  tenantId: string
  userId: string
}

type Session = ReturnType<typeof getSession>
type Props = Record<string, unknown>

// ── Internal helpers ─────────────────────────────────────────────────────────

async function loadIncidentPayload(
  session: Session,
  incidentId: string,
  tenantId: string,
): Promise<IncidentEventPayload | null> {
  const result = await session.executeRead((tx) =>
    tx.run(`
      MATCH (i:Incident {id: $incidentId, tenant_id: $tenantId})
      OPTIONAL MATCH (i)-[:AFFECTED_BY]->(ci)
      OPTIONAL MATCH (i)-[:ASSIGNED_TO]->(u:User)
      RETURN i.id AS id, i.title AS title,
             i.severity AS severity, i.status AS status,
             collect(ci.name)[0] AS ciName,
             u.name AS assignedTo
    `, { incidentId, tenantId }),
  )
  if (!result.records.length) return null
  const r = result.records[0]
  return {
    id:         r.get('id')         as string,
    title:      r.get('title')      as string,
    severity:   r.get('severity')   as string,
    status:     r.get('status')     as string,
    ciName:     (r.get('ciName')    ?? '—') as string,
    assignedTo: (r.get('assignedTo') ?? '—') as string,
  }
}

async function createTransitionComment(
  session: Session,
  incidentId: string,
  tenantId: string,
  userId: string,
  text: string,
) {
  const now = new Date().toISOString()
  await session.executeWrite((tx) => tx.run(`
    MATCH (i:Incident {id: $incidentId, tenant_id: $tenantId})
    CREATE (c:Comment {
      id:         randomUUID(),
      tenant_id:  $tenantId,
      text:       $text,
      author_id:  $userId,
      created_at: $now,
      updated_at: $now
    })
    CREATE (i)-[:HAS_COMMENT]->(c)
  `, { incidentId, tenantId, text, userId, now }))
}

// buildEvent removed — using shared publishEvent from lib/publishEvent.ts

// ── Public service operations ─────────────────────────────────────────────────

export async function createIncident(
  input: { title: string; description?: string; severity: string; category?: string; affectedCIIds?: string[] },
  ctx: ServiceCtx,
) {
  validateStringLength(input.title, 'title', 1, 500)
  validateStringLength(input.description, 'description', 0, 10000)

  const id  = uuidv4()
  const now = new Date().toISOString()

  const created = await withSession(async (session) => {
    const rows = await runQuery<{ props: Props }>(session, `
      CREATE (i:Incident {
        id:           $id,
        tenant_id:    $tenantId,
        title:        $title,
        description:  $description,
        severity:     $severity,
        category:     $category,
        status:       'new',
        created_at:   $now,
        updated_at:   $now
      })
      RETURN properties(i) as props
    `, {
      id, tenantId: ctx.tenantId,
      title: input.title, description: input.description ?? null,
      severity: input.severity, category: input.category ?? null, now,
    })
    if (!rows[0]) throw new ValidationError('Failed to create incident')
    return mapIncident(rows[0].props)
  }, true)

  if (input.affectedCIIds?.length) {
    await withSession(async (session) => {
      for (const ciId of input.affectedCIIds!) {
        await runQuery(session, `
          MATCH (i:Incident {id: $id, tenant_id: $tenantId})
          MATCH (ci {id: $ciId, tenant_id: $tenantId})
          WHERE (ci:Application OR ci:Database OR ci:DatabaseInstance OR ci:Server OR ci:Certificate)
          MERGE (i)-[:AFFECTED_BY]->(ci)
        `, { id, tenantId: ctx.tenantId, ciId })
      }
    }, true)
  }

  await withSession(async (session) => {
    await workflowEngine.createInstance(session, ctx.tenantId, id, 'incident', undefined, input.category ?? null)
  }, true)

  // Auto-watch: creator becomes watcher
  await withSession(async (session) => {
    await session.executeWrite(tx => tx.run(`
      MATCH (u:User {id: $userId, tenant_id: $tenantId})
      MATCH (i:Incident {id: $entityId, tenant_id: $tenantId})
      MERGE (u)-[:WATCHES {watched_at: $now}]->(i)
    `, { userId: ctx.userId, tenantId: ctx.tenantId, entityId: id, now }))
  }, true)

  await publishEvent('incident.created', ctx.tenantId, ctx.userId, {
    id, title: input.title, severity: input.severity, status: 'new',
    ciName: '—', assignedTo: '—', affected_ci_ids: input.affectedCIIds ?? [],
  } satisfies IncidentEventPayload, now)

  // Evaluate auto triggers, then business rules
  const entityData = { id, title: input.title, severity: input.severity, status: 'new', category: input.category ?? null, description: input.description ?? null }
  void evaluateTriggers(ctx.tenantId, 'incident', 'on_create', entityData, ctx.userId)
    .then(() => evaluateBusinessRules(ctx.tenantId, 'incident', 'on_create', entityData, ctx.userId))
  scheduleTimerTriggers(ctx.tenantId, 'incident', id).catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error('[incidentService] scheduleTimerTriggers failed:', err instanceof Error ? err.message : err)
  })

  return created
}

export async function resolveIncident(
  id: string,
  ctx: ServiceCtx,
  notes?: string,
) {
  const now = new Date().toISOString()

  const resolved = await withSession(async (session) => {
    const rows = await runQuery<{ props: Props }>(session, `
      MATCH (i:Incident {id: $id, tenant_id: $tenantId})
      SET i.status = 'resolved', i.resolved_at = $now,
          i.root_cause = coalesce($rootCause, i.root_cause), i.updated_at = $now
      RETURN properties(i) as props
    `, { id, tenantId: ctx.tenantId, now, rootCause: notes ?? null })
    if (!rows[0]) throw new NotFoundError('Incident', id)
    return mapIncident(rows[0].props)
  }, true)

  const payload = await withSession((s) => loadIncidentPayload(s, id, ctx.tenantId))
  await publishEvent('incident.resolved', ctx.tenantId, ctx.userId, {
    ...(payload ?? { id, title: `Incident ${id}`, severity: 'low', status: 'resolved', ciName: '—', assignedTo: '—' }),
    resolved_at: now,
  } satisfies IncidentEventPayload, now)

  return resolved
}

export async function assignIncidentToTeam(
  id: string,
  teamId: string,
  ctx: ServiceCtx,
) {
  if (!teamId?.trim()) throw new ValidationError('teamId è obbligatorio')
  const now = new Date().toISOString()

  return withSession(async (session) => {
    await session.executeWrite((tx) => tx.run(`
      MATCH (i:Incident {id: $id, tenant_id: $tenantId})
      OPTIONAL MATCH (i)-[old:ASSIGNED_TO_TEAM]->()
      DELETE old
      WITH i
      MATCH (t:Team {id: $teamId, tenant_id: $tenantId})
      CREATE (i)-[:ASSIGNED_TO_TEAM]->(t)
      SET i.updated_at = $now
    `, { id, teamId, tenantId: ctx.tenantId, now }))

    const teamResult = await session.executeRead((tx) =>
      tx.run('MATCH (t:Team {id: $id}) RETURN t.name AS name', { id: teamId }),
    )
    const teamName = (teamResult.records[0]?.get('name') as string | null) ?? teamId
    const transitionNotes = `Riassegnato al team ${teamName}`

    const wiResult = await session.executeRead((tx) => tx.run(`
      MATCH (i:Incident {id: $id, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
      RETURN wi.id AS instanceId, wi.current_step AS currentStep
    `, { id, tenantId: ctx.tenantId }))

    if (wiResult.records.length > 0) {
      const instanceId  = wiResult.records[0]!.get('instanceId')  as string
      const currentStep = wiResult.records[0]!.get('currentStep') as string

      if (currentStep === 'new') {
        await workflowEngine.transition(
          session,
          { instanceId, toStepName: 'assigned', triggeredBy: ctx.userId, triggerType: 'automatic', notes: transitionNotes },
          { userId: ctx.userId, entityData: {} },
        )
      } else {
        await session.executeWrite((tx) => tx.run(`
          MATCH (i:Incident {id: $incidentId, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
          CREATE (wi)-[:STEP_HISTORY]->(:WorkflowStepExecution {
            id:           randomUUID(),
            tenant_id:    $tenantId,
            instance_id:  wi.id,
            step_name:    'assigned',
            entered_at:   $now,
            exited_at:    $now,
            duration_ms:  toInteger(0),
            triggered_by: $userId,
            trigger_type: 'manual',
            notes:        $notes
          })
        `, { incidentId: id, tenantId: ctx.tenantId, now, userId: ctx.userId, notes: transitionNotes }))
      }
      await createTransitionComment(session, id, ctx.tenantId, ctx.userId, transitionNotes)
    }

    const r = await session.executeRead((tx) => tx.run(
      `MATCH (i:Incident {id: $id, tenant_id: $tenantId}) RETURN properties(i) AS props`,
      { id, tenantId: ctx.tenantId },
    ))
    if (!r.records[0]) throw new NotFoundError('Incident', id)
    const assigned = mapIncident(r.records[0].get('props') as Props)
    await publishEvent('incident.assigned', ctx.tenantId, ctx.userId, {
      id:         assigned.id,
      title:      assigned.title,
      severity:   assigned.severity,
      status:     assigned.status,
      ciName:     '—',
      assignedTo: teamName,
    } satisfies IncidentEventPayload, now)
    return assigned
  }, true)
}

export async function assignIncidentToUser(
  id: string,
  userId: string | null,
  ctx: ServiceCtx,
) {
  const now = new Date().toISOString()

  return withSession(async (session) => {
    if (!userId) {
      await session.executeWrite((tx) => tx.run(`
        MATCH (i:Incident {id: $id, tenant_id: $tenantId})
        OPTIONAL MATCH (i)-[old:ASSIGNED_TO]->()
        DELETE old
        SET i.updated_at = $now
      `, { id, tenantId: ctx.tenantId, now }))
      const r = await session.executeRead((tx) => tx.run(
        `MATCH (i:Incident {id: $id, tenant_id: $tenantId}) RETURN properties(i) AS props`,
        { id, tenantId: ctx.tenantId },
      ))
      if (!r.records[0]) throw new NotFoundError('Incident', id)
      return mapIncident(r.records[0].get('props') as Props)
    }

    await session.executeWrite((tx) => tx.run(`
      MATCH (i:Incident {id: $id, tenant_id: $tenantId})
      OPTIONAL MATCH (i)-[old:ASSIGNED_TO]->()
      DELETE old
      WITH i
      MATCH (u:User {id: $userId, tenant_id: $tenantId})
      CREATE (i)-[:ASSIGNED_TO]->(u)
      SET i.updated_at = $now
    `, { id, userId, tenantId: ctx.tenantId, now }))

    const userResult = await session.executeRead((tx) =>
      tx.run('MATCH (u:User {id: $id}) RETURN u.name AS name', { id: userId }),
    )
    const userName = (userResult.records[0]?.get('name') as string | null) ?? userId

    const wiResult = await session.executeRead((tx) => tx.run(`
      MATCH (i:Incident {id: $id, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
      RETURN wi.id AS instanceId, wi.current_step AS currentStep
    `, { id, tenantId: ctx.tenantId }))

    if (wiResult.records.length > 0) {
      const instanceId  = wiResult.records[0]!.get('instanceId')  as string
      const currentStep = wiResult.records[0]!.get('currentStep') as string

      if (currentStep === 'assigned') {
        await workflowEngine.transition(
          session,
          { instanceId, toStepName: 'in_progress', triggeredBy: ctx.userId, triggerType: 'automatic', notes: `Assegnato a ${userName}` },
          { userId: ctx.userId, entityData: {} },
        )
      } else {
        await session.executeWrite((tx) => tx.run(`
          MATCH (i:Incident {id: $incidentId, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
          CREATE (wi)-[:STEP_HISTORY]->(:WorkflowStepExecution {
            id:           randomUUID(),
            tenant_id:    $tenantId,
            instance_id:  wi.id,
            step_name:    wi.current_step,
            entered_at:   $now,
            exited_at:    $now,
            duration_ms:  toInteger(0),
            triggered_by: $userId,
            trigger_type: 'manual',
            notes:        $notes
          })
        `, { incidentId: id, tenantId: ctx.tenantId, now, userId: ctx.userId, notes: `Riassegnato a ${userName}` }))
      }
      await createTransitionComment(session, id, ctx.tenantId, ctx.userId, `Assegnato a ${userName}`)
    }

    const r = await session.executeRead((tx) => tx.run(
      `MATCH (i:Incident {id: $id, tenant_id: $tenantId}) RETURN properties(i) AS props`,
      { id, tenantId: ctx.tenantId },
    ))
    if (!r.records[0]) throw new NotFoundError('Incident', id)
    const assigned = mapIncident(r.records[0].get('props') as Props)
    const assignedPayload = await loadIncidentPayload(session, id, ctx.tenantId)
    await publishEvent('incident.assigned', ctx.tenantId, ctx.userId,
      assignedPayload ?? { id, title: assigned.title, severity: assigned.severity, status: assigned.status, ciName: '—', assignedTo: '—' },
      now,
    )
    return assigned
  }, true)
}

export async function inProgressIncident(
  id: string,
  ctx: ServiceCtx,
) {
  const now = new Date().toISOString()
  const payload = await withSession((s) => loadIncidentPayload(s, id, ctx.tenantId))
  await publishEvent('incident.in_progress', ctx.tenantId, ctx.userId,
    payload ?? { id, title: `Incident ${id}`, severity: 'low', status: 'in_progress', ciName: '—', assignedTo: '—' },
    now,
  )
}

export async function onHoldIncident(
  id: string,
  ctx: ServiceCtx,
) {
  const now = new Date().toISOString()
  const payload = await withSession((s) => loadIncidentPayload(s, id, ctx.tenantId))
  await publishEvent('incident.on_hold', ctx.tenantId, ctx.userId,
    payload ?? { id, title: `Incident ${id}`, severity: 'low', status: 'pending', ciName: '—', assignedTo: '—' },
    now,
  )
}

export async function closeIncident(
  id: string,
  ctx: ServiceCtx,
) {
  const now = new Date().toISOString()
  const payload = await withSession((s) => loadIncidentPayload(s, id, ctx.tenantId))
  await publishEvent('incident.closed', ctx.tenantId, ctx.userId,
    payload ?? { id, title: `Incident ${id}`, severity: 'low', status: 'closed', ciName: '—', assignedTo: '—' },
    now,
  )
}

export async function escalateIncident(
  id: string,
  ctx: ServiceCtx,
) {
  const now = new Date().toISOString()
  const payload = await withSession((s) => loadIncidentPayload(s, id, ctx.tenantId))
  await publishEvent('incident.escalated', ctx.tenantId, ctx.userId,
    payload ?? { id, title: `Incident ${id}`, severity: 'high', status: 'escalated', ciName: '—', assignedTo: '—' },
    now,
  )
}
