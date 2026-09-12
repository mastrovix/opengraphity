import { v4 as uuidv4 } from 'uuid'
import { nextSequenceValue } from '../lib/sequence.js'
import { resolveNewTicketPriority } from '../lib/priority.js'
import { workflowEngine } from '@opengraphity/workflow'
import { runQuery, runQueryOne } from '@opengraphity/neo4j'
import { logger } from '../lib/logger.js'
import { withSession, getSession } from '../graphql/resolvers/ci-utils.js'
import { mapIncident } from '../lib/mappers.js'
import { NotFoundError, ValidationError } from '../lib/errors.js'
import { validateStringLength } from '../lib/validation.js'
import { evaluateTriggers, scheduleTimerTriggers } from '../lib/triggerEngine.js'
import { enqueueEmbedding } from '../jobs/embeddingWorker.js'
import { evaluateBusinessRules } from '../lib/rulesEngine.js'
import { publishEvent } from '../lib/publishEvent.js'
import { getInitialStepName, getWorkflowSteps } from '../lib/workflowHelpers.js'
import { loadStepFacts } from '../lib/stepEvent.js'
import { stepEnteredEventType, legacyStepEventType } from '@opengraphity/types'
import { ciLabelPredicateForTenant } from '../lib/ciLabelsForTenant.js'
import { assertUserInAssignedTeam, setTicketTeam, setTicketUser } from './ticketAssignment.js'

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

/**
 * Commento in timeline scritto da un attore di sistema (es. `monitoring`,
 * services/eventCorrelation.ts). Stesso nodo :Comment delle transizioni
 * manuali: l'incident non viene toccato con Cypher fuori da questo servizio.
 */
export async function addIncidentComment(id: string, ctx: ServiceCtx, text: string): Promise<void> {
  await withSession(async (session) => {
    const row = await runQueryOne<{ id: string }>(session, `
      MATCH (i:Incident {id: $id, tenant_id: $tenantId}) RETURN i.id AS id
    `, { id, tenantId: ctx.tenantId })
    if (!row) throw new NotFoundError('Incident', id)
    await createTransitionComment(session, id, ctx.tenantId, ctx.userId, text)
  }, true)
}

// buildEvent removed — using shared publishEvent from lib/publishEvent.ts


/** A resolved/assigned incident must always reload; a null payload after a
 *  successful write is a real error, not a reason to publish a fabricated event. */
function requirePayload(payload: IncidentEventPayload | null, id: string): IncidentEventPayload {
  if (!payload) throw new Error(`Incident ${id} not found while building event payload`)
  return payload
}

// ── Public service operations ─────────────────────────────────────────────────

export async function createIncident(
  input: { title: string; description?: string; severity?: string; impact?: string; urgency?: string; category?: string; affectedCIIds?: string[] },
  ctx: ServiceCtx,
) {
  validateStringLength(input.title, 'title', 1, 500)
  validateStringLength(input.description, 'description', 0, 10000)

  // ITIL: an incident must record the impacted CI(s) — required, not optional.
  if (!input.affectedCIIds || input.affectedCIIds.length === 0) {
    throw new ValidationError('Un incident deve avere almeno un CI impattato')
  }

  // ITIL: Priority = f(Impact, Urgency). La priorità derivata si salva nel
  // campo `severity` (SLA/pastiglie/filtri leggono quello). Impatto+urgenza
  // vincono; la sola `severity` resta accettata per i client API.
  //
  // Ondata 7 (C-8): impatto, urgenza e severità sono validati contro i
  // VOCABOLARI DEL CLIENTE e tradotti dalla sua matrice `priority`. Prima
  // nessuno li validava: un allarme o un client API scriveva `severity =
  // 'critical'` anche su un tenant che aveva rinominato quel valore, e la
  // selezione della SLA e i report non lo contavano piu'.
  const resolved = await resolveNewTicketPriority(ctx.tenantId, input)
  const severity = resolved.severity
  const impact   = resolved.impact
  const urgency  = resolved.urgency

  const id  = uuidv4()
  const now = new Date().toISOString()

  const created = await withSession(async (session) => {
    const seq = await nextSequenceValue(session, ctx.tenantId, 'incident')
    const number = 'INC' + String(seq).padStart(8, '0')

    const initialStatus = await getInitialStepName(session, ctx.tenantId, 'incident')
    const rows = await runQuery<{ props: Props }>(session, `
      CREATE (i:Incident {
        id:           $id,
        tenant_id:    $tenantId,
        number:       $number,
        title:        $title,
        description:  $description,
        severity:     $severity,
        impact:       $impact,
        urgency:      $urgency,
        category:     $category,
        status:       $status,
        created_at:   $now,
        updated_at:   $now
      })
      RETURN properties(i) as props
    `, {
      id, tenantId: ctx.tenantId, number,
      title: input.title, description: input.description ?? null,
      severity, impact, urgency,
      category: input.category ?? null,
      status: initialStatus, now,
    })
    if (!rows[0]) throw new ValidationError('Failed to create incident')
    return mapIncident(rows[0].props)
  }, true)

  // C-2 (CRITICO): il collegamento ai CI impattati viene CONTATO e, se manca,
  // l'operazione fallisce. Prima il `MERGE` girava sotto un predicato con le
  // etichette fisse e nessuno leggeva il risultato: un CI di un tipo del
  // cliente (o cancellato fra la creazione e questo passo) dava zero righe,
  // cioè un incident senza `AFFECTED_BY` — in contraddizione con la guardia
  // «un incident deve avere almeno un CI impattato» tre righe sopra, senza
  // errore, senza log, e invisibile all'incident di servizio (che cita gli
  // incident tecnici proprio via `AFFECTED_BY`). Contare le righe scritte è la
  // pratica già usata due volte nello stesso sottosistema
  // (serviceImpact/build.ts:241-243, config.ts:612-614).
  {
    const affectedCIIds = input.affectedCIIds
    const ciPredicate = await ciLabelPredicateForTenant('ci', ctx.tenantId)
    const missing: string[] = []
    await withSession(async (session) => {
      for (const ciId of affectedCIIds) {
        const rows = await runQuery<{ linked: unknown }>(session, `
          MATCH (i:Incident {id: $id, tenant_id: $tenantId})
          MATCH (ci {id: $ciId, tenant_id: $tenantId})
          WHERE ${ciPredicate}
          MERGE (i)-[r:AFFECTED_BY]->(ci)
          RETURN count(r) AS linked
        `, { id, tenantId: ctx.tenantId, ciId })
        if (Number(rows[0]?.linked ?? 0) === 0) missing.push(ciId)
      }
    }, true)
    if (missing.length > 0) {
      // L'incident era già stato committato in una transazione sua: lasciarlo
      // lì significherebbe tenere in banca dati proprio l'incident senza CI
      // che la guardia vieta, e senza istanza di workflow (creata dopo). Lo si
      // toglie e si dice perché.
      await withSession(async (session) => {
        await runQuery(session, `
          MATCH (i:Incident {id: $id, tenant_id: $tenantId}) DETACH DELETE i
        `, { id, tenantId: ctx.tenantId })
      }, true)
      logger.error({ incidentId: id, tenantId: ctx.tenantId, missing, number: created.number },
        '[incidentService] CI impattati non collegabili: incident annullato (violerebbe l\'invariante «almeno un CI impattato»)')
      throw new ValidationError(
        `Incident non creato: ${missing.length} dei ${affectedCIIds.length} CI impattati non esistono in questo cliente o non sono Configuration Item (${missing.join(', ')})`,
      )
    }
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
    id, title: input.title, severity: created.severity, status: created.status,
    ciName: '—', assignedTo: '—', affected_ci_ids: input.affectedCIIds ?? [],
  } satisfies IncidentEventPayload, now)

  // Evaluate auto triggers, then business rules
  const entityData = { id, title: input.title, severity: created.severity, status: created.status, category: input.category ?? null, description: input.description ?? null }
  void evaluateTriggers(ctx.tenantId, 'incident', 'on_create', entityData, ctx.userId)
    .then(() => evaluateBusinessRules(ctx.tenantId, 'incident', 'on_create', entityData, ctx.userId))
    .catch((err: unknown) => {
      // Fire-and-forget by design, but a load failure (Redis/Neo4j) must be an
      // ERROR in the logs, not an unhandled rejection that silently drops all
      // automations for this incident.
      logger.error({ err, incidentId: id, tenantId: ctx.tenantId },
        '[incidentService] trigger/business-rule evaluation failed — automations NOT executed')
    })
  scheduleTimerTriggers(ctx.tenantId, 'incident', id).catch((err: unknown) => {
    logger.error({ err: err instanceof Error ? err.message : err }, 'scheduleTimerTriggers failed')
  })
  enqueueEmbedding({ entityType: 'incident', entityId: id, tenantId: ctx.tenantId }).catch((err: unknown) => {
    logger.error({ err, incidentId: id }, '[embeddings] enqueue failed — similarity will lag until backfill')
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
    // Transition workflow to the step marked as category='resolved' (or,
    // if none, the first terminal step). The engine syncs entity.status
    // and records the step history; we only handle fields the engine
    // doesn't know about (resolved_at, root_cause).
    const instanceRow = await runQueryOne<{ instanceId: string }>(session, `
      MATCH (i:Incident {id: $id, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
      RETURN wi.id AS instanceId
    `, { id, tenantId: ctx.tenantId })
    if (!instanceRow) throw new NotFoundError('Incident', id)

    const steps = await getWorkflowSteps(session, ctx.tenantId, 'incident')
    const resolvedStep =
      steps.find((s) => s.category === 'resolved') ??
      steps.find((s) => s.isTerminal)
    if (!resolvedStep) throw new ValidationError('No resolved/terminal step in incident workflow')

    await workflowEngine.transition(
      session,
      { instanceId: instanceRow.instanceId, toStepName: resolvedStep.name,
        triggeredBy: ctx.userId, triggerType: 'manual', notes: notes ?? undefined },
      { userId: ctx.userId, notes, entityData: {} },
    )

    // Fields the engine doesn't touch.
    const rows = await runQuery<{ props: Props }>(session, `
      MATCH (i:Incident {id: $id, tenant_id: $tenantId})
      SET i.resolved_at = $now,
          i.root_cause  = coalesce($rootCause, i.root_cause),
          i.updated_at  = $now
      RETURN properties(i) as props
    `, { id, tenantId: ctx.tenantId, now, rootCause: notes ?? null })
    if (!rows[0]) throw new NotFoundError('Incident', id)
    return mapIncident(rows[0].props)
  }, true)

  const payload = await withSession((s) => loadIncidentPayload(s, id, ctx.tenantId))
  await publishEvent('incident.resolved', ctx.tenantId, ctx.userId, {
    ...requirePayload(payload, id),
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
    const { teamName } = await setTicketTeam(session, 'Incident', id, teamId, ctx.tenantId)
    const transitionNotes = `Riassegnato al team ${teamName}`

    const wiResult = await session.executeRead((tx) => tx.run(`
      MATCH (i:Incident {id: $id, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
      RETURN wi.id AS instanceId, wi.current_step AS currentStep
    `, { id, tenantId: ctx.tenantId }))

    if (wiResult.records.length > 0) {
      const instanceId  = wiResult.records[0]!.get('instanceId')  as string
      const currentStep = wiResult.records[0]!.get('currentStep') as string
      const initialStep = await getInitialStepName(session, ctx.tenantId, 'incident')

      if (currentStep === initialStep) {
        // Assigning a team from the initial step auto-advances the workflow.
        // Take the first manual transition available — the workflow defines
        // the post-assignment step, not this service.
        const transitions = await workflowEngine.getAvailableTransitions(session, instanceId)
        const next = transitions[0]
        if (next) {
          await workflowEngine.transition(
            session,
            { instanceId, toStepName: next.toStep, triggeredBy: ctx.userId, triggerType: 'automatic', notes: transitionNotes },
            { userId: ctx.userId, entityData: {} },
          )
        }
      } else {
        // Reassignment while already past the initial step: just log a
        // history entry against the current step, no transition.
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
      await setTicketUser(session, 'Incident', id, null, ctx.tenantId)
      const r = await session.executeRead((tx) => tx.run(
        `MATCH (i:Incident {id: $id, tenant_id: $tenantId}) RETURN properties(i) AS props`,
        { id, tenantId: ctx.tenantId },
      ))
      if (!r.records[0]) throw new NotFoundError('Incident', id)
      return mapIncident(r.records[0].get('props') as Props)
    }

    // Regola ITSM condivisa con il problem (services/ticketAssignment.ts):
    // prima il gruppo, poi un utente di quel gruppo.
    await assertUserInAssignedTeam(session, 'Incident', id, userId, ctx.tenantId)
    const { userName: assignedName } = await setTicketUser(session, 'Incident', id, userId, ctx.tenantId)
    const userName = assignedName ?? userId

    const wiResult = await session.executeRead((tx) => tx.run(`
      MATCH (i:Incident {id: $id, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
      RETURN wi.id AS instanceId, wi.current_step AS currentStep
    `, { id, tenantId: ctx.tenantId }))

    if (wiResult.records.length > 0) {
      const instanceId  = wiResult.records[0]!.get('instanceId')  as string
      const currentStep = wiResult.records[0]!.get('currentStep') as string
      const initialStep = await getInitialStepName(session, ctx.tenantId, 'incident')

      // Auto-advance SOLO dallo step iniziale (come per il team): assegnare
      // una persona a un incident già avviato non deve far scattare una
      // transizione arbitraria (transitions[0] potrebbe essere "resolved").
      // Da qualunque altro step si registra soltanto l'assegnazione (sotto).
      const transitions = currentStep === initialStep
        ? await workflowEngine.getAvailableTransitions(session, instanceId)
        : []
      const next = transitions[0]
      if (currentStep === initialStep && next) {
        await workflowEngine.transition(
          session,
          { instanceId, toStepName: next.toStep, triggeredBy: ctx.userId, triggerType: 'automatic', notes: `Assegnato a ${userName}` },
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
      requirePayload(assignedPayload, id),
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
    requirePayload(payload, id),
    now,
  )
}

/**
 * L'ingresso dell'incident in un passo del workflow (D-22).
 *
 * Pubblica DUE eventi con lo stesso payload e lo stesso istante:
 *  1. `incident.step_entered` — il tipo **stabile**, che una rinomina del passo
 *     non tocca. Il nome del passo è nel payload (`step_name`), insieme a
 *     etichetta, scopo, categoria e id: è un dettaglio del passo, non
 *     l'identità dell'evento. È a questo che si agganciano le regole nuove
 *     (per scopo o per categoria) e i webhook di un passo personalizzato.
 *  2. `incident.<stepName>` — l'**alias** storico. Resta perché a lui sono
 *     agganciate le 35 regole di fabbrica, le regole già scritte dai tenant, i
 *     formatter Slack/Teams (che sono per tipo esatto: `incident.resolved` →
 *     carta «risolto») e gli abbonamenti dei webhook: toglierlo spegnerebbe
 *     tutto questo **in silenzio**, che è esattamente il difetto da chiudere.
 *
 * Il dispatcher non consegna due volte: sull'evento stabile salta se esiste
 * già una regola per l'alias di quel passo (vedi packages/notifications).
 */
export async function publishIncidentTransition(
  id: string,
  stepName: string,
  ctx: ServiceCtx,
) {
  const now = new Date().toISOString()
  const { payload, facts } = await withSession(async (s) => ({
    payload: await loadIncidentPayload(s, id, ctx.tenantId),
    // Fail-loud: un passo che non esiste nel workflow attivo ferma l'evento
    // (il job resta nella coda dei falliti) invece di inventare i suoi fatti.
    facts:   await loadStepFacts(s, ctx.tenantId, 'incident', stepName),
  }))
  const body = { ...requirePayload(payload, id), ...facts }
  await publishEvent(stepEnteredEventType('incident'), ctx.tenantId, ctx.userId, body, now)
  await publishEvent(legacyStepEventType('incident', stepName), ctx.tenantId, ctx.userId, body, now)
}

export async function closeIncident(
  id: string,
  ctx: ServiceCtx,
) {
  const now = new Date().toISOString()
  const payload = await withSession((s) => loadIncidentPayload(s, id, ctx.tenantId))
  await publishEvent('incident.closed', ctx.tenantId, ctx.userId,
    requirePayload(payload, id),
    now,
  )
}

export async function escalateIncident(
  id: string,
  ctx: ServiceCtx,
) {
  const now = new Date().toISOString()
  await withSession(async (session) => {
    const instanceRow = await runQueryOne<{ instanceId: string }>(session, `
      MATCH (i:Incident {id: $id, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
      RETURN wi.id AS instanceId
    `, { id, tenantId: ctx.tenantId })
    if (!instanceRow) throw new Error(`Incident ${id}: no workflow instance to escalate`)
    const steps = await getWorkflowSteps(session, ctx.tenantId, 'incident')
    const target = steps.find((s) => s.category === 'escalated')
    if (!target) throw new Error(`Incident ${id}: workflow has no 'escalated' step`)
    await workflowEngine.transition(
      session,
      { instanceId: instanceRow.instanceId, toStepName: target.name,
        triggeredBy: ctx.userId, triggerType: 'manual' },
      { userId: ctx.userId, entityData: {} },
    )
  }, true)

  const payload = await withSession((s) => loadIncidentPayload(s, id, ctx.tenantId))
  await publishEvent('incident.escalated', ctx.tenantId, ctx.userId,
    requirePayload(payload, id),
    now,
  )
}
