import { GraphQLError } from 'graphql'
import { ValidationError } from '../../lib/errors.js'
import { randomUUID } from 'crypto'
import { withSession } from './ci-utils.js'
import { invalidateWorkflowCache } from '../../lib/workflowHelpers.js'
import { workflowLogger } from '../../lib/logger.js'
import { audit } from '../../lib/audit.js'
import type { GraphQLContext } from '../../context.js'
import {
  serviceRequestWorkflowInstance,
  serviceRequestAvailableTransitionsField,
  incidentWorkflow,
  incidentAvailableTransitions,
  incidentWorkflowHistory,
  workflowDefinition,
  workflowDefinitionById,
  workflowDefinitions,
  incidentWorkflowInstance,
  incidentAvailableTransitionsField,
  incidentWorkflowHistoryField,
  workflowStepCurrentInstances,
  changeWorkflowInstance,
  changeAvailableTransitionsField,
  changeWorkflowHistoryField,
} from './workflowQueries.js'
import {
  updateWorkflowStep,
  updateWorkflowTransition,
  addWorkflowTransition,
  removeWorkflowTransition,
  executeWorkflowTransition,
  saveWorkflowChanges,
  MARK_CUSTOMIZED,
  customizedParams,
} from './workflowMutations.js'

export * from './workflowQueries.js'
export * from './workflowMutations.js'

// ── saveWorkflowLayout (kept here as it's a thin wrapper) ────────────────────

async function saveWorkflowLayout(
  _: unknown,
  { definitionId, positions }: {
    definitionId: string
    positions: Array<{ stepId: string; positionX: number; positionY: number }>
  },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    await session.executeWrite((tx) =>
      tx.run(`
        UNWIND $positions AS pos
        MATCH (s:WorkflowStep {id: pos.stepId})<-[:HAS_STEP]-(wd:WorkflowDefinition {
          id: $definitionId, tenant_id: $tenantId
        })
        SET s.position_x = pos.positionX,
            s.position_y = pos.positionY
      `, { definitionId, tenantId: ctx.tenantId, positions }),
    )
    return true
  }, true)
}

// ── addWorkflowStep ───────────────────────────────────────────────────────────

async function addWorkflowStep(
  _: unknown,
  { definitionId, name, label, type, timerDelayMinutes, subWorkflowId }: {
    definitionId: string; name: string; label: string; type: string
    timerDelayMinutes?: number; subWorkflowId?: string
  },
  ctx: GraphQLContext,
) {
  const ALLOWED_TYPES = new Set(['standard', 'parallel_fork', 'parallel_join', 'timer_wait', 'sub_workflow'])
  if (!ALLOWED_TYPES.has(type)) throw new ValidationError(`Invalid step type: ${type}`)

  return withSession(async (session) => {
    const stepId = randomUUID()
    const res = await session.executeWrite(tx =>
      tx.run(`
        MATCH (wd:WorkflowDefinition {id: $definitionId, tenant_id: $tenantId})
        // tenant-ok: passi della definizione appena scopata
        OPTIONAL MATCH (wd)-[:HAS_STEP]->(ex:WorkflowStep)
        WITH wd,
             coalesce(max(ex.step_order), 0) + 1     AS nextOrder,
             count(CASE WHEN ex.name = $name THEN 1 END) AS sameName
        WHERE sameName = 0
        CREATE (s:WorkflowStep {
          id:                  $stepId,
          tenant_id:           $tenantId,
          definition_id:       $definitionId,
          name:                $name,
          label:               $label,
          type:                $type,
          timer_delay_minutes: $timerDelayMinutes,
          sub_workflow_id:     $subWorkflowId,
          enter_actions:       '[]',
          exit_actions:        '[]',
          is_initial:          false,
          is_terminal:         false,
          is_open:             true,
          category:            $category,
          step_order:          nextOrder,
          created_at:          $now,
          updated_at:          $now
        })
        CREATE (wd)-[:HAS_STEP]->(s)
        SET wd.version = wd.version + 1, wd.updated_at = $now
        ${MARK_CUSTOMIZED}
        RETURN wd.entity_type AS entityType
      `, {
        definitionId, tenantId: ctx.tenantId, stepId,
        name, label, type,
        timerDelayMinutes: timerDelayMinutes ?? null,
        subWorkflowId: subWorkflowId ?? null,
        // Un passo nuovo nasce intermedio e aperto: `active` è la stessa
        // categoria che la migrazione dei metadata assegna a un passo non
        // terminale. L'amministratore la cambia dai Metadati del pannello.
        category: 'active',
        now: new Date().toISOString(),
        ...customizedParams(ctx),
      }),
    )
    if (!res.records.length) {
      // O la definizione non è di questo tenant, o esiste già un passo con
      // questo nome: due passi omonimi nella stessa definizione renderebbero
      // ambigue tutte le scritture per nome (saveWorkflowChanges, transizioni).
      throw new ValidationError(`Impossibile creare lo step "${name}": definizione non trovata o nome già usato in questo workflow`)
    }
    invalidateWorkflowCache(ctx.tenantId, res.records[0].get('entityType') as string)
    return workflowDefinitionById(_, { id: definitionId }, ctx)
  }, true)
}

// ── removeWorkflowStep ────────────────────────────────────────────────────────

async function removeWorkflowStep(
  _: unknown,
  { definitionId, stepName }: { definitionId: string; stepName: string },
  ctx: GraphQLContext,
) {
  const PROTECTED = new Set(['start', 'end'])
  return withSession(async (session) => {
    // Quante istanze stanno ORA su questo passo, e in che stato. `DETACH
    // DELETE` porterebbe via anche il `CURRENT_STEP`: quelle istanze
    // resterebbero con `current_step` che punta a un passo inesistente, cioè
    // ticket che non transizionano più. Il seed questa guardia ce l'ha
    // (seed-common.ts), l'API no: è lo stesso rifiuto, con i numeri.
    const res = await session.executeRead(tx =>
      tx.run(`
        MATCH (wd:WorkflowDefinition {id: $definitionId, tenant_id: $tenantId})-[:HAS_STEP]->(s:WorkflowStep {name: $stepName})
        OPTIONAL MATCH (wi:WorkflowInstance)-[:CURRENT_STEP]->(s)
        WITH wd, s, wi.status AS instanceStatus, count(wi) AS n
        RETURN s.type AS type,
               coalesce(s.is_initial, s.type = 'start') AS isInitial,
               wd.entity_type AS entityType,
               instanceStatus, n
      `, { definitionId, stepName, tenantId: ctx.tenantId }),
    )
    if (!res.records.length) throw new ValidationError(`Step "${stepName}" non trovato in questa definizione`)
    const stepType   = res.records[0].get('type') as string | null
    const isInitial  = Boolean(res.records[0].get('isInitial'))
    const entityType = res.records[0].get('entityType') as string
    // Messaggio parlante anche qui: «Cannot remove step: new» lasciava
    // l'amministratore senza sapere perché, ed è il primo rifiuto che incontra
    // (il passo di partenza è quasi sempre anche `type: 'start'`).
    if (!stepType || PROTECTED.has(stepType)) {
      throw new ValidationError(
        `Lo step "${stepName}" è di tipo "${stepType ?? 'ignoto'}": i passi di apertura e di chiusura del processo non si eliminano, ` +
        `altrimenti il workflow non avrebbe più un inizio o una fine. Puoi rinominarlo, o cambiarne le azioni.`,
      )
    }
    if (isInitial) {
      throw new ValidationError(
        `Lo step "${stepName}" è lo step iniziale del processo: eliminandolo nessun nuovo ticket potrebbe più nascere. Marca prima un altro step come iniziale.`,
      )
    }

    const byStatus = res.records
      .map((r) => ({ status: r.get('instanceStatus') as string | null, n: Number(r.get('n') ?? 0) }))
      .filter((r) => r.n > 0)
    const live = byStatus.reduce((acc, r) => acc + r.n, 0)
    if (live > 0) {
      const detail = byStatus.map((r) => `${r.status ?? 'senza stato'}: ${r.n}`).join(', ')
      throw new GraphQLError(
        `Non puoi eliminare lo step "${stepName}": ${live} istanze di workflow si trovano ora su questo passo (${detail}). ` +
        `Spostale prima su un altro step — eliminandolo resterebbero senza step corrente e non potrebbero più transizionare.`,
        { extensions: { code: 'CONFLICT', stepName, instances: live } },
      )
    }

    // Regole di obbligatorietà per QUESTO passo: restano orfane (ondata 8 ·
    // B-21). Prima il pannello continuava a mostrarle come regole attive di un
    // passo che non esiste più, e non valevano per nessuna transizione. Si
    // cancellano insieme al passo, e il numero finisce nei log e nell'audit:
    // una configurazione che sparisce senza dirlo è peggio del difetto.
    // Il passo può esistere anche in un'altra definizione attiva della stessa
    // entità (varianti per categoria): in quel caso le regole servono ancora e
    // non si toccano.
    const orphanRules = await session.executeWrite(async (tx) => {
      const stillThere = await tx.run(`
        MATCH (wd:WorkflowDefinition {tenant_id: $tenantId, entity_type: $entityType, active: true})-[:HAS_STEP]->(s:WorkflowStep {name: $stepName})
        WHERE wd.id <> $definitionId
        RETURN count(s) AS n
      `, { tenantId: ctx.tenantId, entityType, stepName, definitionId })
      const elsewhere = Number(stillThere.records[0]?.get('n') ?? 0)
      await tx.run(`
        MATCH (wd:WorkflowDefinition {id: $definitionId, tenant_id: $tenantId})-[:HAS_STEP]->(s:WorkflowStep {name: $stepName})
        DETACH DELETE s
        SET wd.version = wd.version + 1, wd.updated_at = $now
        ${MARK_CUSTOMIZED}
      `, { definitionId, tenantId: ctx.tenantId, stepName, now: new Date().toISOString(), ...customizedParams(ctx) })
      if (elsewhere > 0) return { deleted: 0, fields: [] as string[] }
      const rules = await tx.run(`
        MATCH (r:FieldRequirementRule {tenant_id: $tenantId, entity_type: $entityType, workflow_step: $stepName})
        WITH r, r.field_name AS fieldName
        DETACH DELETE r
        RETURN collect(fieldName) AS fields
      `, { tenantId: ctx.tenantId, entityType, stepName })
      const fields = (rules.records[0]?.get('fields') ?? []) as string[]
      return { deleted: fields.length, fields }
    })
    if (orphanRules.deleted > 0) {
      workflowLogger.warn(
        { tenantId: ctx.tenantId, entityType, stepName, fields: orphanRules.fields },
        `[workflow] step eliminato: rimosse ${orphanRules.deleted} regole di obbligatorietà che lo nominavano`,
      )
      void audit(ctx, 'fieldRequirementRule.orphansRemoved', 'WorkflowStep', stepName, {
        entityType, removedFields: orphanRules.fields,
      })
    }
    invalidateWorkflowCache(ctx.tenantId, entityType)
    return workflowDefinitionById(_, { id: definitionId }, ctx)
  }, true)
}

// ── Combined resolver object ──────────────────────────────────────────────────

export const workflowResolvers = {
  Query: {
    incidentWorkflow,
    incidentAvailableTransitions,
    incidentWorkflowHistory,
    workflowDefinition,
    workflowDefinitionById,
    workflowDefinitions,
  },
  Mutation: {
    addWorkflowStep,
    removeWorkflowStep,
    updateWorkflowStep,
    updateWorkflowTransition,
    addWorkflowTransition,
    removeWorkflowTransition,
    executeWorkflowTransition,
    saveWorkflowLayout,
    saveWorkflowChanges,
  },
  WorkflowStep: {
    currentInstances: workflowStepCurrentInstances,
  },
  Incident: {
    workflowInstance:     incidentWorkflowInstance,
    availableTransitions: incidentAvailableTransitionsField,
    workflowHistory:      incidentWorkflowHistoryField,
  },
  Change: {
    workflowInstance:     changeWorkflowInstance,
    availableTransitions: changeAvailableTransitionsField,
    // Dichiarato nello SDL ma mai registrato: qualunque query lo chiedesse
    // falliva con "Cannot return null for non-nullable field".
    workflowHistory:      changeWorkflowHistoryField,
  },
  ServiceRequest: {
    workflowInstance:     serviceRequestWorkflowInstance,
    availableTransitions: serviceRequestAvailableTransitionsField,
    // NB: no workflowHistory — the ServiceRequest schema type doesn't declare
    // it, and makeExecutableSchema rejects resolvers for undeclared fields.
  },
}
