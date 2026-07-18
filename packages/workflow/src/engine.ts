import { v4 as uuidv4 } from 'uuid'
import type { Session, ManagedTransaction } from 'neo4j-driver'
import pino from 'pino'
import type {
  WorkflowInstance,
  WorkflowActionConfig,
  TransitionInput,
  TransitionResult,
  ActionContext,
} from './types.js'
import { runAction } from './actions.js'

const workflowLogger = pino({ level: process.env['LOG_LEVEL'] ?? 'info' }).child({ module: 'workflow' })

/** A Session has executeWrite; a ManagedTransaction (tx inside executeWrite) does not. */
function isSession(s: Session | ManagedTransaction): s is Session {
  return typeof (s as Session).executeWrite === 'function'
}

export class WorkflowEngine {

  /**
   * Crea una nuova istanza workflow per un'entità.
   * Collega entity -[:HAS_WORKFLOW]-> WorkflowInstance -[:CURRENT_STEP]-> WorkflowStep(start)
   *
   * Accetta una Session (apre la propria executeWrite, comportamento storico)
   * oppure una ManagedTransaction: in tal caso partecipa alla transazione
   * esterna del chiamante — tutte le scritture committano/rollbackano insieme.
   */
  async createInstance(
    session: Session | ManagedTransaction,
    tenantId: string,
    entityId: string,
    entityType: string,
    definitionId?: string,
    category?: string | null,
  ): Promise<WorkflowInstance> {
    const instanceId = uuidv4()
    const execId     = uuidv4()
    const now        = new Date().toISOString()

    const work = async (tx: ManagedTransaction): Promise<WorkflowInstance> => {
      // If definitionId is provided, use it directly; otherwise use category-aware selection
      let defQuery: string
      let defParams: Record<string, unknown>

      if (definitionId) {
        defQuery = `
          MATCH (wd:WorkflowDefinition {id: $definitionId, tenant_id: $tenantId, active: true})
          MATCH (wd)-[:HAS_STEP]->(startStep:WorkflowStep {type: 'start'})
          RETURN wd.id AS defId, startStep.id AS stepId, startStep.name AS stepName
          LIMIT 1
        `
        defParams = { definitionId, tenantId }
      } else {
        // Category-aware selection: prefer category-specific, fallback to default (category IS NULL)
        defQuery = `
          MATCH (wd:WorkflowDefinition {tenant_id: $tenantId, entity_type: $entityType, active: true})
          MATCH (wd)-[:HAS_STEP]->(startStep:WorkflowStep {type: 'start'})
          WITH wd, startStep,
            CASE
              WHEN wd.category IS NOT NULL AND wd.category = $category THEN 0
              WHEN wd.category IS NULL THEN 1
              ELSE 2
            END AS priority
          WHERE priority < 2
          RETURN wd.id AS defId, startStep.id AS stepId, startStep.name AS stepName
          ORDER BY priority ASC
          LIMIT 1
        `
        defParams = { tenantId, entityType, category: category ?? null }
      }

      const defResult = await tx.run(defQuery, defParams)

      if (defResult.records.length === 0) {
        throw new Error(`No active workflow definition for "${entityType}" in tenant "${tenantId}"`)
      }

      const rec      = defResult.records[0]
      const defId    = rec.get('defId')    as string
      const stepId   = rec.get('stepId')   as string
      const stepName = rec.get('stepName') as string

      // Crea istanza, collega entità e step iniziale, crea primo StepExecution
      await tx.run(`
        MATCH (entity {id: $entityId, tenant_id: $tenantId})
        MATCH (startStep:WorkflowStep {id: $stepId})
        CREATE (wi:WorkflowInstance {
          id:            $instanceId,
          tenant_id:     $tenantId,
          definition_id: $defId,
          entity_id:     $entityId,
          entity_type:   $entityType,
          current_step:  $stepName,
          status:        'active',
          created_at:    $now,
          updated_at:    $now
        })
        CREATE (entity)-[:HAS_WORKFLOW]->(wi)
        CREATE (wi)-[:CURRENT_STEP]->(startStep)
        CREATE (wi)-[:STEP_HISTORY]->(:WorkflowStepExecution {
          id:           $execId,
          tenant_id:    $tenantId,
          instance_id:  $instanceId,
          step_name:    $stepName,
          entered_at:   $now,
          exited_at:    null,
          duration_ms:  null,
          triggered_by: 'system',
          trigger_type: 'automatic',
          notes:        null
        })
      `, { entityId, tenantId, stepId, instanceId, defId, entityType, stepName, now, execId })

      return {
        id:           instanceId,
        tenantId,
        definitionId: defId,
        entityId,
        entityType,
        currentStep:  stepName,
        status:       'active',
        createdAt:    now,
        updatedAt:    now,
      } satisfies WorkflowInstance
    }

    if (isSession(session)) return session.executeWrite(work)
    return work(session)
  }

  /**
   * Esegue una transizione da step corrente a toStepName.
   * Aggiorna l'istanza, crea il nuovo StepExecution, sincronizza lo status dell'entità,
   * ed esegue le azioni exit/enter configurate.
   */
  async transition(
    session: Session,
    input: TransitionInput,
    context: ActionContext,
  ): Promise<TransitionResult> {
    console.log('[workflow-engine] transition() called with toStepName:', input.toStepName)
    const now = new Date().toISOString()

    try {
      // 1. Leggi stato corrente + transizione valida
      const stateResult = await session.executeRead((tx) =>
        tx.run(`
          MATCH (wi:WorkflowInstance {id: $instanceId})
          MATCH (wi)-[:CURRENT_STEP]->(currentStep:WorkflowStep)
          MATCH (currentStep)-[tr:TRANSITIONS_TO]->(nextStep:WorkflowStep {name: $toStepName})
          OPTIONAL MATCH (wi)-[:STEP_HISTORY]->(exec:WorkflowStepExecution)
            WHERE exec.exited_at IS NULL
          RETURN
            wi,
            currentStep.id           AS currentStepId,
            currentStep.exit_actions AS exitActions,
            nextStep.id                   AS nextStepId,
            nextStep.name                 AS nextStepName,
            nextStep.type                 AS nextStepType,
            nextStep.enter_actions        AS nextEnterActions,
            nextStep.timer_delay_minutes  AS timerDelayMinutes,
            nextStep.sub_workflow_id      AS subWorkflowId,
            tr.condition                  AS condition,
            exec.entered_at               AS enteredAt
          LIMIT 1
        `, { instanceId: input.instanceId, toStepName: input.toStepName }),
      )

      if (stateResult.records.length === 0) {
        return {
          success: false,
          error:   `Transizione verso "${input.toStepName}" non valida dallo step corrente`,
        } as unknown as TransitionResult
      }

      const rec               = stateResult.records[0]
      const wi                = rec.get('wi').properties as Record<string, unknown>
      const nextStepId        = rec.get('nextStepId')         as string
      const nextStepName      = rec.get('nextStepName')       as string
      const nextStepType      = rec.get('nextStepType')       as string
      const timerDelayMinutes = rec.get('timerDelayMinutes')  as number | null
      const subWorkflowId     = rec.get('subWorkflowId')      as string | null
      const condition         = rec.get('condition')          as string | null
      const enteredAt         = rec.get('enteredAt')          as string | null
      const exitActionsRaw    = rec.get('exitActions')        as string | null
      const enterActionsRaw   = rec.get('nextEnterActions')   as string | null

      // 2. Verifica condizione
      if (condition === 'rootCause != null' && !input.notes) {
        return {
          success: false,
          error:   'Root cause obbligatoria per questa transizione',
        } as unknown as TransitionResult
      }

      // 3. Calcola durata step corrente
      const durationMs = enteredAt
        ? Date.now() - new Date(enteredAt).getTime()
        : null

      // Parse delle azioni PRIMA di qualsiasi write: una config corrotta deve
      // far fallire la transizione senza toccare il DB, non dopo (stato misto).
      let exitActions:  WorkflowActionConfig[]
      let enterActions: WorkflowActionConfig[]
      try {
        exitActions  = JSON.parse(exitActionsRaw  ?? '[]') as WorkflowActionConfig[]
        enterActions = JSON.parse(enterActionsRaw ?? '[]') as WorkflowActionConfig[]
      } catch (e) {
        return {
          success: false,
          error:   `Corrupt step actions JSON (step ${nextStepName}): ${e instanceof Error ? e.message : String(e)}`,
        } as unknown as TransitionResult
      }

      // 4+5. Transazione Neo4j UNICA e atomica: avanzamento istanza + storia +
      // sync dello status sull'entità. Due write separate lasciavano, in caso
      // di errore sulla seconda, la WI avanzata e l'entità no.
      const execId = uuidv4()
      await session.executeWrite(async (tx) => {
        await tx.run(`
          // Chiudi StepExecution corrente
          MATCH (wi:WorkflowInstance {id: $instanceId})-[:STEP_HISTORY]->(exec:WorkflowStepExecution)
            WHERE exec.exited_at IS NULL
          SET exec.exited_at   = $now,
              exec.duration_ms = $durationMs

          WITH wi
          // Sposta CURRENT_STEP al prossimo step
          MATCH (wi)-[r:CURRENT_STEP]->()
          DELETE r
          WITH wi
          MATCH (nextStep:WorkflowStep {id: $nextStepId})
          CREATE (wi)-[:CURRENT_STEP]->(nextStep)
          SET wi.current_step = $nextStepName,
              wi.updated_at   = $now,
              wi.status       = $wiStatus

          WITH wi
          // Crea nuovo StepExecution
          CREATE (wi)-[:STEP_HISTORY]->(:WorkflowStepExecution {
            id:           $execId,
            tenant_id:    $tenantId,
            instance_id:  $instanceId,
            step_name:    $nextStepName,
            entered_at:   $now,
            exited_at:    null,
            duration_ms:  null,
            triggered_by: $triggeredBy,
            trigger_type: $triggerType,
            notes:        $notes
          })
        `, {
          instanceId:   input.instanceId,
          now,
          durationMs,
          nextStepId,
          nextStepName,
          wiStatus:     nextStepType === 'end' ? 'completed' : 'active',
          execId,
          tenantId:     wi['tenant_id'] as string,
          triggeredBy:  input.triggeredBy,
          triggerType:  input.triggerType,
          notes:        input.notes ?? null,
        })

        // Sync dello status sull'entità — stessa transazione dell'avanzamento WI
        if (nextStepName === 'resolved') {
          await tx.run(`
            MATCH (entity {id: $entityId, tenant_id: $tenantId})
            SET entity.status      = 'resolved',
                entity.root_cause  = $rootCause,
                entity.resolved_at = $now,
                entity.updated_at  = $now
          `, {
            entityId:  wi['entity_id'] as string,
            tenantId:  wi['tenant_id'] as string,
            rootCause: input.notes ?? null,
            now,
          })
        } else {
          await tx.run(`
            MATCH (entity {id: $entityId, tenant_id: $tenantId})
            SET entity.status     = $status,
                entity.updated_at = $now
          `, {
            entityId: wi['entity_id'] as string,
            tenantId: wi['tenant_id'] as string,
            status:   nextStepName,
            now,
          })
        }
      })

      // 6. Esegui exit actions dello step corrente + enter actions del prossimo.
      // La transizione è già persistita: un'azione fallita non è più annullabile,
      // ma NON deve sparire — finisce in actionErrors e i chiamanti la mostrano.
      const actionsRun:    string[] = []
      const actionErrors:  string[] = []

      const instance: WorkflowInstance = {
        id:           wi['id']            as string,
        tenantId:     wi['tenant_id']     as string,
        definitionId: wi['definition_id'] as string,
        entityId:     wi['entity_id']     as string,
        entityType:   wi['entity_type']   as string,
        currentStep:  nextStepName,
        status:       nextStepType === 'end' ? 'completed' : 'active',
        createdAt:    wi['created_at']    as string,
        updatedAt:    now,
      }

      for (const action of [...exitActions, ...enterActions]) {
        try {
          await runAction(action, instance, { ...context, notes: context.notes ?? input.notes })
          actionsRun.push(action.type)
        } catch (e) {
          const msg = `${action.type}: ${e instanceof Error ? e.message : String(e)}`
          workflowLogger.error({ err: e, actionType: action.type, instanceId: input.instanceId }, 'Workflow action failed')
          actionErrors.push(msg)
        }
      }

      // Schedule timer job when entering timer_wait step. Failing to schedule
      // (or a timer step with no automatic exit) leaves the workflow stuck
      // forever — that is an actionError, not a log line.
      if (nextStepType === 'timer_wait' && timerDelayMinutes && timerDelayMinutes > 0) {
        try {
          const { Queue } = await import('bullmq')
          const { getRedisOptions } = await import('@opengraphity/events')
          const queue = new Queue('notification-jobs', { connection: getRedisOptions() })
          // Find the automatic transition from this step to know where to go
          const nextTransRes = await session.executeRead(tx =>
            tx.run(`
              MATCH (step:WorkflowStep {id: $stepId})-[tr:TRANSITIONS_TO {trigger: 'automatic'}]->(nextStep:WorkflowStep)
              RETURN nextStep.name AS toStep LIMIT 1
            `, { stepId: nextStepId }),
          )
          const toStep = nextTransRes.records[0]?.get('toStep') as string | null
          if (toStep) {
            await queue.add('timer_wait', {
              instanceId: input.instanceId,
              toStep,
              tenantId:   wi['tenant_id'] as string,
            }, { delay: timerDelayMinutes * 60 * 1000 })
            workflowLogger.info({ instanceId: input.instanceId, toStep, delayMinutes: timerDelayMinutes }, '[workflow-engine] timer_wait job scheduled')
          } else {
            const msg = `timer_wait: step "${nextStepName}" has no automatic transition — the workflow will never leave this step`
            workflowLogger.error({ instanceId: input.instanceId, stepName: nextStepName }, `[workflow-engine] ${msg}`)
            actionErrors.push(msg)
          }
          await queue.close()
        } catch (e) {
          const msg = `timer_wait scheduling failed: ${e instanceof Error ? e.message : String(e)} — the workflow will never leave step "${nextStepName}"`
          workflowLogger.error({ err: e, instanceId: input.instanceId }, `[workflow-engine] ${msg}`)
          actionErrors.push(msg)
        }
      }

      // Schedule sub_workflow creation when entering sub_workflow step
      if (nextStepType === 'sub_workflow' && subWorkflowId) {
        workflowLogger.info({ instanceId: input.instanceId, subWorkflowId }, '[workflow-engine] sub_workflow step entered — sub-workflow definitionId stored')
      }

      return {
        success:    true,
        instance,
        execution: {
          id:          execId,
          tenantId:    wi['tenant_id'] as string,
          instanceId:  input.instanceId,
          stepName:    nextStepName,
          enteredAt:   now,
          exitedAt:    null,
          durationMs:  null,
          triggeredBy: input.triggeredBy,
          triggerType: input.triggerType,
          notes:       input.notes ?? null,
        },
        actionsRun: actionsRun as WorkflowInstance['status'][],
        ...(actionErrors.length > 0 ? { actionErrors } : {}),
      } as unknown as TransitionResult

    } catch (error: unknown) {
      return {
        success: false,
        error:   error instanceof Error ? error.message : String(error),
      } as unknown as TransitionResult
    }
  }

  /** Transizioni manuali disponibili dallo step corrente */
  async getAvailableTransitions(session: Session, instanceId: string) {
    const result = await session.executeRead((tx) =>
      tx.run(`
        MATCH (wi:WorkflowInstance {id: $instanceId})
        MATCH (wi)-[:CURRENT_STEP]->(current:WorkflowStep)
        MATCH (current)-[tr:TRANSITIONS_TO {trigger: 'manual'}]->(next:WorkflowStep)
        RETURN
          next.name        AS toStep,
          tr.label         AS label,
          tr.requires_input AS requiresInput,
          tr.input_field   AS inputField,
          tr.condition     AS condition
        ORDER BY next.name
      `, { instanceId }),
    )

    return result.records.map((r) => ({
      toStep:        r.get('toStep')        as string,
      label:         r.get('label')         as string,
      requiresInput: r.get('requiresInput') as boolean,
      inputField:    r.get('inputField')    as string | null,
      condition:     r.get('condition')     as string | null,
    }))
  }

  /** Storia completa di un'istanza (step eseguiti) */
  async getHistory(session: Session, instanceId: string) {
    const result = await session.executeRead((tx) =>
      tx.run(`
        MATCH (wi:WorkflowInstance {id: $instanceId})-[:STEP_HISTORY]->(exec:WorkflowStepExecution)
        RETURN exec
        ORDER BY exec.entered_at ASC
      `, { instanceId }),
    )

    return result.records.map((r) => r.get('exec').properties as Record<string, unknown>)
  }
}

export const workflowEngine = new WorkflowEngine()
