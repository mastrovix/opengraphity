import { v4 as uuidv4 } from 'uuid'
import { nextSequenceValue } from '../lib/sequence.js'
import { resolveNewTicketPriority } from '../lib/priority.js'
import { workflowEngine } from '@opengraphity/workflow'
import { runQuery } from '@opengraphity/neo4j'
import { withSession } from '../graphql/resolvers/ci-utils.js'
import type { ServiceCtx } from './incidentService.js'
import { ValidationError } from '../lib/errors.js'
import { validateStringLength } from '../lib/validation.js'
import { evaluateTriggers, scheduleTimerTriggers } from '../lib/triggerEngine.js'
import { logger } from '../lib/logger.js'
import { evaluateBusinessRules } from '../lib/rulesEngine.js'
import { publishEvent } from '../lib/publishEvent.js'
import { getInitialStepName } from '../lib/workflowHelpers.js'
import { loadStepFacts } from '../lib/stepEvent.js'
import { stepEnteredEventType, legacyStepEventType } from '@opengraphity/types'
import { ciLabelPredicateForTenant } from '../lib/ciLabelsForTenant.js'

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


function requireProblemPayload<T>(payload: T | null, id: string): T {
  if (!payload) throw new Error(`Problem ${id} not found while building event payload`)
  return payload
}

// ── Public service operations ─────────────────────────────────────────────────

export async function createProblem(
  input: { title: string; description?: string; priority?: string; impact?: string; urgency?: string; category?: string; affectedCIs?: string[]; relatedIncidents?: string[]; workaround?: string },
  ctx: ServiceCtx,
) {
  validateStringLength(input.title, 'title', 1, 500)
  // ITIL: Priority = f(Impact, Urgency). Impatto+urgenza vincono. Ondata 7
  // (C-8): valori validati contro i vocabolari del cliente e tradotti dalla
  // sua matrice `priority` — mai piu' un `medium` ricostruito in silenzio.
  const resolved = await resolveNewTicketPriority(ctx.tenantId, { severity: input.priority, impact: input.impact, urgency: input.urgency }, 'priority')
  const priority = resolved.severity
  const impact   = resolved.impact
  const urgency  = resolved.urgency
  const id  = uuidv4()
  const now = new Date().toISOString()

  const created = await withSession(async (session) => {
    const seq = await nextSequenceValue(session, ctx.tenantId, 'problem')
    const number = 'PRB' + String(seq).padStart(8, '0')

    const initialStatus = await getInitialStepName(session, ctx.tenantId, 'problem')
    const rows = await runQuery<{ props: Props }>(session, `
      CREATE (p:Problem {
        id:          $id,
        tenant_id:   $tenantId,
        number:      $number,
        title:       $title,
        description: $description,
        priority:    $priority,
        impact:      $impact,
        urgency:     $urgency,
        status:      $status,
        workaround:  $workaround,
        created_at:  $now,
        updated_at:  $now
      })
      RETURN properties(p) as props
    `, {
      id, tenantId: ctx.tenantId, number,
      title: input.title, description: input.description ?? null,
      priority, impact, urgency,
      workaround: input.workaround ?? null,
      status: initialStatus, now,
    })
    if (!rows[0]) throw new Error('Failed to create problem')
    // Autore (Problem.createdBy): prima nessuno scriveva CREATED_BY e il campo
    // era sempre null.
    await runQuery(session, `
      MATCH (p:Problem {id: $id, tenant_id: $tenantId})
      MATCH (u:User {id: $userId, tenant_id: $tenantId})
      MERGE (p)-[:CREATED_BY]->(u)
    `, { id, tenantId: ctx.tenantId, userId: ctx.userId })
    return rows[0].props
  }, true)

  if (input.affectedCIs?.length) {
    // Etichette dal metamodello del tenant, e righe CONTATE: come in
    // `createIncident` (C-2), il `MERGE` sotto la lista fissa non collegava i
    // CI di un tipo del cliente e nessuno leggeva l'esito. A differenza
    // dell'incident un Problem può legittimamente non avere CI, quindi il
    // problem resta creato — ma chi ha chiesto quei CI lo viene a sapere.
    const ciPredicate = await ciLabelPredicateForTenant('ci', ctx.tenantId)
    const missing: string[] = []
    await withSession(async (session) => {
      for (const ciId of input.affectedCIs!) {
        const rows = await runQuery<{ linked: unknown }>(session, `
          MATCH (p:Problem {id: $id, tenant_id: $tenantId})
          MATCH (ci {id: $ciId, tenant_id: $tenantId})
          WHERE ${ciPredicate}
          MERGE (p)-[r:AFFECTS]->(ci)
          RETURN count(r) AS linked
        `, { id, tenantId: ctx.tenantId, ciId })
        if (Number(rows[0]?.linked ?? 0) === 0) missing.push(ciId)
      }
    }, true)
    if (missing.length > 0) {
      logger.error({ problemId: id, tenantId: ctx.tenantId, missing },
        '[problemService] CI non collegati al problem: non esistono in questo cliente o non sono Configuration Item')
      throw new ValidationError(
        `Problem creato, ma ${missing.length} dei ${input.affectedCIs.length} CI indicati non esistono in questo cliente o non sono Configuration Item (${missing.join(', ')})`,
      )
    }
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

  const initialStatus = await withSession((s) => getInitialStepName(s, ctx.tenantId, 'problem'))
  await publishEvent('problem.created', ctx.tenantId, ctx.userId, {
    id,
    title:      input.title,
    priority,
    status:     initialStatus,
    assignedTo: '—',
  } satisfies ProblemEventPayload)

  const entityData = { id, title: input.title, priority, status: initialStatus, category: input.category ?? null }
  void evaluateTriggers(ctx.tenantId, 'problem', 'on_create', entityData, ctx.userId)
    .then(() => evaluateBusinessRules(ctx.tenantId, 'problem', 'on_create', entityData, ctx.userId))
    .catch((err: unknown) => {
      logger.error({ err, problemId: id, tenantId: ctx.tenantId },
        '[problemService] trigger/business-rule evaluation failed — automations NOT executed')
    })
  scheduleTimerTriggers(ctx.tenantId, 'problem', id).catch((err: unknown) => {
    logger.error({ err, problemId: id }, '[problemService] scheduleTimerTriggers failed')
  })

  return created
}

/**
 * L'ingresso del problem in un passo del workflow (D-22): come per l'incident,
 * il tipo **stabile** `problem.step_entered` (col nome, l'etichetta, lo scopo e
 * la categoria del passo nel payload) e l'**alias** storico
 * `problem.<stepName>`, a cui restano agganciate le regole di fabbrica
 * (`problem.under_investigation`, `problem.deferred`, …) e quelle dei tenant.
 */
export async function publishProblemTransition(id: string, stepName: string, ctx: ServiceCtx) {
  // Prima il payload (un problem inesistente è l'errore da dire), poi i fatti
  // del passo: l'ordine è quello dei messaggi, e non va invertito.
  const payload = requireProblemPayload(await loadProblemPayload(id, ctx.tenantId), id)
  const facts   = await withSession((s) => loadStepFacts(s, ctx.tenantId, 'problem', stepName))
  const body    = { ...payload, ...facts }
  await publishEvent(stepEnteredEventType('problem'), ctx.tenantId, ctx.userId, body)
  await publishEvent(legacyStepEventType('problem', stepName), ctx.tenantId, ctx.userId, body)
}
