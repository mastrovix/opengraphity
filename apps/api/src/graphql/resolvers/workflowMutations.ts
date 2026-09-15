import { GraphQLError } from 'graphql'
import { NotFoundError } from '../../lib/errors.js'
import { v4 as uuidv4 } from 'uuid'
import { workflowEngine, isWorkflowActionType, WORKFLOW_ACTION_TYPES } from '@opengraphity/workflow'
import { parseLocalizedLabels } from '@opengraphity/types'
import type { ActionContext } from '@opengraphity/workflow'
import {
  NOTIFICATION_BASE_TARGETS, isNotificationTarget, isTargetApplicable, applicableNotificationTargets,
  WORKFLOW_STEP_PURPOSES, isWorkflowStepPurpose,
  WORKFLOW_STEP_CATEGORIES, isWorkflowStepCategory,
  WORKFLOW_TRANSITION_TRIGGERS, isWorkflowTransitionTrigger,
  WORKFLOW_TRANSITION_CONDITIONS, isWorkflowTransitionCondition,
  stepFieldRejection,
  CHANGE_WINDOW_PURPOSES,
} from '@opengraphity/types'
import { publish } from '@opengraphity/events'
import { sseManager } from '@opengraphity/notifications'
import type { GraphQLContext } from '../../context.js'
import { withSession } from './ci-utils.js'
import { loadTransitionRows, mapWorkflowDefinition } from './workflowMapping.js'
import * as incidentService from '../../services/incidentService.js'
import { workflowLogger } from '../../lib/logger.js'
import { audit } from '../../lib/audit.js'
import { validateRequiredFields } from '../../lib/validateRequiredFields.js'
import { invalidateWorkflowCache } from '../../lib/workflowHelpers.js'
import { auditStepEntered, loadStepFacts } from '../../lib/stepEvent.js'
import { systemText } from '../../lib/systemText.js'
import { requestApprovalWouldBeSkipped } from '../../lib/requestApproval.js'
import { transitionErrorFields } from '../../lib/transitionError.js'
import { assertStepFieldValue, stepFieldMetas } from '../../lib/stepFieldWrites.js'
import { assertDeadlineFields, assertDefinitionDeadlines, normalizeStepDeadlineInput } from '../../lib/stepDeadlineWrite.js'
import { assertRolesExist, roleKeysInActions } from '../../lib/roles.js'
import { labelTranslationsCypher } from '../../lib/workflowLabelTranslations.js'
import { assignTeamCypher, TEAM_NOW_PARAM } from '../../lib/ticketTeamHistory.js'
import { workflowChangeDetails, workflowSnapshot } from '../../lib/workflowAuditDetails.js'

// Safe label map — prevents Cypher injection when creating entities dynamically
const ENTITY_LABELS: Record<string, string> = {
  incident:   'Incident',
  problem:    'Problem',
  change:     'Change',
  kb_article: 'KBArticle',
}

/**
 * Apply the `on_enter_fields` metadata of the newly-entered step to the
 * underlying entity. Value tokens:
 *   '$now'    → current ISO timestamp
 *   '$userId' → current user id
 *   '$notes'  → transition notes (can be null)
 * Any other string is taken verbatim.
 *
 * The entity label is resolved from the WorkflowInstance.entity_type.
 */
async function applyOnEnterFields(
  session: import('neo4j-driver').Session,
  instanceId: string,
  stepName: string,
  userId: string,
  notes?: string,
  expectedTenantId?: string,
): Promise<void> {
  const fieldsRow = await session.executeRead((tx) => tx.run(`
    MATCH (wi:WorkflowInstance {id: $instanceId})-[:CURRENT_STEP]->(step:WorkflowStep)
    WHERE step.name = $stepName AND ($tenantId IS NULL OR wi.tenant_id = $tenantId)
    RETURN step.on_enter_fields AS fields,
           wi.entity_id   AS entityId,
           wi.tenant_id   AS tenantId,
           wi.entity_type AS entityType
  `, { instanceId, stepName, tenantId: expectedTenantId ?? null }))
  if (!fieldsRow.records.length) return
  const rec       = fieldsRow.records[0]
  const raw       = rec.get('fields')     as string | null
  if (!raw) return
  const entityId   = rec.get('entityId')   as string
  const tenantId   = rec.get('tenantId')   as string
  const entityType = rec.get('entityType') as string
  const label      = ENTITY_LABELS[entityType]
  if (!label) return

  let parsed: Record<string, string>
  try { parsed = JSON.parse(raw) as Record<string, string> }
  catch (e) {
    // Corrupt on_enter_fields must fail the transition, not silently skip the
    // step's side effects while reporting success.
    throw new GraphQLError(`Corrupt on_enter_fields JSON on step "${stepName}": ${e instanceof Error ? e.message : String(e)}`)
  }
  const keys = Object.keys(parsed)
  if (keys.length === 0) return

  const nowIso = new Date().toISOString()
  const resolveValue = (v: string) => {
    if (v === '$now')    return nowIso
    if (v === '$userId') return userId
    if (v === '$notes')  return notes ?? null
    return v
  }
  const setClauses = keys.map((k) => `e.\`${k}\` = $__val_${k}`)
  const params: Record<string, unknown> = { entityId, tenantId, now: nowIso }
  for (const [k, v] of Object.entries(parsed)) params[`__val_${k}`] = resolveValue(v)
  await session.executeWrite((tx) => tx.run(
    `MATCH (e:${label} {id: $entityId, tenant_id: $tenantId})
     SET ${setClauses.join(', ')}, e.updated_at = $now`,
    params,
  ))
}

// ── Publish workflow.step.entered for notify_rule enter_actions ───────────────

async function publishNotifyRuleActions(
  session: import('neo4j-driver').Session,
  instanceId: string,
  stepName: string,
  tenantId: string,
  userId: string,
  entityType: string,
  entityId: string,
): Promise<void> {
  const result = await session.executeRead((tx) =>
    tx.run(
      `MATCH (wi:WorkflowInstance {id: $instanceId, tenant_id: $tenantId})
       // tenant-ok: definizione e step seguono l'istanza appena scopata
       MATCH (wd:WorkflowDefinition {id: wi.definition_id})
       // tenant-ok: idem
       MATCH (s:WorkflowStep {definition_id: wd.id, name: $stepName})
       RETURN s.enter_actions AS enterActions, s.label AS stepLabel`,
      { instanceId, stepName, tenantId },
    ),
  )
  if (!result.records.length) return
  const raw = result.records[0].get('enterActions') as string | null
  // L'etichetta del passo viaggia nell'evento: è il titolo di ripiego della
  // notifica quando la chiave i18n della regola non è tradotta (B-16), al
  // posto della chiave grezza «notification.custom.step.title».
  const stepLabel = (result.records[0].get('stepLabel') as string | null) ?? stepName
  if (!raw) return

  let actions: Array<{ type: string; params?: Record<string, unknown> }>
  try { actions = JSON.parse(raw) }
  catch (e) {
    // Corrupt enter_actions must fail the transition, not silently drop the
    // step's notify rules.
    throw new GraphQLError(`Corrupt enter_actions JSON on step "${stepName}": ${e instanceof Error ? e.message : String(e)}`)
  }

  const notifyRules = actions.filter((a) => a.type === 'notify_rule')
  for (const action of notifyRules) {
    await publish({
      id:             uuidv4(),
      type:           'workflow.step.entered',
      tenant_id:      tenantId,
      timestamp:      new Date().toISOString(),
      correlation_id: uuidv4(),
      actor_id:       userId,
      payload: {
        stepName,
        stepLabel,
        entityType,
        entityId,
        notifyRule: action.params ?? {},
      },
    })
  }
}

// ── Validazione delle azioni in scrittura (B0-5) ──────────────────────────────

/**
 * Valida il JSON delle azioni di un passo PRIMA di scriverlo: lista di oggetti
 * con un `type` del vocabolario del motore. È la porta da cui è entrata la
 * deriva vista dal vivo (un `create_notification` — vocabolario delle
 * automazioni — su un passo di «Incident — Security»): il motore ora ferma la
 * transizione nominando l'azione, ma un dato del genere non deve poter più
 * entrare da qui. `null` = campo non mandato, non si valida nulla.
 *
 * Il `target` di un'azione `notify_rule` viene validato con lo stesso
 * vocabolario delle regole di notifica (`NOTIFICATION_TARGETS`): dal momento in
 * cui il dispatcher RISOLVE i bersagli (A0-1), un bersaglio inesistente qui non
 * è più ignorato — fa fallire il job di notifica a ogni ingresso nel passo. Il
 * pannello del designer offriva `role:admin, role:manager`: il secondo non è un
 * ruolo che l'autenticazione conosce.
 */
export function assertStepActions(raw: string | null | undefined, label: string): void {
  if (raw == null) return
  let parsed: unknown
  try { parsed = JSON.parse(raw) }
  catch (e) {
    throw new GraphQLError(`${label} is not valid JSON (${e instanceof Error ? e.message : String(e)})`, { extensions: { code: 'BAD_USER_INPUT', i18n: { key: 'errors.workflow.actionsNotJson', params: { field: label, reason: e instanceof Error ? e.message : String(e) } } } })
  }
  if (!Array.isArray(parsed)) {
    throw new GraphQLError(`${label} must be a list of actions`, { extensions: { code: 'BAD_USER_INPUT', i18n: { key: 'errors.workflow.actionsNotList', params: { field: label } } } })
  }
  parsed.forEach((action, i) => {
    const type = (action as { type?: unknown } | null)?.type
    if (!isWorkflowActionType(type)) {
      throw new GraphQLError(
        `${label}[${i}]: action type ${JSON.stringify(type ?? null)} is unknown to the workflow engine. ` +
        `Allowed: ${WORKFLOW_ACTION_TYPES.join(', ')}.`,
        { extensions: { code: 'BAD_USER_INPUT', i18n: { key: 'errors.workflow.unknownActionType', params: { type: String(type ?? null), allowed: WORKFLOW_ACTION_TYPES.join(', ') } } } },
      )
    }
    // `update_field` non può scrivere lo stato (B-9) né identità e traccia: le
    // stesse riserve che il motore applica a runtime, applicate qui — così il
    // rifiuto arriva all'amministratore nel disegnatore e non dentro un log a
    // ticket rotto. Il resto (campo del metamodello, valore del vocabolario,
    // campi derivati del tipo) lo verifica `assertStepActionFields`.
    if (type === 'update_field') {
      const field = (action as { params?: Record<string, unknown> }).params?.['field']
      if (field == null || String(field).trim() === '') {
        throw new GraphQLError(`${label}[${i}]: update_field needs the field to write (params.field).`, { extensions: { code: 'BAD_USER_INPUT', i18n: { key: 'errors.workflow.updateFieldNeedsField' } } })
      }
      const rejection = stepFieldRejection(String(field), '')
      if (rejection) {
        throw new GraphQLError(`${label}[${i}]: ${rejection.message}`, {
          extensions: { code: 'BAD_USER_INPUT', field: String(field), i18n: { key: `errors.stepField.${rejection.reason}`, params: { where: `${label}[${i}]`, field: String(field), entityType: '' } } },
        })
      }
    }
    // Una change nasce solo con un tipo del vocabolario del cliente: nessun
    // default (verifica «Cosa resta cablato», ondata 1). Il valore lo valida il
    // servizio quando l'azione gira; qui si rifiuta l'azione che non lo dice.
    if (type === 'create_entity') {
      const params = (action as { params?: Record<string, unknown> }).params ?? {}
      if (params['entity_type'] === 'change' && (params['change_type'] == null || String(params['change_type']).trim() === '')) {
        throw new GraphQLError(`${label}[${i}]: create_entity of a change needs the change type (params.change_type).`, { extensions: { code: 'BAD_USER_INPUT', i18n: { key: 'errors.workflow.createChangeNeedsType', params: { field: `${label}[${i}]` } } } })
      }
    }
    if (type === 'notify_rule') {
      const target = (action as { params?: Record<string, unknown> }).params?.['target']
      if (target != null && target !== '') {
        const t = String(target)
        if (!isNotificationTarget(t)) {
          throw new GraphQLError(
            `${label}[${i}]: target "${t}" is not a valid recipient. Allowed: ${NOTIFICATION_BASE_TARGETS.join(', ')}, role:<role>.`,
            { extensions: { code: 'BAD_USER_INPUT', i18n: { key: 'errors.workflow.badTarget', params: { field: `${label}[${i}]`, target: t, allowed: [...NOTIFICATION_BASE_TARGETS, 'role:<role>'].join(', ') } } } },
          )
        }
        if (!isTargetApplicable('workflow.step.entered', t)) {
          throw new GraphQLError(
            `${label}[${i}]: target "${t}" cannot be resolved when a step is entered. `
            + `Applicable: ${applicableNotificationTargets('workflow.step.entered').join(', ')}.`,
            { extensions: { code: 'BAD_USER_INPUT', i18n: { key: 'errors.workflow.targetNotApplicable', params: { field: `${label}[${i}]`, target: t, applicable: applicableNotificationTargets('workflow.step.entered').join(', ') } } } },
          )
        }
      }
    }
  })
}

/**
 * I campi di `update_field` contro il metamodello del cliente (verifica «Cosa
 * resta cablato», ondata 3: «ogni campo non riservato»). Il campo deve essere
 * del tipo di ticket del workflow e il valore del suo vocabolario; un valore con
 * un segnaposto (`{title}`) si risolve a runtime e lì si valida di nuovo.
 */
export async function assertStepActionFields(
  session: import('neo4j-driver').Session, tenantId: string, entityType: string, raw: string | null | undefined, label: string,
): Promise<void> {
  if (raw == null) return
  const actions = JSON.parse(raw) as Array<{ type?: string; params?: Record<string, unknown> }>
  const updates = actions.map((a, i) => ({ a, i })).filter(({ a }) => a.type === 'update_field')
  if (updates.length === 0) return
  const metas = await stepFieldMetas(session, tenantId, entityType)
  for (const { a, i } of updates) {
    assertStepFieldValue(metas, entityType, String(a.params?.['field'] ?? ''), a.params?.['value'], `${label}[${i}]`, { allowTemplate: true })
  }
}

/** Vero se le azioni (già validate nella forma) contengono un `update_field`. */
function hasUpdateField(raw: string | null | undefined): boolean {
  return raw != null && raw.includes('update_field')
}

/** Il tipo di ticket di una definizione, o NotFound. */
async function definitionEntityType(session: import('neo4j-driver').Session, tenantId: string, definitionId: string): Promise<string> {
  const res = await session.executeRead((tx) => tx.run(
    'MATCH (wd:WorkflowDefinition {id: $definitionId, tenant_id: $tenantId}) RETURN wd.entity_type AS entityType',
    { definitionId, tenantId },
  ))
  const entityType = res.records[0]?.get('entityType') as string | undefined
  if (!entityType) throw new NotFoundError('WorkflowDefinition', definitionId)
  return entityType
}

// ── Scopo del passo in scrittura (ondata 4, B4-3) ─────────────────────────────

/**
 * Convenzione del campo `purpose` in scrittura, uguale in `updateWorkflowStep`
 * e in `saveWorkflowChanges`:
 *  - `undefined`/`null` → campo non mandato: lo scopo salvato resta com'è;
 *  - `''` (stringa vuota) → **toglie** lo scopo. Un passo senza scopo è
 *    legittimo, quindi il disegnatore deve poter tornare a «nessuno»: senza un
 *    valore per «togli», un `coalesce` renderebbe lo scopo irreversibile.
 *  - qualunque altra stringa → deve stare nel vocabolario chiuso.
 *
 * Uno scopo fuori vocabolario è rifiutato nominando i valori ammessi: è la
 * stessa forma di `assertStepActions`. Il codice di produzione non deve
 * indovinare lo scopo dal nome del passo (`FACTORY_STEP_PURPOSES` serve solo a
 * seed e migrazione), quindi l'unica via per assegnarlo è questa.
 */
export function normalizeStepPurpose(raw: string | null | undefined, label: string): string | null | undefined {
  if (raw == null) return undefined       // non mandato
  if (raw.trim() === '') return null      // togli
  const value = raw.trim()
  if (!isWorkflowStepPurpose(value)) {
    throw new GraphQLError(
      `${label}: purpose "${value}" out of vocabulary. Allowed: ${WORKFLOW_STEP_PURPOSES.join(', ')} `
      + `(or empty for no purpose).`,
      {
        extensions: {
          code: 'BAD_USER_INPUT', purpose: value, allowedPurposes: [...WORKFLOW_STEP_PURPOSES],
          i18n: { key: 'errors.workflow.badPurpose', params: { field: label, purpose: value, allowed: WORKFLOW_STEP_PURPOSES.join(', ') } },
        },
      },
    )
  }
  return value
}

/**
 * La CATEGORIA del passo in scrittura (revisione delle otto ondate · B·N-3).
 *
 * Convenzione, identica a quella dello scopo tranne per una cosa:
 *  - `undefined`/`null`/`''` → non mandata: la categoria salvata resta com'è.
 *    Questo era già il comportamento (`coalesce(st.category, s.category)`) e il
 *    web mandava `null` per il campo vuoto: non lo cambio, perché toglierla
 *    lascerebbe un passo senza classe di stato — invisibile nelle liste;
 *  - qualunque altra stringa → deve stare nel vocabolario chiuso.
 *
 * Il difetto che chiude: la categoria era un campo di testo con una `datalist`
 * di suggerimenti, e da lei dipendono «risolto» (che valorizza `resolved_at` e
 * `root_cause`), la chiusura automatica, l'escalation e le classi di stato. Dal
 * vivo, `category = 'risolto'` veniva accettata: la transizione riusciva e il
 * ticket restava senza `resolved_at`, cioè risolto per l'utente e mai risolto
 * per i dati. Nessuna migrazione serve: tutte le categorie esistenti — sui 40
 * passi di c-one e nei seed — sono già nel vocabolario.
 */
export function normalizeStepCategory(raw: string | null | undefined, label: string): string | null {
  if (raw == null || raw.trim() === '') return null   // non mandata: resta com'è
  const value = raw.trim()
  if (!isWorkflowStepCategory(value)) {
    throw new GraphQLError(
      `${label}: category "${value}" out of vocabulary. Allowed: ${WORKFLOW_STEP_CATEGORIES.join(', ')}. `
      + `The category says how the ticket looks from outside, and the product reads it to decide: `
      + `«resolved» fills in the resolution date, «closed» is where the automatic closure lands. `
      + `The name people see is the step label, not this one.`,
      {
        extensions: {
          code: 'BAD_USER_INPUT', category: value, allowedCategories: [...WORKFLOW_STEP_CATEGORIES],
          i18n: { key: 'errors.workflow.badCategory', params: { field: label, category: value, allowed: WORKFLOW_STEP_CATEGORIES.join(', ') } },
        },
      },
    )
  }
  return value
}

/**
 * L'INNESCO di una transizione in scrittura (revisione · B·M-4).
 *
 * Era libero lato API (`trigger: String`) con una tendina lato web: una stringa
 * inventata entrava nel grafo e quell'arco non veniva percorso da nessuno, in
 * silenzio. `undefined`/`null` = non mandato (resta com'è).
 */
export function assertTransitionTrigger(raw: string | null | undefined, label: string): string | null {
  if (raw == null || raw.trim() === '') return null
  const value = raw.trim()
  if (!isWorkflowTransitionTrigger(value)) {
    throw new GraphQLError(
      `${label}: trigger "${value}" out of vocabulary. Allowed: ${WORKFLOW_TRANSITION_TRIGGERS.join(', ')}.`,
      {
        extensions: {
          code: 'BAD_USER_INPUT', trigger: value, allowedTriggers: [...WORKFLOW_TRANSITION_TRIGGERS],
          i18n: { key: 'errors.workflow.badTrigger', params: { field: label, trigger: value, allowed: WORKFLOW_TRANSITION_TRIGGERS.join(', ') } },
        },
      },
    )
  }
  return value
}

/**
 * La CONDIZIONE di una transizione in scrittura (revisione · B·M-4).
 *
 * Il registro è chiuso perché ogni condizione è una funzione scritta nel codice
 * (`workflow/conditions.ts`). Era un campo di testo con un segnaposto: un
 * refuso — `all_assessment_complete` invece di `all_assessments_complete` — si
 * salvava senza un fiato e trasformava quell'arco in un **muro**, perché il
 * motore risponde «Condizione di transizione sconosciuta» a ogni tentativo e il
 * ticket non si muove più. È lo schema che l'ondata 2 ha chiuso per le azioni
 * di passo (`assertStepActions`) e l'ondata 4 per lo scopo.
 *
 * `''` → `null`: togliere la condizione da un arco deve restare possibile, ed è
 * il modo di sbloccare un arco su cui era stato scritto un refuso.
 */
export function assertTransitionCondition(raw: string | null | undefined, label: string): string | null {
  if (raw == null || raw.trim() === '') return null
  const value = raw.trim()
  if (!isWorkflowTransitionCondition(value)) {
    throw new GraphQLError(
      `${label}: condition "${value}" unknown. The engine can only evaluate these: `
      + `${WORKFLOW_TRANSITION_CONDITIONS.join(', ')} (or empty for no condition). `
      + `An unregistered condition blocks the edge: the engine rejects it on every attempt and the ticket stops moving.`,
      {
        extensions: {
          code: 'BAD_USER_INPUT', condition: value, allowedConditions: [...WORKFLOW_TRANSITION_CONDITIONS],
          i18n: { key: 'errors.workflow.badCondition', params: { field: label, condition: value, allowed: WORKFLOW_TRANSITION_CONDITIONS.join(', ') } },
        },
      },
    )
  }
  return value
}

/**
 * Il workflow delle change deve conservare **un posto dove approvare**
 * (revisione delle otto ondate · B·N-1).
 *
 * Il varco delle approvazioni è `if (currentPurpose === 'approval' && …)`:
 * `requireRole('admin')` e il controllo dei requisiti stanno **dentro** quel
 * ramo, quindi cadono insieme al ramo quando il cliente mette lo scopo del
 * passo a «nessuno» dalla tendina — due clic. Dal vivo, nella revisione: un
 * utente di ruolo `operator` ha portato una change dal passo di approvazione a
 * quello programmato **senza approvazioni e senza errore**.
 *
 * Il varco è stato spostato anche sul passo di ARRIVO (vedi
 * `executeChangeTransition`), che è la difesa che conta. Questa è la seconda:
 * impedire di **entrare** nello stato in cui il varco non ha dove applicarsi,
 * che è sempre meglio che accorgersene dopo. Stessa forma della guardia che
 * rifiuta di eliminare un passo con istanze sopra.
 *
 * L'eccezione, e non è teorica: un cliente che ha messo **tutti** i suoi tipi
 * di change fra i pre-approvati non ha niente da approvare, e per lui un passo
 * di approvazione obbligatorio sarebbe una regola senza contenuto. Quindi la
 * guardia guarda il dato del cliente (ondata 8 + rimedio 1: i tipi
 * pre-approvati sono una lista sul tenant, validata contro il suo vocabolario).
 */
async function assertApprovalPurposeSurvives(
  tx: { run: (q: string, p: Record<string, unknown>) => Promise<{ records: Array<{ get: (k: string) => unknown }> }> },
  tenantId: string, definitionId: string,
): Promise<void> {
  const res = await tx.run(`
    MATCH (wd:WorkflowDefinition {id: $definitionId, tenant_id: $tenantId})
    WHERE wd.entity_type = 'change'
    // tenant-ok: i passi sono quelli della definizione già scopata sopra
    OPTIONAL MATCH (wd)-[:HAS_STEP]->(s:WorkflowStep {purpose: 'approval'})
    RETURN wd.id AS definitionId, count(s) AS approvalSteps
  `, { definitionId, tenantId })
  // Nessuna riga = non è un workflow delle change: niente da verificare.
  // La chiave di raggruppamento (`wd.id`) è ciò che rende vera questa frase:
  // un `RETURN count(s)` da solo restituisce SEMPRE una riga (0), anche quando
  // il MATCH non trova nulla, e la guardia rifiutava ogni salvataggio di passo
  // nei workflow di incident, problem, richieste e KB (giro UI del 15 set · U-18).
  if (!res.records.length) return
  if (Number(res.records[0]!.get('approvalSteps')) > 0) return

  // Import differito: questa guardia gira solo quando si sta togliendo uno
  // scopo, e `lib/changePolicy.ts` si tira dietro le matrici di dominio — che
  // non servono a nessun'altra mutation del disegnatore.
  const { preApprovedChangeTypes, changeTypeVocabulary } = await import('../../lib/changePolicy.js')
  const [preApproved, vocabulary] = await Promise.all([
    preApprovedChangeTypes(tenantId),
    changeTypeVocabulary(tenantId),
  ])
  const daApprovare = vocabulary.filter((t) => !preApproved.includes(t))
  if (daApprovare.length === 0) return

  throw new GraphQLError(
    `In the change workflow no step would have the «Approval» purpose any more, but the change `
    + `type(s) ${daApprovare.map((t) => `"${t}"`).join(', ')} are not pre-approved: `
    + `without that step there would be no place to approve them, and the approval gate would have `
    + `nowhere to apply. Give the «Approval» purpose to the step where approval happens, or — if in this `
    + `tenant changes are not approved — add those types to the pre-approved ones (Settings → Domain matrices).`,
    {
      extensions: {
        code: 'CONFLICT', changeTypesRequiringApproval: daApprovare,
        i18n: { key: 'errors.workflow.noApprovalPurpose', params: { count: daApprovare.length, types: daApprovare.join(', ') } },
      },
    },
  )
}

/**
 * GLI SCOPI DELLA FINESTRA DI RILASCIO NON SI PERDONO (terza revisione · G2).
 *
 * `assertApprovalPurposeSurvives` protegge lo scopo `approval`. Gli scopi
 * della finestra — `scheduled`, `implementation` — non avevano NESSUNA
 * guardia, e su di loro e indicizzata metà del varco: con `targetPurpose =
 * null` il calcolo di `entersWindow` da `false`, quindi il varco dal lato del
 * passo di arrivo si spegne per sempre. Il passo resta quello del rilascio —
 * il cliente ci manda ancora le change — ma non lo dice piu a nessuno, e con
 * lui si spegne anche la soppressione degli allarmi in finestra.
 *
 * Non si rifiuta «zero passi di finestra» in assoluto: un cliente che non ne
 * ha mai avuto uno verrebbe bloccato per una regola che non lo riguarda. Si
 * rifiuta di **togliere l'ultimo**, confrontando prima e dopo.
 */
async function countWindowPurposeSteps(
  tx: { run: (q: string, p: Record<string, unknown>) => Promise<{ records: Array<{ get: (k: string) => unknown }> }> },
  tenantId: string, definitionId: string,
): Promise<number | null> {
  const res = await tx.run(`
    MATCH (wd:WorkflowDefinition {id: $definitionId, tenant_id: $tenantId})
    WHERE wd.entity_type = 'change'
    // tenant-ok: i passi sono quelli della definizione già scopata sopra
    OPTIONAL MATCH (wd)-[:HAS_STEP]->(s:WorkflowStep)
      WHERE s.purpose IN $windowPurposes
    RETURN wd.id AS definitionId, count(s) AS n
  `, { definitionId, tenantId, windowPurposes: [...CHANGE_WINDOW_PURPOSES] })
  // Nessuna riga = non e un workflow delle change: niente da verificare.
  if (!res.records.length) return null
  return Number(res.records[0]!.get('n'))
}

function assertWindowPurposeSurvives(before: number | null, after: number | null): void {
  if (before == null || after == null) return
  if (before === 0 || after > 0) return
  throw new GraphQLError(
    `In the change workflow no step would have a release-window purpose any more `
    + `(${CHANGE_WINDOW_PURPOSES.join(', ')}), and the approval gate is indexed on those purposes `
    + `from the destination-step side: without them an unapproved change could reach production `
    + `with nobody stopping it, and alarms would no longer be silenced during the release. `
    + `Give the «Scheduled» or «Implementation» purpose to the step where the change goes to production.`,
    {
      extensions: {
        code: 'CONFLICT',
        i18n: { key: 'errors.workflow.noWindowPurpose', params: { purposes: CHANGE_WINDOW_PURPOSES.join(', ') } },
      },
    },
  )
}

// ── Marchio di personalizzazione (contratto con i seed, ondata 2) ─────────────

/**
 * Ogni mutation che cambia una definizione di workflow o i suoi passi e
 * transizioni marchia la definizione come «toccata dall'amministratore».
 * È il contratto che i seed leggono (B-2): un seed che rieseguirebbe sopra una
 * definizione marchiata si rifiuta, e il rifiuto nomina data e autore.
 *
 * `saveWorkflowLayout` NON marchia: la posizione dei nodi sul canvas non è
 * configurazione di processo, e un seed che la sovrascrive non toglie niente
 * al cliente.
 */
export const MARK_CUSTOMIZED = 'SET wd.customized_at = $customizedAt, wd.customized_by = $customizedBy'

/**
 * Come `MARK_CUSTOMIZED`, ma incrementa anche la **versione** della
 * definizione (ondata 8).
 *
 * Cinque mutation del disegnatore cambiavano la definizione senza toccare
 * `wd.version`: aggiungere un passo, modificarlo, e le tre sulle transizioni.
 * Il lock ottimistico del disegnatore confronta le versioni, quindi due
 * sessioni aperte sullo stesso workflow non si accorgevano di quelle
 * modifiche — l'ultima salvava sopra l'altra in silenzio. `saveWorkflowChanges`
 * e la rimozione di un passo incrementavano già per conto loro e continuano a
 * usare `MARK_CUSTOMIZED`, altrimenti conterebbero due volte.
 *
 * Usa `$customizedAt` anche per `updated_at`: è lo stesso istante, e non
 * chiede un parametro in più alle query che non ce l'hanno.
 */
export const MARK_CUSTOMIZED_BUMP =
  'SET wd.version = wd.version + 1, wd.updated_at = $customizedAt, wd.customized_at = $customizedAt, wd.customized_by = $customizedBy'

/** Parametri di `MARK_CUSTOMIZED`; da unire a quelli della query. */
export function customizedParams(ctx: GraphQLContext): { customizedAt: string; customizedBy: string } {
  return { customizedAt: new Date().toISOString(), customizedBy: ctx.userId }
}

// ── Mutation resolvers ────────────────────────────────────────────────────────

export async function updateWorkflowStep(
  _: unknown,
  { definitionId, stepName, label, enterActions, exitActions, purpose }: { definitionId: string; stepName: string; label: string; enterActions?: string | null; exitActions?: string | null; purpose?: string | null },
  ctx: GraphQLContext,
) {
  assertStepActions(enterActions, `enter_actions of step "${stepName}"`)
  assertStepActions(exitActions,  `exit_actions of step "${stepName}"`)
  await assertRolesExist(ctx.tenantId, [...roleKeysInActions(enterActions), ...roleKeysInActions(exitActions)])
  const purposeValue = normalizeStepPurpose(purpose, `step "${stepName}"`)
  return withSession(async (session) => {
    if (hasUpdateField(enterActions) || hasUpdateField(exitActions)) {
      const entityType = await definitionEntityType(session, ctx.tenantId, definitionId)
      await assertStepActionFields(session, ctx.tenantId, entityType, enterActions, `enter_actions of step "${stepName}"`)
      await assertStepActionFields(session, ctx.tenantId, entityType, exitActions,  `exit_actions of step "${stepName}"`)
    }
    const now = new Date().toISOString()
    const result = await session.executeWrite(async (tx) => {
      // Quanti passi di finestra c'erano PRIMA: si rifiuta di togliere
      // l'ultimo, non di non averne (vedi assertWindowPurposeSurvives).
      const windowBefore = purposeValue !== undefined
        ? await countWindowPurposeSteps(tx, ctx.tenantId, definitionId)
        : null
      const written = await tx.run(`
        MATCH (wd:WorkflowDefinition {id: $definitionId, tenant_id: $tenantId})-[:HAS_STEP]->(s:WorkflowStep {name: $stepName})
        // Un'etichetta CAMBIATA nel disegnatore è del cliente: le traduzioni spedite non valgono più (#22).
        // V-5: tornando all'etichetta d'origine le traduzioni tornano (lib/workflowLabelTranslations.ts).
        ${labelTranslationsCypher('s', '$label')}
        SET s.label        = $label,
            s.updated_at   = $now,
            s.enter_actions = CASE WHEN $enterActions IS NOT NULL THEN $enterActions ELSE s.enter_actions END,
            s.exit_actions  = CASE WHEN $exitActions  IS NOT NULL THEN $exitActions  ELSE s.exit_actions  END,
            s.purpose       = CASE WHEN $purposeGiven THEN $purpose ELSE s.purpose END
        ${MARK_CUSTOMIZED_BUMP}
        RETURN s, wd.entity_type AS entityType
      `, {
        definitionId, stepName, tenantId: ctx.tenantId, label,
        enterActions: enterActions ?? null, exitActions: exitActions ?? null,
        purposeGiven: purposeValue !== undefined, purpose: purposeValue ?? null,
        now, ...customizedParams(ctx),
      })
      // Togliere lo scopo è legittimo; togliere l'ULTIMO passo di approvazione
      // (o l'ultimo della finestra di rilascio) di un workflow delle change non
      // lo è. Dentro la stessa transazione: se si ferma, la scrittura non resta
      // a metà.
      //
      // Terza revisione · G2: la condizione era `purposeValue === null`, cioè
      // scattava solo TOGLIENDO lo scopo. Scegliere «Revisione» invece di
      // «nessuno» sull'unico passo di approvazione lo SOSTITUISCE — due clic
      // nel disegnatore — e la guardia non partiva. Ora scatta su qualunque
      // cambio di scopo.
      if (purposeValue !== undefined) {
        await assertApprovalPurposeSurvives(tx, ctx.tenantId, definitionId)
        assertWindowPurposeSurvives(windowBefore, await countWindowPurposeSteps(tx, ctx.tenantId, definitionId))
        // Uno scopo nuovo può rendere protetto il passo di arrivo di una scadenza.
        await assertDefinitionDeadlines(tx, ctx.tenantId, definitionId)
      }
      return written
    })
    if (!result.records.length) throw new NotFoundError('WorkflowStep')
    invalidateWorkflowCache(ctx.tenantId, result.records[0].get('entityType') as string)
    const s = result.records[0].get('s').properties as Record<string, unknown>
    return {
      id:           s['id']             as string,
      name:         s['name']           as string,
      label:        s['label']          as string,
      labels:       parseLocalizedLabels(s['labels'], `step ${String(s['id'])}`),
      type:         s['type']           as string,
      enterActions: (s['enter_actions'] ?? null) as string | null,
      exitActions:  (s['exit_actions']  ?? null) as string | null,
      purpose:      (s['purpose']       ?? null) as string | null,
    }
  }, true)
}

export async function updateWorkflowTransition(
  _: unknown,
  { definitionId, transitionId, input }: {
    definitionId: string
    transitionId: string
    input: {
      label?: string | null
      trigger?: string | null
      requiresInput: boolean
      inputField?: string | null
      condition?: string | null
      timerHours?: number | null
    }
  },
  ctx: GraphQLContext,
) {
  const { label, requiresInput, inputField, timerHours } = input
  // Innesco e condizione validati PRIMA della scrittura: un innesco inventato
  // rende l'arco inerte, una condizione non registrata lo rende un muro.
  const trigger   = assertTransitionTrigger(input.trigger,    `transizione ${transitionId}`)
  const condition = assertTransitionCondition(input.condition, `transizione ${transitionId}`)
  return withSession(async (session) => {
    await session.executeWrite((tx) =>
      tx.run(`
        // tenant-ok: la definizione dello step di partenza è scopata alla riga dopo
        MATCH (src:WorkflowStep)-[t:TRANSITIONS_TO {id: $transitionId}]->()
        MATCH (wd:WorkflowDefinition {id: src.definition_id, tenant_id: $tenantId})
        ${MARK_CUSTOMIZED_BUMP}
        // Un'etichetta CAMBIATA nel disegnatore è del cliente: le traduzioni spedite non valgono più (#22).
        ${labelTranslationsCypher('t', 'coalesce($label, t.label)')}
        SET t.label          = coalesce($label, t.label),
            t.trigger        = coalesce($trigger, t.trigger),
            t.requires_input = $requiresInput,
            t.input_field    = coalesce($inputField, t.input_field),
            t.condition      = coalesce($condition, t.condition),
            t.timer_hours    = coalesce($timerHours, t.timer_hours)
      `, {
        transitionId,
        tenantId: ctx.tenantId,
        ...customizedParams(ctx),
        label:         label         ?? null,
        trigger:       trigger       ?? null,
        requiresInput,
        inputField:    inputField    ?? null,
        condition:     condition     ?? null,
        timerHours:    timerHours    ?? null,
      }),
    )
    const wdResult = await session.executeRead((tx) =>
      tx.run(`
        MATCH (wd:WorkflowDefinition {id: $definitionId, tenant_id: $tenantId})
        MATCH (wd)-[:HAS_STEP]->(s:WorkflowStep)
        RETURN wd, collect(s) AS steps
        LIMIT 1
      `, { definitionId, tenantId: ctx.tenantId }),
    )
    if (!wdResult.records.length) throw new NotFoundError('WorkflowDefinition')
    const wd    = wdResult.records[0].get('wd').properties    as Record<string, unknown>
    const steps = wdResult.records[0].get('steps') as Array<{ properties: Record<string, unknown> }>
    invalidateWorkflowCache(ctx.tenantId, wd['entity_type'] as string)
    const transitions = await loadTransitionRows(session, definitionId, ctx.tenantId)
    return mapWorkflowDefinition(wd, steps, transitions)
  }, true)
}

/**
 * Creates a new transition (arrow) between two steps of a definition — the
 * write path the Workflow Designer's onConnect calls. Persists the drawn
 * handles so the edge re-renders where the user placed it. Trigger defaults to
 * 'manual'; the user then edits it (e.g. to 'sla_breach') via the transition
 * panel + saveWorkflowChanges.
 */
export async function addWorkflowTransition(
  _: unknown,
  { definitionId, fromStepName, toStepName, trigger, label, sourceHandle, targetHandle }: {
    definitionId: string; fromStepName: string; toStepName: string
    trigger?: string | null; label?: string | null
    sourceHandle?: string | null; targetHandle?: string | null
  },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const id = uuidv4()
    const result = await session.executeWrite((tx) =>
      tx.run(`
        MATCH (wd:WorkflowDefinition {id: $definitionId, tenant_id: $tenantId})
        // tenant-ok: step della definizione appena scopata
        MATCH (from:WorkflowStep {definition_id: $definitionId, name: $fromStepName})
        // tenant-ok: idem
        MATCH (to:WorkflowStep   {definition_id: $definitionId, name: $toStepName})
        CREATE (from)-[tr:TRANSITIONS_TO {
          id: $id, trigger: $trigger, label: $label,
          requires_input: false, input_field: null, condition: null, timer_hours: null,
          source_handle: $sourceHandle, target_handle: $targetHandle
        }]->(to)
        ${MARK_CUSTOMIZED_BUMP}
        RETURN tr, from.name AS fromStep, to.name AS toStep, wd.entity_type AS entityType
      `, {
        definitionId, tenantId: ctx.tenantId, fromStepName, toStepName, id,
        trigger: assertTransitionTrigger(trigger, `new transition ${fromStepName} → ${toStepName}`) ?? 'manual',
        label: label ?? 'New transition',
        sourceHandle: sourceHandle ?? null, targetHandle: targetHandle ?? null,
        ...customizedParams(ctx),
      }),
    )
    if (!result.records.length) {
      throw new GraphQLError('Steps not found, or not part of this definition', { extensions: { code: 'NOT_FOUND', i18n: { key: 'errors.workflow.stepsNotInDefinition' } } })
    }
    invalidateWorkflowCache(ctx.tenantId, result.records[0].get('entityType') as string)
    const tr = result.records[0].get('tr').properties as Record<string, unknown>
    return {
      id,
      fromStepName:  result.records[0].get('fromStep') as string,
      toStepName:    result.records[0].get('toStep')   as string,
      trigger:       tr['trigger']        as string,
      label:         tr['label']          as string,
      labels:        [],
      requiresInput: false,
      inputField:    null,
      condition:     null,
      timerHours:    null,
      sourceHandle:  (tr['source_handle'] ?? null) as string | null,
      targetHandle:  (tr['target_handle'] ?? null) as string | null,
    }
  }, true)
}

/** Deletes a transition by id (Workflow Designer edge removal). */
export async function removeWorkflowTransition(
  _: unknown,
  { definitionId, transitionId }: { definitionId: string; transitionId: string },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const result = await session.executeWrite(async (tx) => {
      const removed = await tx.run(`
        MATCH (wd:WorkflowDefinition {id: $definitionId, tenant_id: $tenantId})
        // tenant-ok: step della definizione appena scopata
        MATCH (:WorkflowStep {definition_id: $definitionId})-[tr:TRANSITIONS_TO {id: $transitionId}]->()
        ${MARK_CUSTOMIZED_BUMP}
        WITH wd, tr, tr.id AS deletedId
        DELETE tr
        RETURN deletedId, wd.entity_type AS entityType
      `, { definitionId, tenantId: ctx.tenantId, transitionId, ...customizedParams(ctx) })
      // Un arco usato da una scadenza non si toglie: la scadenza resterebbe senza strada.
      await assertDefinitionDeadlines(tx, ctx.tenantId, definitionId)
      return removed
    })
    if (!result.records.length) return false
    invalidateWorkflowCache(ctx.tenantId, result.records[0].get('entityType') as string)
    return true
  }, true)
}

/**
 * Valida i metadati JSON dello step di arrivo (on_enter_fields, enter_actions)
 * prima di transizionare: se corrotti, la mutation fallisce SENZA aver
 * avanzato il workflow.
 */
async function preflightStepMetadata(
  session: import('neo4j-driver').Session,
  instanceId: string,
  toStep: string,
  tenantId: string,
): Promise<void> {
  const res = await session.executeRead((tx) => tx.run(`
    MATCH (wi:WorkflowInstance {id: $instanceId, tenant_id: $tenantId})
    // tenant-ok: step della definizione dell'istanza scopata
    MATCH (s:WorkflowStep {definition_id: wi.definition_id, name: $toStep})
    RETURN s.on_enter_fields AS fields, s.enter_actions AS enterActions
  `, { instanceId, toStep, tenantId }))
  if (!res.records.length) return // lo step non esiste: sarà l'engine a rifiutare la transizione
  const rec = res.records[0]
  for (const [key, label] of [['fields', 'on_enter_fields'], ['enterActions', 'enter_actions']] as const) {
    const raw = rec.get(key) as string | null
    if (!raw) continue
    try { JSON.parse(raw) } catch (e) {
      throw new GraphQLError(`Misconfigured workflow: ${label} of step "${toStep}" is not valid JSON (${e instanceof Error ? e.message : String(e)})`, { extensions: { code: 'CONFLICT', i18n: { key: 'errors.workflow.stepActionsNotJson', params: { field: label, step: toStep, reason: e instanceof Error ? e.message : String(e) } } } })
    }
  }
}

export async function executeWorkflowTransition(
  _: unknown,
  { instanceId, toStep, notes }: { instanceId: string; toStep: string; notes?: string },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    // Tenant-isolation guard: the instance must belong to the caller's tenant.
    // Everything downstream (engine.transition, re-reads by instanceId) relies
    // on this check having passed.
    // Pre-fetch entity data for template/condition evaluation in actions
    const entityDataResult = await session.executeRead((tx) =>
      tx.run(`
        MATCH (wi:WorkflowInstance {id: $instanceId, tenant_id: $tenantId})
        OPTIONAL MATCH (entity {id: wi.entity_id, tenant_id: $tenantId})
        OPTIONAL MATCH (entity)-[:ASSIGNED_TO]->(assignee)
        OPTIONAL MATCH (entity)-[:ASSIGNED_TO_TEAM]->(team)
        RETURN properties(entity) AS entityData,
               assignee.id AS assigned_to,
               team.id     AS assigned_team,
               wi.entity_type AS entityType
      `, { instanceId, tenantId: ctx.tenantId }),
    )
    if (entityDataResult.records.length === 0) {
      throw new GraphQLError(`Workflow instance not found: ${instanceId}`, { extensions: { code: 'NOT_FOUND' } })
    }
    // Le change hanno un gate di approvazione multi-parte e side-effect di
    // fase (task, approvazioni, rischio) che vivono in executeChangeTransition:
    // la mutation generica NON deve poter aggirarli.
    if (entityDataResult.records[0].get('entityType') === 'change') {
      throw new GraphQLError('Changes are transitioned with executeChangeTransition (approval gate and phase side effects)', { extensions: { code: 'CONFLICT', i18n: { key: 'errors.workflow.changeUsesChangeTransition' } } })
    }
    if (entityDataResult.records[0].get('entityType') === 'service_request'
        && await requestApprovalWouldBeSkipped(session, ctx.tenantId, instanceId, toStep)) {
      throw new GraphQLError(
        'This request needs an approval: send it to approval first',
        { extensions: { code: 'CONFLICT', i18n: { key: 'errors.request.approvalRequired' } } },
      )
    }
    const entityData: Record<string, unknown> = {
      ...((entityDataResult.records[0].get('entityData') as Record<string, unknown> | null) ?? {}),
      assigned_to:   entityDataResult.records[0].get('assigned_to') ?? null,
      assigned_team: entityDataResult.records[0].get('assigned_team') ?? null,
    }

    const actionCtx: ActionContext = {
      userId:     ctx.userId,
      notes,
      entityData,

      createEntity: async (type, data) => {
        const { createEntityFromStepAction } = await import('../../lib/stepActionCreateEntity.js')
        return createEntityFromStepAction(session, { tenantId: ctx.tenantId, userId: ctx.userId }, type, data, {
          id:   (entityDataResult.records[0]!.get('entityData') as Record<string, unknown> | null)?.['id'] as string | undefined,
          type: entityDataResult.records[0]!.get('entityType') as string,
        })
      },

      assignTo: async (entityId, targetType, targetId) => {
        // Secondo giro UI del 15 set 2026: per il team era un MERGE senza togliere
        // quello di prima (il ticket restava con due team). Ora sostituisce, e per
        // il team scrive anche la storia delle assegnazioni (lib/ticketTeamHistory.ts).
        const now = new Date().toISOString()
        if (targetType !== 'team') {
          const { assertAssignablePerson } = await import('../../services/ticketAssignment.js')
          await assertAssignablePerson(session, targetId, ctx.tenantId)
        }
        await session.executeWrite((tx) =>
          targetType === 'team'
            ? tx.run(
              `MATCH (e {id: $entityId, tenant_id: $tenantId})
               MATCH (t:Team {id: $targetId, tenant_id: $tenantId})
               ${assignTeamCypher('e', 't')}
               SET e.updated_at = $now`,
              { entityId, tenantId: ctx.tenantId, targetId, now, [TEAM_NOW_PARAM]: now },
            )
            : tx.run(
              `MATCH (e {id: $entityId, tenant_id: $tenantId})
               MATCH (u:User {id: $targetId, tenant_id: $tenantId})
               OPTIONAL MATCH (e)-[old:ASSIGNED_TO]->(:User)
               DELETE old
               WITH DISTINCT e, u
               MERGE (e)-[:ASSIGNED_TO]->(u)
               SET e.updated_at = $now`,
              { entityId, tenantId: ctx.tenantId, targetId, now },
            ),
        )
      },

      updateField: async (entityId, field, value) => {
        // Stessa scrittura delle automazioni (lib/ticketFieldWrite.ts, AU-3):
        // la priorità nella proprietà giusta, l'invariante della matrice. Prima
        // il campo e il valore contro il metamodello di ADESSO (ondata 3).
        const entityType = entityDataResult.records[0]!.get('entityType') as string
        const metas = await stepFieldMetas(session, ctx.tenantId, entityType)
        const checked = assertStepFieldValue(metas, entityType, field, value, `update_field of step "${toStep}"`, { allowTemplate: false })
        const { writeTicketField } = await import('../../lib/ticketFieldWrite.js')
        await writeTicketField(session, ctx.tenantId, entityType, entityId, field, checked)
      },

      publishEvent: async (type, payload) => {
        await publish({
          id:             uuidv4(),
          type,
          tenant_id:      ctx.tenantId,
          timestamp:      new Date().toISOString(),
          correlation_id: uuidv4(),
          actor_id:       ctx.userId,
          payload,
        })
      },

      createApprovalRequest: async ({ entityId, entityType, title, approverRole, approvalType }) => {
        const now = new Date().toISOString()

        // Find approvers by role
        const adminsRes = await session.executeRead((tx) =>
          tx.run(
            `MATCH (u:User {tenant_id: $tenantId, role: $role}) RETURN u.id AS id`,
            { tenantId: ctx.tenantId, role: approverRole ?? 'admin' },
          ),
        )
        const approverIds = adminsRes.records.map((r) => r.get('id') as string)
        if (approverIds.length === 0) {
          throw new GraphQLError(`No user with role "${approverRole ?? 'admin'}" configured to approve`, { extensions: { code: 'NO_APPROVER', i18n: { key: 'errors.workflow.noApprover', params: { role: approverRole ?? 'admin' } } } })
        }
        const finalApprovers = approverIds

        const approvalId = uuidv4()
        await session.executeWrite((tx) =>
          tx.run(`
            CREATE (ap:ApprovalRequest {
              id:              $id,
              tenant_id:       $tenantId,
              entity_type:     $entityType,
              entity_id:       $entityId,
              title:           $title,
              description:     null,
              status:          'pending',
              requested_by:    $requestedBy,
              requested_at:    $now,
              approvers:       $approvers,
              approved_by:     '[]',
              rejected_by:     null,
              approval_type:   $approvalType,
              due_date:        null,
              resolved_at:     null,
              resolution_note: null
            })
          `, {
            id:           approvalId,
            tenantId:     ctx.tenantId,
            entityType,
            entityId,
            title,
            requestedBy:  ctx.userId,
            now,
            approvers:    JSON.stringify(finalApprovers),
            approvalType: approvalType ?? 'any',
          }),
        )

        // Notify each approver via SSE
        for (const approverId of finalApprovers) {
          sseManager.sendToUser(ctx.tenantId, approverId, {
            id:          uuidv4(),
            type:        'approval.requested',
            title:          'notification.approval.requested.title',
            title_fallback: await systemText(ctx.tenantId, 'approval.requested'),
            message:     title,
            severity:    'info',
            entity_id:   approvalId,
            entity_type: 'ApprovalRequest',
            timestamp:   now,
            read:        false,
          })
        }

        return approvalId
      },
    }

    // Validate required fields for the destination step before allowing transition.
    // Merge entity data with transition notes (notes map to resolution_notes/root_cause).
    if (entityData && Object.keys(entityData).length > 0) {
      const entityTypeRaw = await session.executeRead((tx) =>
        tx.run(`MATCH (wi:WorkflowInstance {id: $instanceId, tenant_id: $tenantId}) RETURN wi.entity_type AS et`, { instanceId, tenantId: ctx.tenantId }),
      )
      const entityType = entityTypeRaw.records[0]?.get('et') as string | null
      if (entityType) {
        const mergedValues = { ...entityData }
        if (notes) {
          mergedValues['resolution_notes'] = notes
          mergedValues['root_cause']       = notes
        }
        await validateRequiredFields(session, {
          entityType,
          fieldValues: mergedValues,
          tenantId:    ctx.tenantId,
          toStep,
        })
      }
    }

    // I metadati dello step di arrivo (on_enter_fields, enter_actions) vengono
    // validati PRIMA della transizione: un JSON corrotto deve bloccare, non
    // far fallire la mutation dopo che il workflow è già avanzato.
    await preflightStepMetadata(session, instanceId, toStep, ctx.tenantId)

    workflowLogger.debug({ toStep, instanceId }, 'Transitioning workflow step')
    const result = await workflowEngine.transition(
      session,
      {
        instanceId,
        toStepName:  toStep,
        triggeredBy: ctx.userId,
        triggerType: 'manual',
        notes,
        tenantId:    ctx.tenantId,
      },
      actionCtx,
    )
    // Side-effect post-commit falliti: la transizione è già persistita, quindi
    // NON si lancia (l'utente vedrebbe "fallito" con il workflow avanzato) ma
    // finiscono in actionErrors, come quelli dell'engine.
    const postErrors: string[] = []
    const post = async (what: string, fn: () => Promise<unknown>) => {
      try { await fn() } catch (e) {
        const msg = `${what}: ${e instanceof Error ? e.message : String(e)}`
        workflowLogger.error({ instanceId, toStep, err: e }, `[workflow] post-transition side effect failed — ${what}`)
        postErrors.push(msg)
      }
    }
    workflowLogger.debug({ instanceId, success: result.success }, 'Workflow transition result')

    if (result.success) {
      const wiResult = await session.executeRead((tx) =>
        tx.run(`
          MATCH (wi:WorkflowInstance {id: $instanceId, tenant_id: $tenantId})
          WHERE wi.entity_type = 'incident'
          MATCH (i:Incident {id: wi.entity_id, tenant_id: wi.tenant_id})
          OPTIONAL MATCH (i)-[:AFFECTED_BY]->(ci:ConfigurationItem)
          OPTIONAL MATCH (i)-[:ASSIGNED_TO]->(u:User)
          OPTIONAL MATCH (i)-[:ASSIGNED_TO_TEAM]->(t:Team)
          RETURN i.id AS id, i.title AS title, i.severity AS severity, i.status AS status,
                 wi.tenant_id AS tenantId,
                 collect(DISTINCT ci.name)[0] AS ciName,
                 u.name AS assignedTo, t.name AS teamName
        `, { instanceId, tenantId: ctx.tenantId }),
      )
      if (wiResult.records.length > 0) {
        const r        = wiResult.records[0]
        const tenantId = r.get('tenantId') as string
        const incidentId = r.get('id') as string

        // Add automatic comment for every incident workflow transition
        // Il nome del passo nella sua etichetta, e il testo nella lingua del cliente.
        const stepLabel = (await loadStepFacts(session, tenantId, 'incident', toStep)).step_label
        const commentText = notes
          ? await systemText(tenantId, 'workflow.transitionCommentNotes', { step: stepLabel, notes })
          : await systemText(tenantId, 'workflow.transitionComment', { step: stepLabel })
        const now = new Date().toISOString()
        await session.executeWrite((tx) => tx.run(`
          MATCH (i:Incident {id: $incidentId, tenant_id: $tenantId})
          CREATE (c:Comment {
            id:         randomUUID(),
            tenant_id:  $tenantId,
            text:       $text,
            // Nota di transizione: interna (lib/ticketComments.ts).
            is_internal: true,
            author_id:  $userId,
            created_at: $now,
            updated_at: $now
          })
          CREATE (i)-[:HAS_COMMENT]->(c)
        `, { incidentId, tenantId, text: commentText, userId: ctx.userId, now }))

        // Generic post-transition: publish an event named after the target
        // step and audit. Field updates (resolved_at, assigned_at, etc.)
        // are driven by the step's `on_enter_fields` metadata, applied below.
        await post('publish incident transition', () => incidentService.publishIncidentTransition(incidentId, toStep, { tenantId, userId: ctx.userId }))
        // Azione di audit STABILE, passo nei dettagli (D-22): l'azione non è
        // più composta col nome del passo, che una rinomina cambiava spezzando
        // in due la storia dei filtri e dei report. Il taglio nel vocabolario è
        // dichiarato (vedi auditStepEntered): le voci storiche NON si riscrivono.
        await post('audit step entered', () => auditStepEntered(session, ctx, 'incident', 'Incident', incidentId, toStep))

        await post('on_enter_fields', () => applyOnEnterFields(session, instanceId, toStep, ctx.userId, notes, ctx.tenantId))

        // Publish workflow.step.entered for any notify_rule enter_actions on this step
        // (SLA pause/resume is driven by the step's own sla_pause/sla_resume
        // enter/exit actions, consumed by the SLA engine — see packages/sla.)
        await post('notify rules', () => publishNotifyRuleActions(session, instanceId, toStep, tenantId, ctx.userId, 'incident', incidentId))
      }

      // ── KB Article post-transition ────────────────────────────────────────
      const kbResult = await session.executeRead((tx) =>
        tx.run(`
          MATCH (wi:WorkflowInstance {id: $instanceId, tenant_id: $tenantId})
          WHERE wi.entity_type = 'kb_article'
          MATCH (a:KBArticle {id: wi.entity_id, tenant_id: wi.tenant_id})
          RETURN a.id AS id, wi.tenant_id AS tenantId, a.requested_by AS requestedBy
        `, { instanceId, tenantId: ctx.tenantId }),
      )
      if (kbResult.records.length > 0) {
        const kbId     = kbResult.records[0].get('id')     as string
        const tenantId = kbResult.records[0].get('tenantId') as string
        await post('audit step entered', () => auditStepEntered(session, ctx, 'kb_article', 'KBArticle', kbId, toStep))
        await post('on_enter_fields', () => applyOnEnterFields(session, instanceId, toStep, ctx.userId, notes, ctx.tenantId))
        await post('notify rules', () => publishNotifyRuleActions(session, instanceId, toStep, tenantId, ctx.userId, 'kb_article', kbId))
      }
    }

    if (result.actionErrors?.length) {
      workflowLogger.error({ instanceId, actionErrors: result.actionErrors },
        '[workflow] transition persisted but step actions failed')
    }
    const allActionErrors = [...(result.actionErrors ?? []), ...postErrors]

    return {
      success:      result.success,
      ...transitionErrorFields(result),
      instance:     result.instance ?? null,
      actionErrors: allActionErrors.length > 0 ? allActionErrors : null,
    }
  }, true)
}

export async function saveWorkflowChanges(
  _: unknown,
  { definitionId, transitions, positions, steps, expectedVersion }: {
    definitionId: string
    transitions: Array<{
      transitionId:  string
      label?:        string | null
      trigger?:      string | null
      requiresInput: boolean
      inputField?:   string | null
      condition?:    string | null
      timerHours?:   number | null
    }>
    positions: Array<{ stepId: string; positionX: number; positionY: number }>
    steps?: Array<{
      stepName:     string
      label:        string
      enterActions: string | null
      exitActions:  string | null
      isInitial?:   boolean | null
      isTerminal?:  boolean | null
      isOpen?:      boolean | null
      category?:    string | null
      purpose?:     string | null
      /** La scadenza del passo (JSON): assente/null = invariata, '' = tolta. */
      deadline?:    string | null
    }> | null
    /** Optimistic lock: versione letta dal client. Null = nessun controllo. */
    expectedVersion?: number | null
  },
  ctx: GraphQLContext,
) {
  const now = new Date().toISOString()
  // Azioni validate PRIMA di aprire la transazione (B0-5): un tipo fuori
  // vocabolario non entra nel grafo dal disegnatore.
  // Azioni e scopo validati PRIMA di aprire la transazione: uno scopo fuori
  // vocabolario non entra nel grafo dal disegnatore (B4-3).
  await assertRolesExist(ctx.tenantId, (steps ?? []).flatMap((st) => [...roleKeysInActions(st.enterActions), ...roleKeysInActions(st.exitActions)]))
  const stepRows = (steps ?? []).map((st) => {
    assertStepActions(st.enterActions, `enter_actions of step "${st.stepName}"`)
    assertStepActions(st.exitActions,  `exit_actions of step "${st.stepName}"`)
    const purposeValue = normalizeStepPurpose(st.purpose, `step "${st.stepName}"`)
    const category     = normalizeStepCategory(st.category, `step "${st.stepName}"`)
    const deadline     = normalizeStepDeadlineInput(st.deadline, `deadline of step "${st.stepName}"`)
    return {
      ...st, category, purposeGiven: purposeValue !== undefined, purpose: purposeValue ?? null,
      deadlineGiven: deadline.given, parsedDeadline: deadline.deadline,
      deadline: deadline.deadline ? JSON.stringify(deadline.deadline) : null,
      deadlineCalendarId: deadline.deadline?.calendar_id ?? null,
    }
  })
  // Innesco e condizione di ogni arco, prima della transazione (revisione · B·M-4).
  const transitionRows = transitions.map((tr) => ({
    ...tr,
    trigger:   assertTransitionTrigger(tr.trigger,    `transizione ${tr.transitionId}`),
    condition: assertTransitionCondition(tr.condition, `transizione ${tr.transitionId}`),
  }))
  return withSession(async (session) => {
    // Campi di `update_field` e delle scadenze contro il metamodello: servono
    // letture che non stanno dentro la transazione di scrittura.
    if (stepRows.some((st) => hasUpdateField(st.enterActions) || hasUpdateField(st.exitActions) || (st.parsedDeadline?.set_fields.length ?? 0) > 0)) {
      const entityType = await definitionEntityType(session, ctx.tenantId, definitionId)
      for (const st of stepRows) {
        await assertStepActionFields(session, ctx.tenantId, entityType, st.enterActions, `enter_actions of step "${st.stepName}"`)
        await assertStepActionFields(session, ctx.tenantId, entityType, st.exitActions,  `exit_actions of step "${st.stepName}"`)
        if (st.parsedDeadline) await assertDeadlineFields(session, ctx.tenantId, entityType, st.parsedDeadline, `deadline of step "${st.label || st.stepName}"`)
      }
    }
    // Tutto in UNA transazione: controllo di versione, aggiornamenti e
    // incremento. Prima erano write separate senza confronto di versione →
    // last-writer-wins silenzioso tra due designer aperti sullo stesso workflow.
    const wd = await session.executeWrite(async (tx) => {
      const cur = await tx.run(`
        MATCH (wd:WorkflowDefinition {id: $definitionId, tenant_id: $tenantId})
        RETURN wd.version AS version
      `, { definitionId, tenantId: ctx.tenantId })
      if (!cur.records.length) throw new NotFoundError('WorkflowDefinition')
      const currentVersion = Number(cur.records[0].get('version') ?? 1)
      const before = await workflowSnapshot(tx, ctx.tenantId, definitionId)
      if (expectedVersion != null && currentVersion !== expectedVersion) {
        throw new GraphQLError(
          `Workflow changed by another user (version ${currentVersion}, you were editing v${expectedVersion}): your changes were not applied. Reload the page so you do not overwrite theirs.`,
          {
            extensions: {
              code: 'CONFLICT', currentVersion, expectedVersion,
              i18n: { key: 'errors.workflow.concurrentEdit', params: { current: currentVersion, expected: expectedVersion } },
            },
          },
        )
      }

      // Update each transition
      if (transitions.length > 0) {
        await tx.run(`
          MATCH (wd:WorkflowDefinition {id: $definitionId, tenant_id: $tenantId})
          UNWIND $transitions AS tr
          // tenant-ok: wd già scopata sopra
          MATCH (src:WorkflowStep {definition_id: wd.id})-[t:TRANSITIONS_TO {id: tr.transitionId}]->()
          // Un'etichetta CAMBIATA nel disegnatore è del cliente: le traduzioni spedite non valgono più (#22).
          ${labelTranslationsCypher('t', 'coalesce(tr.label, t.label)')}
          SET t.label          = coalesce(tr.label, t.label),
              t.trigger        = coalesce(tr.trigger, t.trigger),
              t.requires_input = tr.requiresInput,
              t.input_field    = tr.inputField,
              t.condition      = tr.condition,
              t.timer_hours    = tr.timerHours
        `, { transitions: transitionRows, definitionId, tenantId: ctx.tenantId })
      }
      // Update step properties (label, enterActions, exitActions, metadata)
      if (steps && steps.length > 0) {
        // Un passo non può essere insieme iniziale e terminale: il processo
        // nascerebbe già chiuso (B-8). Il controllo tiene conto sia di quello
        // che questa chiamata sta scrivendo sia di quello che c'è nel grafo.
        const wantsInitial = steps.filter((s) => s.isInitial === true)
        if (wantsInitial.length > 1) {
          throw new GraphQLError(
            `Only one step can be initial: you marked ${wantsInitial.length} (${wantsInitial.map((s) => s.stepName).join(', ')}).`,
            { extensions: { code: 'BAD_USER_INPUT', i18n: { key: 'errors.workflow.manyInitial', params: { count: wantsInitial.length, steps: wantsInitial.map((s) => s.stepName).join(', ') } } } },
          )
        }
        const initial = wantsInitial[0]
        if (initial) {
          const cur = await tx.run(`
            MATCH (wd:WorkflowDefinition {id: $definitionId, tenant_id: $tenantId})-[:HAS_STEP]->(s:WorkflowStep {name: $stepName})
            RETURN coalesce(s.is_terminal, s.type = 'end') AS terminal
          `, { definitionId, tenantId: ctx.tenantId, stepName: initial.stepName })
          if (!cur.records.length) {
            throw new GraphQLError(`Step "${initial.stepName}" not found in this definition`, { extensions: { code: 'NOT_FOUND', i18n: { key: 'errors.workflow.stepNotFound', params: { name: initial.stepName } } } })
          }
          const terminalAfter = initial.isTerminal ?? Boolean(cur.records[0].get('terminal'))
          if (terminalAfter) {
            throw new GraphQLError(
              `Step "${initial.stepName}" is terminal: it cannot also be the initial step, `
              + `or every new ticket would be born already closed. Clear «Terminal step», or pick another initial step.`,
              { extensions: { code: 'BAD_USER_INPUT', i18n: { key: 'errors.workflow.initialAndTerminal', params: { name: initial.stepName } } } },
            )
          }
        }
        const windowBefore = stepRows.some((st) => st.purposeGiven)
          ? await countWindowPurposeSteps(tx, ctx.tenantId, definitionId)
          : null
        await tx.run(`
          UNWIND $steps AS st
          MATCH (wd:WorkflowDefinition {id: $definitionId, tenant_id: $tenantId})-[:HAS_STEP]->(s:WorkflowStep {name: st.stepName})
          // Un'etichetta CAMBIATA nel disegnatore è del cliente: le traduzioni spedite non valgono più (#22).
          ${labelTranslationsCypher('s', 'st.label')}
          SET s.label         = st.label,
              s.enter_actions = st.enterActions,
              s.exit_actions  = st.exitActions,
              s.is_initial    = coalesce(st.isInitial,  s.is_initial),
              s.is_terminal   = coalesce(st.isTerminal, s.is_terminal),
              s.is_open       = coalesce(st.isOpen,     s.is_open),
              s.category      = coalesce(st.category,   s.category),
              // NON coalesce: lo scopo si deve poter TOGLIERE (purpose = null
              // con purposeGiven = true). Un coalesce lo renderebbe definitivo.
              s.purpose       = CASE WHEN st.purposeGiven THEN st.purpose ELSE s.purpose END,
              // Come lo scopo: la scadenza si deve poter TOGLIERE.
              s.deadline      = CASE WHEN st.deadlineGiven THEN st.deadline ELSE s.deadline END,
              s.deadline_calendar_id = CASE WHEN st.deadlineGiven THEN st.deadlineCalendarId ELSE s.deadline_calendar_id END
        `, { definitionId, tenantId: ctx.tenantId, steps: stepRows.map(({ parsedDeadline: _p, ...row }) => row) })

        // Se una delle modifiche ha TOCCATO lo scopo, il workflow delle change
        // deve conservare un posto dove approvare (revisione · B·N-1) e almeno
        // un passo della finestra di rilascio (terza revisione · G2).
        //
        // La condizione era `st.purpose === null`, cioè solo la RIMOZIONE:
        // sostituire lo scopo dell'unico passo di approvazione con un altro
        // valore della tendina svuotava il workflow senza svegliare la guardia.
        if (stepRows.some((st) => st.purposeGiven)) {
          await assertApprovalPurposeSurvives(tx, ctx.tenantId, definitionId)
          assertWindowPurposeSurvives(windowBefore, await countWindowPurposeSteps(tx, ctx.tenantId, definitionId))
        }

        // If any step was marked isInitial=true, demote the others in the same
        // workflow so there's at most one initial step.
        const initialStepName = steps.find((s) => s.isInitial === true)?.stepName
        if (initialStepName) {
          await tx.run(`
            MATCH (wd:WorkflowDefinition {id: $definitionId, tenant_id: $tenantId})-[:HAS_STEP]->(s:WorkflowStep)
            WHERE s.name <> $keep
            SET s.is_initial = false
          `, { definitionId, tenantId: ctx.tenantId, keep: initialStepName })
        }
      }
      // Update step positions
      if (positions.length > 0) {
        await tx.run(`
          UNWIND $positions AS pos
          MATCH (s:WorkflowStep {id: pos.stepId})<-[:HAS_STEP]-(wd:WorkflowDefinition {
            id: $definitionId, tenant_id: $tenantId
          })
          SET s.position_x = pos.positionX,
              s.position_y = pos.positionY
        `, { definitionId, tenantId: ctx.tenantId, positions })
      }
      // Le scadenze contro il workflow come risulta da QUESTE modifiche: uno
      // scopo nuovo o una scadenza appena scritta (ondata 3). Gli archi qui
      // cambiano solo innesco ed etichetta, che a una scadenza non tolgono strada.
      if (stepRows.some((st) => st.purposeGiven || st.deadlineGiven)) {
        await assertDefinitionDeadlines(tx, ctx.tenantId, definitionId)
      }
      // Increment version (dopo il check, nella stessa tx)
      const wdResult = await tx.run(`
        MATCH (wd:WorkflowDefinition {id: $definitionId, tenant_id: $tenantId})
        SET wd.version    = wd.version + 1,
            wd.updated_at = $now
        ${MARK_CUSTOMIZED}
        RETURN wd
      `, { definitionId, tenantId: ctx.tenantId, now, ...customizedParams(ctx) })
      if (!wdResult.records.length) throw new NotFoundError('WorkflowDefinition')
      const saved = wdResult.records[0].get('wd').properties as Record<string, unknown>
      const after = await workflowSnapshot(tx, ctx.tenantId, definitionId)
      return { saved, details: workflowChangeDetails(before, after, currentVersion, Number(saved['version'])) }
    })

    invalidateWorkflowCache(ctx.tenantId, wd.saved['entity_type'] as string)
    void audit(ctx, 'workflow.updated', 'WorkflowDefinition', definitionId, wd.details)

    const stepsResult = await session.executeRead((tx) =>
      tx.run(`MATCH (wd:WorkflowDefinition {id: $definitionId, tenant_id: $tenantId})-[:HAS_STEP]->(s:WorkflowStep) RETURN collect(s) AS steps`,
        { definitionId, tenantId: ctx.tenantId }),
    )
    const savedSteps = stepsResult.records[0]?.get('steps') as Array<{ properties: Record<string, unknown> }> ?? []
    // NB: nome diverso dal parametro `transitions`. Quando questa variabile si
    // chiamava come lui, il `transitions.length` dentro la transazione leggeva
    // QUESTA (zona morta temporale) e la mutation falliva sempre con un
    // ReferenceError — «Salva modifiche» del disegnatore non salvava niente.
    const savedTransitions = await loadTransitionRows(session, definitionId, ctx.tenantId)
    return mapWorkflowDefinition(wd.saved, savedSteps, savedTransitions)
  }, true)
}
