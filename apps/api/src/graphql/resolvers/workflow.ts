import { GraphQLError } from 'graphql'
import { ValidationError } from '../../lib/errors.js'
import { randomUUID } from 'crypto'
import { withSession } from './ci-utils.js'
import { invalidateWorkflowCache } from '../../lib/workflowHelpers.js'
import { invalidateSchema } from '../../lib/schemaInvalidator.js'
import { workflowLogger } from '../../lib/logger.js'
import { audit } from '../../lib/audit.js'
import type { GraphQLContext } from '../../context.js'
import type { Queryable } from '@opengraphity/neo4j'
import { requireRole } from '../../lib/requireRole.js'
import { provisionTenantData, tenantProvisioningGaps } from '../../lib/provisionTenantData.js'
import { mapGaps } from '../issueShape.js'
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
  // Il nome del passo diventa lo `status` dell'entità (`engine.ts`), e da lì va
  // nei filtri, nei report e nel vocabolario `status_*`: ha la stessa forma di
  // ogni altro identificatore di dominio. Non era validato — dall'interfaccia
  // arrivava già slugato, ma via API no, e un nome con spazi o maiuscole
  // avrebbe prodotto uno stato che nessun filtro trova (revisione · B·M-1).
  if (!/^[a-z][a-z0-9_]*$/.test(name)) {
    throw new ValidationError(
      `Invalid step name "${name}": lowercase, digits and underscores, and it must start with a letter `
      + `(e.g. "weekly_cab"). This name becomes the state of the ticket and ends up in filters and reports; `
      + `the name people see is the label, which can be anything.`,
      { key: 'errors.workflow.invalidStepName', params: { name } },
    )
  }

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
      throw new ValidationError(`Cannot create step "${name}": definition not found, or the name is already used in this workflow`, { key: 'errors.workflow.stepNameTaken', params: { name } })
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
    if (!res.records.length) throw new ValidationError(`Step "${stepName}" not found in this definition`, { key: 'errors.workflow.stepNotFound', params: { name: stepName } })
    const stepType   = res.records[0].get('type') as string | null
    const isInitial  = Boolean(res.records[0].get('isInitial'))
    const entityType = res.records[0].get('entityType') as string
    // Messaggio parlante anche qui: «Cannot remove step: new» lasciava
    // l'amministratore senza sapere perché, ed è il primo rifiuto che incontra
    // (il passo di partenza è quasi sempre anche `type: 'start'`).
    if (!stepType || PROTECTED.has(stepType)) {
      throw new ValidationError(
        `Step "${stepName}" is of kind "${stepType ?? 'unknown'}": the opening and closing steps of the process cannot be deleted, `
        + `or the workflow would have no beginning or no end. You can rename it, or change its actions.`,
        { key: 'errors.workflow.cannotDeleteBoundaryStep', params: { name: stepName, kind: stepType ?? '' } },
      )
    }
    if (isInitial) {
      throw new ValidationError(
        `Step "${stepName}" is the initial step of the process: deleting it, no new ticket could be created. Mark another step as initial first.`,
        { key: 'errors.workflow.cannotDeleteInitialStep', params: { name: stepName } },
      )
    }

    const byStatus = res.records
      .map((r) => ({ status: r.get('instanceStatus') as string | null, n: Number(r.get('n') ?? 0) }))
      .filter((r) => r.n > 0)
    const live = byStatus.reduce((acc, r) => acc + r.n, 0)
    if (live > 0) {
      const detail = byStatus.map((r) => `${r.status ?? 'senza stato'}: ${r.n}`).join(', ')
      throw new GraphQLError(
        `Step "${stepName}" cannot be deleted: ${live} workflow instances are on this step right now (${detail}). `
        + `Move them to another step first — deleting it would leave them without a current step, unable to transition.`,
        {
          extensions: {
            code: 'CONFLICT', stepName, instances: live,
            i18n: { key: 'errors.workflow.stepHasInstances', params: { name: stepName, count: live, detail } },
          },
        },
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

/**
 * Cosa manca a questo cliente per essere usabile, e come rimediare **dalla
 * pagina** (revisione delle otto ondate · D·D4).
 *
 * ## Il vicolo cieco
 * Nello SDL non esisteva **nessuna** mutation che creasse, clonasse o
 * ripristinasse una `WorkflowDefinition`: c'erano solo `addWorkflowStep` e
 * `addWorkflowTransition`, che pretendono una definizione già esistente. Un
 * tenant senza workflow — `c-two` lo era — non ne usciva dall'interfaccia: ogni
 * `createIncident` si fermava, e il rimedio era `migrate --force --to
 * 20260918_1910_provision_tenant_data` dalla riga di comando. Lo stato è
 * raggiungibile anche dopo quella migrazione: basta disattivare un workflow.
 *
 * `provisionTenantData` esiste dall'ondata 8, è idempotente e non riallinea le
 * definizioni esistenti al seme (una definizione che c'è viene SALTATA, non
 * sovrascritta): mancava solo la porta per chiamarla.
 */
async function tenantProvisioningGapsQuery(_: unknown, __: unknown, ctx: GraphQLContext) {
  requireRole(ctx, 'admin')
  const gaps = await withSession((session) => tenantProvisioningGaps(session as unknown as Queryable, ctx.tenantId))
  return mapGaps(gaps)
}

async function provisionTenantDataMutation(_: unknown, __: unknown, ctx: GraphQLContext) {
  requireRole(ctx, 'admin')
  const result = await withSession((session) => provisionTenantData(session, ctx.tenantId, { userId: ctx.userId }), true)
  // I workflow nuovi cambiano i metadata dei passi che tutto il resto legge.
  invalidateWorkflowCache(ctx.tenantId)
  // E LA LEVA DEL METAMODELLO (terza revisione · M2). `provisionTenantData`
  // semina anche le MATRICI DI DOMINIO (`seedDomainMatrices`, un MERGE su
  // `:DomainMatrix`), cioè scrive metamodello — e questa mutation invalidava
  // solo la cache dei workflow. Il lint `metamodelInvalidation.test.ts` non la
  // vedeva perché la Cypher sta in `lib/`, ed era esentata con la motivazione
  // «chiamato solo dagli script», che il codice smentisce: il chiamante è
  // proprio questa mutation.
  invalidateSchema(ctx.tenantId)
  void audit(ctx, 'tenant.provisioned', 'Tenant', ctx.tenantId, {
    dashboard: result.dashboardCreated,
    notificationRules: result.notificationRulesCreated,
    matrices: result.matricesCreated,
    workflows: result.workflows.map((w) => w.name),
  })
  const gaps = await withSession((session) => tenantProvisioningGaps(session as unknown as Queryable, ctx.tenantId))
  return {
    dashboardCreated:         result.dashboardCreated,
    notificationRulesCreated: result.notificationRulesCreated,
    matricesCreated:          [...result.matricesCreated],
    workflows:                result.workflows.map((w) => w.name),
    remainingGaps:            mapGaps(gaps),
  }
}

export const workflowResolvers = {
  Query: {
    tenantProvisioningGaps: tenantProvisioningGapsQuery,
    incidentWorkflow,
    incidentAvailableTransitions,
    incidentWorkflowHistory,
    workflowDefinition,
    workflowDefinitionById,
    workflowDefinitions,
  },
  Mutation: {
    provisionTenantData: provisionTenantDataMutation,
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
