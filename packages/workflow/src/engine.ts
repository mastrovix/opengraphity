import { v4 as uuidv4 } from 'uuid'
import type { Session } from 'neo4j-driver'
import type {
  WorkflowInstance,
  WorkflowActionConfig,
  TransitionInput,
  TransitionResult,
} from './types.js'
import { runAction } from './actions.js'

export class WorkflowEngine {

  /**
   * Crea una nuova istanza workflow per un'entità.
   * Collega entity -[:HAS_WORKFLOW]-> WorkflowInstance -[:CURRENT_STEP]-> WorkflowStep(start)
   */
  async createInstance(
    session: Session,
    tenantId: string,
    entityId: string,
    entityType: string,
  ): Promise<WorkflowInstance> {
    const instanceId = uuidv4()
    const execId     = uuidv4()
    const now        = new Date().toISOString()

    return session.executeWrite(async (tx) => {
      // Trova la definizione attiva e il suo step di start
      const defResult = await tx.run(`
        MATCH (wd:WorkflowDefinition {
          tenant_id:   $tenantId,
          entity_type: $entityType,
          active:      true
        })
        MATCH (wd)-[:HAS_STEP]->(startStep:WorkflowStep {type: 'start'})
        RETURN wd.id AS defId, startStep.id AS stepId, startStep.name AS stepName
        LIMIT 1
      `, { tenantId, entityType })

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
    })
  }

  /**
   * Esegue una transizione da step corrente a toStepName.
   * Aggiorna l'istanza, crea il nuovo StepExecution, sincronizza lo status dell'entità,
   * ed esegue le azioni exit/enter configurate.
   */
  async transition(
    session: Session,
    input: TransitionInput,
    context: { userId: string },
  ): Promise<TransitionResult> {
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
            nextStep.id              AS nextStepId,
            nextStep.name            AS nextStepName,
            nextStep.type            AS nextStepType,
            nextStep.enter_actions   AS nextEnterActions,
            tr.condition             AS condition,
            exec.entered_at          AS enteredAt
          LIMIT 1
        `, { instanceId: input.instanceId, toStepName: input.toStepName }),
      )

      if (stateResult.records.length === 0) {
        return {
          success: false,
          error:   `Transizione verso "${input.toStepName}" non valida dallo step corrente`,
        } as unknown as TransitionResult
      }

      const rec          = stateResult.records[0]
      const wi           = rec.get('wi').properties as Record<string, unknown>
      const nextStepId   = rec.get('nextStepId')    as string
      const nextStepName = rec.get('nextStepName')  as string
      const nextStepType = rec.get('nextStepType')  as string
      const condition    = rec.get('condition')     as string | null
      const enteredAt    = rec.get('enteredAt')     as string | null
      const exitActionsRaw   = rec.get('exitActions')    as string | null
      const enterActionsRaw  = rec.get('nextEnterActions') as string | null

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

      // 4. Transazione Neo4j: aggiorna istanza + storia
      const execId = uuidv4()
      await session.executeWrite((tx) =>
        tx.run(`
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
        }),
      )

      // 5. Sincronizza status sull'entità (Incident, ecc.)
      await session.executeWrite((tx) => {
        if (nextStepName === 'resolved') {
          return tx.run(`
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
        }
        return tx.run(`
          MATCH (entity {id: $entityId, tenant_id: $tenantId})
          SET entity.status     = $status,
              entity.updated_at = $now
        `, {
          entityId: wi['entity_id'] as string,
          tenantId: wi['tenant_id'] as string,
          status:   nextStepName,
          now,
        })
      })

      // 6. Esegui exit actions dello step corrente + enter actions del prossimo
      const exitActions:  WorkflowActionConfig[] = JSON.parse(exitActionsRaw  ?? '[]')
      const enterActions: WorkflowActionConfig[] = JSON.parse(enterActionsRaw ?? '[]')
      const actionsRun:   string[]               = []

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
          await runAction(action, instance, { userId: context.userId, notes: input.notes })
          actionsRun.push(action.type)
        } catch (e) {
          console.error(`[workflow] Action "${action.type}" failed:`, e)
          // Non bloccare la transizione se un'azione fallisce
        }
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
