import { v4 as uuidv4 } from 'uuid'
import { parseLocalizedLabels } from './labels.js'
import type { Session, ManagedTransaction } from 'neo4j-driver'
import pino from 'pino'
import { toNumber as neo4jToNumber } from '@opengraphity/neo4j'
import type {
  WorkflowInstance,
  WorkflowActionConfig,
  TransitionInput,
  TransitionResult,
  TransitionErrorI18n,
  ActionContext,
  ConditionContext,
  ConditionEvaluator,
  StepEnteredListener,
} from './types.js'
import { WORKFLOW_ACTION_TYPES, isWorkflowActionType } from './types.js'
import { runAction } from './actions.js'

const workflowLogger = pino({ level: process.env['LOG_LEVEL'] ?? 'info' }).child({ module: 'workflow' })

/** A Session has executeWrite; a ManagedTransaction (tx inside executeWrite) does not. */
function isSession(s: Session | ManagedTransaction): s is Session {
  return typeof (s as Session).executeWrite === 'function'
}

/**
 * Label Neo4j ammesse per il sync dello status: entity_type → label.
 * Allowlist esplicita: la label finisce nel Cypher (non parametrizzabile) e
 * un match senza label scriverebbe lo status su qualunque nodo con quell'id.
 */
export const ENTITY_LABELS: Record<string, string> = {
  incident:        'Incident',
  problem:         'Problem',
  change:          'Change',
  service_request: 'ServiceRequest',
  kb_article:      'KBArticle',
}

// Neo4j Integer (o numero nativo) → number: helper unico di @opengraphity/neo4j (D-22).
const toNumber = neo4jToNumber

function fail(error: string, errorI18n?: TransitionErrorI18n): TransitionResult {
  return { success: false, error, ...(errorI18n ? { errorI18n } : {}) } as unknown as TransitionResult
}

interface RegisteredCondition {
  evaluate:       ConditionEvaluator
  failureMessage: string
  failureKey:     string
}

/**
 * Chiave della frase mostrata quando la condizione `name` non è soddisfatta.
 * Il messaggio registrato resta per i log; chi mostra l'errore a una persona
 * usa la chiave, e se la chiave non esiste nella lingua ricade sul messaggio.
 */
export function conditionFailureKey(name: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Transition condition "${name}" has no i18n key of its own: pass failureKey to registerCondition`)
  }
  return `errors.workflow.condition.${name}`
}

class ConcurrentTransitionError extends Error {}

export class WorkflowEngine {
  private readonly conditions = new Map<string, RegisteredCondition>()
  private readonly stepEnteredListeners: StepEnteredListener[] = []

  /**
   * Chi ascolta l'ingresso in un passo (vedi `StepEnteredInfo`). Chiamato dopo
   * che la transizione è persistita e dopo le azioni del passo; un ascoltatore
   * che fallisce non annulla la transizione ma finisce in `actionErrors`.
   */
  onStepEntered(listener: StepEnteredListener): void {
    this.stepEnteredListeners.push(listener)
  }

  constructor() {
    // Unica condizione built-in: dipende solo dall'input (le note), non dal dominio.
    this.registerCondition('rootCause != null', async (_s, c) => !!c.notes?.trim(), 'A root cause is required for this transition', 'errors.workflow.condition.rootCauseRequired')
  }

  // ── Registro condizioni ────────────────────────────────────────────────────

  /** Registra (o sostituisce) l'evaluator di una condizione di transizione. */
  registerCondition(name: string, evaluate: ConditionEvaluator, failureMessage?: string, failureKey?: string): void {
    this.conditions.set(name, {
      evaluate,
      failureMessage: failureMessage ?? `Transition condition "${name}" is not satisfied`,
      failureKey:     failureKey ?? conditionFailureKey(name),
    })
  }

  hasCondition(name: string): boolean {
    return this.conditions.has(name)
  }

  /** Valuta una condizione registrata; lancia se sconosciuta (workflow mal configurato). */
  async evaluateCondition(session: Session, name: string, ctx: ConditionContext): Promise<boolean> {
    const reg = this.conditions.get(name)
    if (!reg) throw new Error(`Unknown transition condition "${name}": register it with registerCondition or fix the workflow`)
    return reg.evaluate(session, ctx)
  }

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
      let defQuery: string
      let defParams: Record<string, unknown>

      // Il passo di partenza è quello che il DATO dichiara iniziale
      // (`is_initial`), non quello che si chiama `type='start'`: il disegnatore
      // sposta «Step iniziale» scrivendo `is_initial`, e senza questa lettura
      // l'entità nasceva con `status` = passo marcato e `current_step` = vecchio
      // `start` (B-8). `coalesce(is_initial, type='start')` è la stessa regola di
      // `getInitialStepName` nell'API: una sorgente sola. Se per sbaglio ne
      // risultano due, vince quello con `is_initial` esplicito.
      const INITIAL_STEP = `
          MATCH (wd)-[:HAS_STEP]->(startStep:WorkflowStep)
          WHERE coalesce(startStep.is_initial, startStep.type = 'start')
          WITH wd, startStep, CASE WHEN startStep.is_initial = true THEN 0 ELSE 1 END AS stepPriority`

      if (definitionId) {
        defQuery = `
          MATCH (wd:WorkflowDefinition {id: $definitionId, tenant_id: $tenantId, active: true})
          ${INITIAL_STEP}
          RETURN wd.id AS defId, startStep.id AS stepId, startStep.name AS stepName
          ORDER BY stepPriority ASC, startStep.name ASC
          LIMIT 1
        `
        defParams = { definitionId, tenantId }
      } else {
        // Category-aware selection: prefer category-specific, fallback to default (category IS NULL)
        defQuery = `
          MATCH (wd:WorkflowDefinition {tenant_id: $tenantId, entity_type: $entityType, active: true})
          ${INITIAL_STEP},
            CASE
              WHEN wd.category IS NOT NULL AND wd.category = $category THEN 0
              WHEN wd.category IS NULL THEN 1
              ELSE 2
            END AS priority
          WHERE priority < 2
          RETURN wd.id AS defId, startStep.id AS stepId, startStep.name AS stepName, wd.category AS defCategory
          ORDER BY priority ASC, wd.version DESC, stepPriority ASC, startStep.name ASC
          LIMIT 1
        `
        defParams = { tenantId, entityType, category: category ?? null }
      }

      const defResult = await tx.run(defQuery, defParams)
      if (defResult.records.length === 0) {
        // Distinguere «non c'è definizione» da «c'è ma nessun passo è iniziale»:
        // il secondo caso è una definizione mal configurata dal disegnatore e
        // dirlo «non c'è nessuna definizione» manderebbe a cercare la cosa
        // sbagliata.
        const anyDef = await tx.run(
          definitionId
            ? `MATCH (wd:WorkflowDefinition {id: $definitionId, tenant_id: $tenantId, active: true})
               OPTIONAL MATCH (wd)-[:HAS_STEP]->(st:WorkflowStep)
                 WHERE coalesce(st.is_initial, st.type = 'start')
               RETURN wd.name AS name, wd.category AS category, count(st) AS initials LIMIT 1`
            : `MATCH (wd:WorkflowDefinition {tenant_id: $tenantId, entity_type: $entityType, active: true})
               OPTIONAL MATCH (wd)-[:HAS_STEP]->(st:WorkflowStep)
                 WHERE coalesce(st.is_initial, st.type = 'start')
               WITH wd, count(st) AS initials
               RETURN wd.name AS name, wd.category AS category, initials
               ORDER BY initials DESC LIMIT 1`,
          defParams,
        )
        if (anyDef.records.length > 0) {
          const row      = anyDef.records[0]!
          const defName  = row.get('name') as string
          const initials = toNumber(row.get('initials'))
          // Terzo caso, che prima veniva scambiato per il secondo (B-13): la
          // definizione c'è, ha un passo iniziale, e non è stata scelta perché
          // la sua CATEGORIA non combacia con quella dell'entità e non esiste
          // una definizione senza categoria su cui ripiegare. Dire «non ha
          // nessuno step iniziale» mandava a cercare la cosa sbagliata.
          if (initials > 0 && !definitionId) {
            throw new Error(
              `No "${entityType}" workflow definition of tenant "${tenantId}" applies to category ` +
              `"${category ?? '(none)'}": "${defName}" is reserved for category "${row.get('category') as string ?? '(none)'}" and there is no ` +
              `definition without a category to fall back on. Align the definition's category with the dictionary, ` +
              `or add a base definition.`,
            )
          }
          throw new Error(
            `Workflow "${defName}" (${entityType}, tenant "${tenantId}") has no initial step: ` +
            `mark a step as initial in the designer.`,
          )
        }
        throw new Error(`No active workflow definition for "${entityType}" in tenant "${tenantId}"`)
      }

      const rec      = defResult.records[0]
      const defId    = rec.get('defId')    as string
      const stepId   = rec.get('stepId')   as string
      const stepName = rec.get('stepName') as string

      // Variante per categoria (B-13): la scelta confronta `wd.category` con la
      // categoria dell'entità per UGUAGLIANZA, e ripiega sulla definizione
      // senza categoria. Il ripiego è giusto — un incident di categoria
      // «network» deve seguire il flusso base — ma finora era **muto**: se il
      // cliente rinominava il valore di vocabolario (`security` → `sicurezza`)
      // la variante restava nel grafo e non veniva più scelta da nessuno, e i
      // ticket di sicurezza seguivano il flusso base senza un solo avviso.
      // Non si può decidere al posto suo (la variante potrebbe essere stata
      // dismessa di proposito), ma si dice.
      if (!definitionId && category != null && category !== '' && rec.get('defCategory') == null) {
        const variants = await tx.run(`
          MATCH (wd:WorkflowDefinition {tenant_id: $tenantId, entity_type: $entityType, active: true})
          WHERE wd.category IS NOT NULL
          RETURN collect(DISTINCT wd.category) AS categories
        `, { tenantId, entityType })
        const categories = (variants.records[0]?.get('categories') ?? []) as string[]
        if (categories.length > 0) {
          workflowLogger.warn(
            { tenantId, entityType, entityId, category, variantCategories: categories },
            `[workflow-engine] nessuna variante di workflow "${entityType}" ha categoria "${category}" ` +
            `(varianti presenti: ${categories.join(', ')}): si usa la definizione base. ` +
            `Se la variante doveva valere, allinea la categoria della definizione al valore del vocabolario.`,
          )
        }
      }

      // Lo start step è cercato DENTRO la definizione scelta: gli id degli step
      // non sono garantiti unici tra definizioni (seed storici `${tenant}-step-new`).
      const res = await tx.run(`
        MATCH (entity {id: $entityId, tenant_id: $tenantId})
        MATCH (wd:WorkflowDefinition {id: $defId})-[:HAS_STEP]->(startStep:WorkflowStep {id: $stepId})
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
        RETURN wi.id AS id
      `, { entityId, tenantId, stepId, instanceId, defId, entityType, stepName, now, execId })
      if (res.records.length === 0) {
        throw new Error(`Cannot create workflow instance: entity ${entityType}/${entityId} not found in tenant "${tenantId}"`)
      }

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
   *
   * Garanzie:
   *  - un trigger 'manual' segue solo archi manuali (archi timer/automatici/
   *    sla_breach non sono invocabili dall'utente);
   *  - la condizione dell'arco è valutata per ogni trigger tramite il registro;
   *  - l'avanzamento è atomico: la scrittura riverifica che CURRENT_STEP sia
   *    ancora lo step letto (due transizioni concorrenti → una sola vince);
   *  - lo status dell'entità è sincronizzato nella stessa transazione, con
   *    label esplicita.
   */
  async transition(
    session: Session,
    input: TransitionInput,
    context: ActionContext,
  ): Promise<TransitionResult> {
    workflowLogger.debug({ instanceId: input.instanceId, toStep: input.toStepName, trigger: input.triggerType }, '[workflow-engine] transition')
    const now = new Date().toISOString()

    try {
      // 1. Stato corrente + arco verso lo step richiesto. Se ci sono più archi
      //    verso lo stesso step (es. manuale + sla_breach) preferisce quello con
      //    il trigger richiesto.
      //
      //    E-29 (revisione totale): la preferenza ora è un ordine TOTALE. Con
      //    un innesco di sistema che non combacia con nessuno dei due archi
      //    (es. `timer` su archi `manual` e `sla_breach`) l'ordine era parziale
      //    e la scelta dipendeva dal piano di esecuzione: la stessa scadenza
      //    poteva passare o essere rifiutata «root cause required» a caso.
      //    A pari innesco vince l'arco CON la condizione — una guardia scritta
      //    dal cliente non si scavalca per via di un arco più permissivo — e a
      //    pari condizione decide l'id, che è stabile.
      const stateResult = await session.executeRead((tx) =>
        tx.run(`
          MATCH (wi:WorkflowInstance {id: $instanceId})
          WHERE $tenantId IS NULL OR wi.tenant_id = $tenantId
          MATCH (wi)-[:CURRENT_STEP]->(currentStep:WorkflowStep)
          MATCH (currentStep)-[tr:TRANSITIONS_TO]->(nextStep:WorkflowStep {name: $toStepName})
          OPTIONAL MATCH (wi)-[:STEP_HISTORY]->(exec:WorkflowStepExecution)
            WHERE exec.exited_at IS NULL
          RETURN
            wi,
            currentStep.id           AS currentStepId,
            currentStep.name         AS currentStepName,
            currentStep.exit_actions AS exitActions,
            currentStep.category     AS currentStepCategory,
            coalesce(currentStep.is_initial, currentStep.type = 'start') AS currentStepInitial,
            nextStep.id                   AS nextStepId,
            nextStep.name                 AS nextStepName,
            nextStep.type                 AS nextStepType,
            nextStep.category             AS nextStepCategory,
            coalesce(nextStep.is_terminal, nextStep.type = 'end') AS nextStepTerminal,
            nextStep.enter_actions        AS nextEnterActions,
            nextStep.timer_delay_minutes  AS timerDelayMinutes,
            nextStep.sub_workflow_id      AS subWorkflowId,
            tr.trigger                    AS trigger,
            tr.condition                  AS condition,
            exec.entered_at               AS enteredAt
          ORDER BY CASE WHEN tr.trigger = $triggerType THEN 0 ELSE 1 END,
                   CASE WHEN tr.condition IS NULL THEN 1 ELSE 0 END,
                   tr.id
          LIMIT 1
        `, { instanceId: input.instanceId, toStepName: input.toStepName, triggerType: input.triggerType, tenantId: input.tenantId ?? null }),
      )

      if (stateResult.records.length === 0) {
        return fail(`Transition to "${input.toStepName}" is not valid from the current step`,
          { key: 'errors.workflow.transitionNotValid', params: { step: input.toStepName } })
      }

      const rec               = stateResult.records[0]
      const wi                = rec.get('wi').properties as Record<string, unknown>
      const currentStepId     = rec.get('currentStepId')      as string
      const currentStepName   = rec.get('currentStepName')    as string
      const currentStepInitial = Boolean(rec.get('currentStepInitial'))
      const nextStepId        = rec.get('nextStepId')         as string
      const nextStepName      = rec.get('nextStepName')       as string
      const nextStepType      = rec.get('nextStepType')       as string
      // Metadata del passo di arrivo: sono LORO a dire cos'è quel passo, non
      // il suo nome (B-5 / B-20). `category` e `is_terminal` sono quello che il
      // cliente vede e cambia nel disegnatore.
      const nextStepCategory  = (rec.get('nextStepCategory') ?? null) as string | null
      const nextStepTerminal  = Boolean(rec.get('nextStepTerminal'))
      // Il passo di RISOLUZIONE si riconosce dalla categoria, come già fa
      // `incidentStepInfo` lato API. Prima era `nextStepName === 'resolved'`:
      // un cliente che chiamava «Risolto» (o «Chiuso tecnicamente») il proprio
      // passo di risoluzione non vedeva più valorizzati `resolved_at` e
      // `root_cause` — e da lì il digest «risolti oggi» restava a zero, in
      // silenzio.
      const nextStepResolves  = nextStepCategory === 'resolved'
      // Giro UI del 15 set 2026 · U-7: uscire dal passo di risoluzione verso un
      // passo aperto è una RIAPERTURA. Il ticket mostrava ancora «Resolved il…»
      // e la root cause di prima mentre era di nuovo in lavorazione. Scelta del
      // proprietario: si svuotano, la risoluzione precedente resta nella
      // timeline (esecuzione del passo e commento con la causa).
      const currentStepResolved = rec.get('currentStepCategory') === 'resolved'
      // Una sola nozione di «terminale»: `is_terminal` con ripiego su
      // `type = 'end'`, la stessa di `workflowHelpers`. Prima l'istanza
      // diventava `completed` solo per `type = 'end'`, quindi un passo
      // `standard` marcato terminale dal disegnatore (come `resolved` di
      // fabbrica) lasciava l'istanza `active`: i contatori su `wi.status` e
      // quelli su `is_terminal` dicevano cose diverse.
      const wiStatus: WorkflowInstance['status'] = nextStepTerminal ? 'completed' : 'active'
      const timerDelayMinutes = rec.get('timerDelayMinutes')  as unknown
      const subWorkflowId     = rec.get('subWorkflowId')      as string | null
      const trigger           = rec.get('trigger')            as string | null
      const condition         = rec.get('condition')          as string | null
      const enteredAt         = rec.get('enteredAt')          as string | null
      const exitActionsRaw    = rec.get('exitActions')        as string | null
      const enterActionsRaw   = rec.get('nextEnterActions')   as string | null

      // 2. Trigger: un utente non può percorrere archi riservati al sistema.
      if (input.triggerType === 'manual' && trigger !== 'manual') {
        return fail(`Transition to "${input.toStepName}" is reserved to the system (trigger "${trigger ?? 'none'}") and cannot be run manually`,
          { key: 'errors.workflow.transitionSystemOnly', params: { step: input.toStepName } })
      }

      // 3. Condizione dell'arco, valutata per OGNI trigger tramite il registro.
      if (condition) {
        const reg = this.conditions.get(condition)
        if (!reg) {
          return fail(`Unknown transition condition "${condition}": register it with registerCondition or fix the workflow`,
            { key: 'errors.workflow.unknownCondition', params: { condition } })
        }
        const condCtx: ConditionContext = {
          instanceId:   input.instanceId,
          entityId:     wi['entity_id']   as string,
          entityType:   wi['entity_type'] as string,
          tenantId:     wi['tenant_id']   as string,
          fromStepName: currentStepName,
          toStepName:   nextStepName,
          triggerType:  input.triggerType,
          notes:        input.notes ?? context.notes,
          entityData:   context.entityData,
        }
        const ok = await reg.evaluate(session, condCtx)
        if (!ok) return fail(reg.failureMessage, { key: reg.failureKey, params: { condition } })
      }

      const entityType = wi['entity_type'] as string
      const label = ENTITY_LABELS[entityType]
      if (!label) {
        return fail(`entity_type "${entityType}" is not allowed for status sync (add it to ENTITY_LABELS)`)
      }

      // 4. Durata step corrente
      const durationMs = enteredAt ? Date.now() - new Date(enteredAt).getTime() : null

      // Parse delle azioni PRIMA di qualsiasi write: una config corrotta deve
      // far fallire la transizione senza toccare il DB, non dopo (stato misto).
      let exitActions:  WorkflowActionConfig[]
      let enterActions: WorkflowActionConfig[]
      try {
        exitActions  = JSON.parse(exitActionsRaw  ?? '[]') as WorkflowActionConfig[]
        enterActions = JSON.parse(enterActionsRaw ?? '[]') as WorkflowActionConfig[]
      } catch (e) {
        return fail(`Corrupt step actions JSON (step ${nextStepName}): ${e instanceof Error ? e.message : String(e)}`)
      }

      // Vocabolario delle azioni (B0-5): un tipo che il motore non conosce è
      // configurazione corrotta (o scritta per un motore diverso: il
      // vocabolario delle automazioni è un altro). Prima l'azione veniva
      // tentata DOPO la transizione e l'errore finiva in `actionErrors`, che
      // per gli incident il web non chiede nemmeno: la transizione passava e
      // l'azione non avveniva, senza che nessuno lo sapesse. Ora la
      // transizione si FERMA prima di scrivere e dice quale azione.
      const unknownActions = [
        ...exitActions.map((a, i) => ({ a, where: `exit_actions[${i}] di "${currentStepName}"` })),
        ...enterActions.map((a, i) => ({ a, where: `enter_actions[${i}] di "${nextStepName}"` })),
      ].filter(({ a }) => !isWorkflowActionType(a?.type))
      if (unknownActions.length > 0) {
        return fail(
          `Unknown workflow action type: ${unknownActions.map(({ a, where }) => `${JSON.stringify(a?.type ?? null)} (${where})`).join(', ')}. ` +
          `Ammesse: ${WORKFLOW_ACTION_TYPES.join(', ')}. Correggi la definizione nel disegnatore.`,
        )
      }

      // 5. Transazione UNICA e atomica: chiusura execution + avanzamento
      //    CURRENT_STEP + nuova execution + sync status entità.
      //    Concorrenza: la PRIMA cosa che fa la statement è scrivere una
      //    proprietà su wi → lock esclusivo sul nodo. Una seconda transizione
      //    concorrente si blocca lì finché la prima non committa, e solo dopo
      //    esegue la MATCH su CURRENT_STEP con lo step letto al punto 1: che
      //    ormai è cambiato → 0 righe → fallisce senza scrivere. (Senza il
      //    lock, DELETE su una relazione già cancellata da una tx committata
      //    NON fallisce in Neo4j e si otterrebbero due CURRENT_STEP.)
      const execId = uuidv4()
      await session.executeWrite(async (tx) => {
        const res = await tx.run(`
          MATCH (wi:WorkflowInstance {id: $instanceId})
          SET wi.updated_at = $now
          WITH wi
          MATCH (wi)-[r:CURRENT_STEP]->(cur:WorkflowStep {id: $currentStepId})
          OPTIONAL MATCH (wi)-[:STEP_HISTORY]->(exec:WorkflowStepExecution)
            WHERE exec.exited_at IS NULL
          SET exec.exited_at   = $now,
              exec.duration_ms = $durationMs
          WITH DISTINCT wi, r
          DELETE r
          WITH wi
          // Lo step di arrivo è quello della DEFINIZIONE dell'istanza
          // (revisione totale · E-6): gli id dei passi non sono garantiti
          // unici fra definizioni (i seed storici usavano step-<nome>),
          // quindi un id omonimo in un'altra definizione faceva creare DUE
          // relazioni CURRENT_STEP, e la lettura successiva ne scegliva una a
          // caso. createInstance passava già dalla definizione; qui no.
          MATCH (nextStep:WorkflowStep {id: $nextStepId, definition_id: wi.definition_id})
          CREATE (wi)-[:CURRENT_STEP]->(nextStep)
          SET wi.current_step = $nextStepName,
              wi.updated_at   = $now,
              wi.status       = $wiStatus
          WITH wi
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
          RETURN wi.id AS id
        `, {
          instanceId:   input.instanceId,
          currentStepId,
          now,
          durationMs,
          nextStepId,
          nextStepName,
          wiStatus,
          execId,
          tenantId:     wi['tenant_id'] as string,
          triggeredBy:  input.triggeredBy,
          triggerType:  input.triggerType,
          notes:        input.notes ?? null,
        })
        if (res.records.length === 0) {
          throw new ConcurrentTransitionError(`Concurrent transition: the current step of ${input.instanceId} is no longer "${currentStepName}". Reload and try again.`)
        }

        // Sync dello status sull'entità — stessa transazione, label esplicita.
        // `entity.status` è SEMPRE il nome del passo (anche per il passo di
        // risoluzione: prima era il letterale `'resolved'`, che per il passo di
        // fabbrica coincideva col nome e per qualunque altro no). Quello che la
        // categoria `resolved` aggiunge è la data di risoluzione e la causa.
        if (nextStepResolves) {
          await tx.run(`
            MATCH (entity:${label} {id: $entityId, tenant_id: $tenantId})
            SET entity.status      = $status,
                entity.root_cause  = coalesce($rootCause, entity.root_cause),
                entity.resolved_at = $now,
                entity.updated_at  = $now
          `, {
            entityId:  wi['entity_id'] as string,
            tenantId:  wi['tenant_id'] as string,
            status:    nextStepName,
            rootCause: input.notes ?? null,
            now,
          })
        } else if (nextStepTerminal && (label === 'ServiceRequest' || label === 'Change')) {
          // Una richiesta o una change che arriva a un passo terminale è
          // CONCLUSA: `completed_at` è la data che leggono OLA/UC, report e
          // diagnostica. Prima la scriveva solo `completeRequest`, che il
          // workflow non chiama: una richiesta chiusa dal suo workflow restava
          // «aperta» per sempre. `coalesce`: la prima conclusione vince.
          await tx.run(`
            MATCH (entity:${label} {id: $entityId, tenant_id: $tenantId})
            SET entity.status       = $status,
                entity.completed_at = coalesce(entity.completed_at, $now),
                entity.updated_at   = $now
          `, {
            entityId: wi['entity_id'] as string,
            tenantId: wi['tenant_id'] as string,
            status:   nextStepName,
            now,
          })
        } else if (nextStepCategory === 'published' && label === 'KBArticle') {
          // Un articolo che entra nel passo di pubblicazione (per categoria, non
          // per nome) riceve la data di pubblicazione. Giro del 14 set 2026:
          // non la scriveva nessuno, e l'articolo pubblicato diceva
          // «Published: —». Una ripubblicazione dopo una revisione la aggiorna.
          await tx.run(`
            MATCH (entity:${label} {id: $entityId, tenant_id: $tenantId})
            SET entity.status       = $status,
                entity.published_at = $now,
                entity.updated_at   = $now
          `, {
            entityId: wi['entity_id'] as string,
            tenantId: wi['tenant_id'] as string,
            status:   nextStepName,
            now,
          })
        } else if (currentStepResolved && !nextStepTerminal) {
          // La root cause si svuota solo per gli incident: in un problem è
          // l'analisi stessa, e resta anche se il problem si riapre.
          await tx.run(`
            MATCH (entity:${label} {id: $entityId, tenant_id: $tenantId})
            SET entity.status      = $status,
                entity.resolved_at = null,
                entity.root_cause  = CASE WHEN $clearRootCause THEN null ELSE entity.root_cause END,
                entity.updated_at  = $now
          `, {
            entityId:       wi['entity_id'] as string,
            tenantId:       wi['tenant_id'] as string,
            status:         nextStepName,
            clearRootCause: label === 'Incident',
            now,
          })
        } else {
          await tx.run(`
            MATCH (entity:${label} {id: $entityId, tenant_id: $tenantId})
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

      // 6. Exit actions dello step corrente + enter actions del prossimo.
      // La transizione è già persistita: un'azione fallita non è più annullabile,
      // ma NON deve sparire — finisce in actionErrors e i chiamanti la mostrano.
      const actionsRun:    string[] = []
      const actionErrors:  string[] = []

      const instance: WorkflowInstance = {
        id:           wi['id']            as string,
        tenantId:     wi['tenant_id']     as string,
        definitionId: wi['definition_id'] as string,
        entityId:     wi['entity_id']     as string,
        entityType,
        currentStep:  nextStepName,
        status:       wiStatus,
        createdAt:    wi['created_at']    as string,
        updatedAt:    now,
      }

      // `stepId`/`actionIndex`: il retry di un webhook rilegge da lì gli header, che non viaggiano in Redis (E-11).
      const allActions = [...exitActions, ...enterActions]
      for (const [actionIndex, action] of allActions.entries()) {
        try {
          await runAction(action, instance, { ...context, notes: context.notes ?? input.notes, stepId: nextStepId, actionIndex })
          actionsRun.push(action.type)
        } catch (e) {
          const msg = `${action.type}: ${e instanceof Error ? e.message : String(e)}`
          workflowLogger.error({ err: e, actionType: action.type, instanceId: input.instanceId }, 'Workflow action failed')
          actionErrors.push(msg)
        }
      }

      // Timer job entrando in uno step timer_wait. Non riuscire a schedularlo
      // (o uno step timer senza uscita automatica) lascia il workflow fermo
      // per sempre — è un actionError, non una riga di log.
      const delayMinutes = toNumber(timerDelayMinutes)
      if (nextStepType === 'timer_wait' && delayMinutes <= 0) {
        const msg = `timer_wait: step "${nextStepName}" has no valid timer_delay_minutes — the workflow will never leave this step`
        workflowLogger.error({ instanceId: input.instanceId, stepName: nextStepName, timerDelayMinutes }, `[workflow-engine] ${msg}`)
        actionErrors.push(msg)
      } else if (nextStepType === 'timer_wait') {
        try {
          const { Queue } = await import('bullmq')
          const { getRedisConnection } = await import('@opengraphity/events')
          const queue = new Queue('notification-jobs', { connection: getRedisConnection() })
          // Il passo di arrivo si legge ADESSO solo per dire subito se l'arco
          // manca (un passo di attesa senza uscita automatica è una definizione
          // rotta, e l'amministratore lo deve sapere al primo ingresso). Chi
          // esegue il job lo risolve di nuovo al momento della scadenza —
          // in mezzo il workflow può essere cambiato (B-18): il nome nel
          // payload è un'indicazione, non il bersaglio.
          const nextTransRes = await session.executeRead(tx =>
            tx.run(`
              MATCH (step:WorkflowStep {id: $stepId})-[tr:TRANSITIONS_TO {trigger: 'automatic'}]->(nextStep:WorkflowStep)
              RETURN nextStep.name AS toStep
              ORDER BY coalesce(nextStep.step_order, 999), nextStep.name
              LIMIT 1
            `, { stepId: nextStepId }),
          )
          const toStep = nextTransRes.records[0]?.get('toStep') as string | null
          if (toStep) {
            await queue.add('timer_wait', {
              instanceId: input.instanceId,
              toStep,
              tenantId:   wi['tenant_id'] as string,
            }, { delay: delayMinutes * 60 * 1000 })
            workflowLogger.info({ instanceId: input.instanceId, toStep, delayMinutes }, '[workflow-engine] timer_wait job scheduled')
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

      for (const listener of this.stepEnteredListeners) {
        try {
          await listener({
            tenantId:    wi['tenant_id'] as string,
            instanceId:  input.instanceId,
            entityType,
            entityId:    wi['entity_id'] as string,
            fromStep:    currentStepName,
            fromInitial: currentStepInitial,
            toStep:      nextStepName,
            category:    nextStepCategory,
            terminal:    nextStepTerminal,
            enteredAt:   now,
            actorId:     context.userId,
            triggerType: input.triggerType,
          })
        } catch (e) {
          const msg = `step_entered listener: ${e instanceof Error ? e.message : String(e)}`
          workflowLogger.error({ err: e, instanceId: input.instanceId, stepName: nextStepName }, `[workflow-engine] ${msg}`)
          actionErrors.push(msg)
        }
      }

      if (nextStepType === 'sub_workflow') {
        const msg = `sub_workflow step "${nextStepName}" is not implemented — no sub-workflow was created${subWorkflowId ? ` (definitionId ${subWorkflowId})` : ' and no subWorkflowId is configured'}`
        workflowLogger.error({ instanceId: input.instanceId, subWorkflowId }, `[workflow-engine] ${msg}`)
        actionErrors.push(msg)
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
      if (error instanceof ConcurrentTransitionError) return fail(error.message, { key: 'errors.workflow.concurrentTransition' })
      return fail(error instanceof Error ? error.message : String(error))
    }
  }

  /** Transizioni manuali disponibili dallo step corrente */
  async getAvailableTransitions(session: Session, instanceId: string, tenantId?: string) {
    const result = await session.executeRead((tx) =>
      tx.run(`
        MATCH (wi:WorkflowInstance {id: $instanceId})
        WHERE $tenantId IS NULL OR wi.tenant_id = $tenantId
        MATCH (wi)-[:CURRENT_STEP]->(current:WorkflowStep)
        MATCH (current)-[tr:TRANSITIONS_TO {trigger: 'manual'}]->(next:WorkflowStep)
        RETURN
          next.name        AS toStep,
          tr.label         AS label,
          tr.labels        AS labels,
          tr.requires_input AS requiresInput,
          tr.input_field   AS inputField,
          tr.condition     AS condition
        ORDER BY next.name
      `, { instanceId, tenantId: tenantId ?? null }),
    )

    return result.records.map((r) => ({
      toStep:        r.get('toStep')        as string,
      label:         r.get('label')         as string,
      labels:        parseLocalizedLabels(r.get('labels'), `transition to ${String(r.get('toStep'))}`),
      requiresInput: r.get('requiresInput') as boolean,
      inputField:    r.get('inputField')    as string | null,
      condition:     r.get('condition')     as string | null,
    }))
  }

  /** Storia completa di un'istanza (step eseguiti) */
  async getHistory(session: Session, instanceId: string, tenantId?: string) {
    const result = await session.executeRead((tx) =>
      tx.run(`
        MATCH (wi:WorkflowInstance {id: $instanceId})-[:STEP_HISTORY]->(exec:WorkflowStepExecution)
        WHERE $tenantId IS NULL OR wi.tenant_id = $tenantId
        RETURN exec
        ORDER BY exec.entered_at ASC
      `, { instanceId, tenantId: tenantId ?? null }),
    )

    return result.records.map((r) => r.get('exec').properties as Record<string, unknown>)
  }
}

export const workflowEngine = new WorkflowEngine()
