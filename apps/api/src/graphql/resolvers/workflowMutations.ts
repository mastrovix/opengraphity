import { GraphQLError } from 'graphql'
import { NotFoundError, ValidationError } from '../../lib/errors.js'
import { v4 as uuidv4 } from 'uuid'
import { isWorkflowActionType, WORKFLOW_ACTION_TYPES } from '@opengraphity/workflow'
import { parseLocalizedLabels } from '@opengraphity/types'
import {
  NOTIFICATION_BASE_TARGETS, isNotificationTarget, isTargetApplicable, applicableNotificationTargets,
  WORKFLOW_STEP_PURPOSES, isWorkflowStepPurpose,
  WORKFLOW_STEP_CATEGORIES, isWorkflowStepCategory,
  WORKFLOW_TRANSITION_TRIGGERS, isWorkflowTransitionTrigger,
  WORKFLOW_TRANSITION_CONDITIONS, isWorkflowTransitionCondition,
  stepFieldRejection,
  CHANGE_WINDOW_PURPOSES,
} from '@opengraphity/types'
import { unroutableChannels, routableChannels, WORKFLOW_STEP_NOTIFY_EVENT } from '@opengraphity/notifications'
import type { GraphQLContext } from '../../context.js'
import { withSession } from './ci-utils.js'
import { loadTransitionRows, mapWorkflowDefinition } from './workflowMapping.js'
import { workflowLogger } from '../../lib/logger.js'
import { audit } from '../../lib/audit.js'
import { requirePermission } from '../../lib/permissions.js'
import { assertTimerDelayMinutes } from '../../lib/stepTimerDelay.js'
import { invalidateWorkflowCache } from '../../lib/workflowHelpers.js'
import { auditStepEntered} from '../../lib/stepEvent.js'
import { transitionErrorFields } from '../../lib/transitionError.js'
import { personActor, refusalError, transitionTicket } from '../../services/ticketTransition.js'
import { assertStepFieldValue, stepFieldMetas } from '../../lib/stepFieldWrites.js'
import { assertDeadlineFields, assertDefinitionDeadlines, normalizeStepDeadlineInput } from '../../lib/stepDeadlineWrite.js'
import { assertRolesExist, roleKeysInActions } from '../../lib/roles.js'
import { labelTranslationsCypher } from '../../lib/workflowLabelTranslations.js'
import { workflowChangeDetails, workflowSnapshot } from '../../lib/workflowAuditDetails.js'

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
export function assertStepActions(raw: string | null | undefined, label: string, fase: 'enter' | 'exit' = 'enter'): void {
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
    /**
     * UN COMPITO SI CREA SOLO ENTRANDO in un passo (rimedio, 20 set 2026). Le
     * azioni di USCITA girano con l'istanza già spostata sul passo nuovo:
     * un compito creato lì nascerebbe timbrato col passo sbagliato, non
     * bloccherebbe l'uscita che doveva bloccare e bloccherebbe quella dopo.
     * Il rifiuto arriva qui, nel disegnatore, e non dentro un log a ticket
     * rotto.
     */
    if (type === 'create_task' && fase === 'exit') {
      throw new GraphQLError(
        `${label}[${i}]: a task can only be created entering a step, not leaving one.`,
        { extensions: { code: 'BAD_USER_INPUT', i18n: { key: 'errors.workflow.taskOnlyOnEnter', params: { field: `${label}[${i}]` } } } },
      )
    }
    if (type === 'notify_rule') {
      // I CANALI del passo: la scheda «Notifiche» del disegnatore offriva
      // in_app/slack/teams/email, ma il dispatcher per `workflow.step.entered`
      // instrada solo in_app ed email e LANCIA sugli altri — un passo con
      // Slack spuntato si salvava e generava un job fallito a ogni ingresso
      // nel passo, senza nessuna notifica (revisione totale · G-8). Qui si
      // rifiuta al salvataggio, come fanno le regole di notifica.
      const channels = (action as { params?: Record<string, unknown> }).params?.['channels']
      if (Array.isArray(channels)) {
        const bad = unroutableChannels(WORKFLOW_STEP_NOTIFY_EVENT, channels.filter((c): c is string => typeof c === 'string'))
        if (bad.length > 0) {
          const allowed = routableChannels(WORKFLOW_STEP_NOTIFY_EVENT).join(', ')
          throw new GraphQLError(
            `${label}[${i}]: channels [${bad.join(', ')}] cannot be delivered when a step is entered. Allowed: ${allowed}.`,
            { extensions: { code: 'BAD_USER_INPUT', i18n: { key: 'errors.workflow.badStepChannels', params: { field: `${label}[${i}]`, channels: bad.join(', '), allowed } } } },
          )
        }
      }
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
 * A MANUAL transition is a button on the ticket, and its label is the button's
 * text: a write must not leave one blank (tour of 23 Sep 2026). The designer
 * blanked the label of a return arrow in its data, and saving any other change
 * of that arrow wrote `label: ''` over «Reopen» — an empty button on every
 * ticket in that step, with nothing said.
 *
 * The check reads the transitions as the write LEFT them (the query returns
 * `blankManualLabel`, `fromStep`, `toStep` per transition), so it holds whatever
 * the call changed — the label, the trigger, or both. It runs inside the write
 * transaction: throwing here rolls the whole write back.
 */
export function assertManualTransitionsLabelled<R extends { records: Array<{ get: (key: string) => unknown }> }>(written: R): R {
  const blank = written.records.find((r) => r.get('blankManualLabel') === true)
  if (!blank) return written
  const from = String(blank.get('fromStep'))
  const to   = String(blank.get('toStep'))
  throw new GraphQLError(
    `The manual transition «${from}» → «${to}» would be left without a label: its label is the text of the button `
    + `people click on the ticket. Give it a label, or change its trigger.`,
    { extensions: { code: 'BAD_USER_INPUT', i18n: { key: 'errors.workflow.manualTransitionNeedsLabel', params: { from, to } } } },
  )
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
export async function assertApprovalPurposeSurvives(
  tx: { run: (q: string, p: Record<string, unknown>) => Promise<{ records: Array<{ get: (k: string) => unknown }> }> },
  tenantId: string, definitionId: string,
): Promise<void> {
  const res = await tx.run(`
    MATCH (wd:WorkflowDefinition {id: $definitionId, tenant_id: $tenantId})
    WHERE wd.entity_type = 'change'
    // tenant-ok(traversal): i passi sono quelli della definizione già scopata sopra
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
    + `tenant changes are not approved — add those types to the pre-approved ones (Data model → Domain matrices).`,
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
/**
 * A workflow keeps an initial step (review of 23 Sep 2026). Unticking «Initial
 * step» on the only one was saved — the checks ran only when a step was
 * marked initial — and the next ticket of that type failed, in the face of
 * whoever opened it. Deleting that step was already refused; this is the
 * same end state from the other door.
 */
async function assertInitialStepRemains(
  tx: { run: (q: string, p: Record<string, unknown>) => Promise<{ records: Array<{ get: (k: string) => unknown }> }> },
  tenantId: string, definitionId: string,
): Promise<void> {
  const res = await tx.run(`
    MATCH (wd:WorkflowDefinition {id: $definitionId, tenant_id: $tenantId})
    // tenant-ok(traversal): i passi sono quelli della definizione già scopata sopra
    OPTIONAL MATCH (wd)-[:HAS_STEP]->(s:WorkflowStep)
      WHERE coalesce(s.is_initial, s.type = 'start')
    RETURN wd.id AS definitionId, count(s) AS n
  `, { definitionId, tenantId })
  if (!res.records.length || Number(res.records[0]!.get('n')) > 0) return
  throw new GraphQLError(
    'The workflow would have no initial step: no new ticket could be created. Mark another step as initial first.',
    { extensions: { code: 'BAD_USER_INPUT', i18n: { key: 'errors.workflow.noInitialStep' } } },
  )
}

export async function countWindowPurposeSteps(
  tx: { run: (q: string, p: Record<string, unknown>) => Promise<{ records: Array<{ get: (k: string) => unknown }> }> },
  tenantId: string, definitionId: string,
): Promise<number | null> {
  const res = await tx.run(`
    MATCH (wd:WorkflowDefinition {id: $definitionId, tenant_id: $tenantId})
    WHERE wd.entity_type = 'change'
    // tenant-ok(traversal): i passi sono quelli della definizione già scopata sopra
    OPTIONAL MATCH (wd)-[:HAS_STEP]->(s:WorkflowStep)
      WHERE s.purpose IN $windowPurposes
    RETURN wd.id AS definitionId, count(s) AS n
  `, { definitionId, tenantId, windowPurposes: [...CHANGE_WINDOW_PURPOSES] })
  // Nessuna riga = non e un workflow delle change: niente da verificare.
  if (!res.records.length) return null
  return Number(res.records[0]!.get('n'))
}

export function assertWindowPurposeSurvives(before: number | null, after: number | null): void {
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
  assertStepActions(exitActions,  `exit_actions of step "${stepName}"`, 'exit')
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
  /**
   * `coalesce($x, t.x)` non permetteva di CANCELLARE un valore: passare null
   * lasciava quello vecchio, e una condizione sbagliata su una transizione non
   * si poteva più togliere dalla mutation puntuale — restava e bloccava la
   * transizione (revisione totale · M-9). Ora conta se il campo è PRESENTE
   * nell'input: presente e null = cancella, assente = non si tocca. Il
   * commento di `assertTransitionCondition` promette esattamente questo.
   */
  const given = (field: keyof typeof input) => Object.prototype.hasOwnProperty.call(input, field)
  return withSession(async (session) => {
    const written = await session.executeWrite(async (tx) => assertManualTransitionsLabelled(
      await tx.run(`
        // La transizione DEVE essere di questa definizione (revisione totale ·
        // B-26): prima era cercata per solo id, e il «customizzato» veniva
        // segnato sulla definizione dello step di partenza — cioè un'altra
        // definizione dello stesso tenant si modificava per conto di questa.
        MATCH (wd:WorkflowDefinition {id: $definitionId, tenant_id: $tenantId})
        // tenant-ok(traversal): lo step di partenza è della definizione appena scopata
        MATCH (src:WorkflowStep {definition_id: $definitionId})-[t:TRANSITIONS_TO {id: $transitionId}]->()
        ${MARK_CUSTOMIZED_BUMP}
        // Un'etichetta CAMBIATA nel disegnatore è del cliente: le traduzioni spedite non valgono più (#22).
        ${labelTranslationsCypher('t', 'coalesce($label, t.label)')}
        SET t.label          = CASE WHEN $labelGiven      THEN $label      ELSE t.label       END,
            t.trigger        = CASE WHEN $triggerGiven    THEN $trigger    ELSE t.trigger     END,
            t.requires_input = $requiresInput,
            t.input_field    = CASE WHEN $inputFieldGiven THEN $inputField ELSE t.input_field END,
            t.condition      = CASE WHEN $conditionGiven  THEN $condition  ELSE t.condition   END,
            t.timer_hours    = CASE WHEN $timerHoursGiven THEN $timerHours ELSE t.timer_hours END
        // Read by assertManualTransitionsLabelled: the arrow as this write left it.
        RETURN t.id AS id, src.name AS fromStep, endNode(t).name AS toStep,
               (t.trigger = 'manual' AND trim(coalesce(t.label, '')) = '') AS blankManualLabel
      `, {
        transitionId,
        definitionId,
        tenantId: ctx.tenantId,
        ...customizedParams(ctx),
        label:         label         ?? null,
        trigger:       trigger       ?? null,
        requiresInput,
        inputField:    inputField    ?? null,
        condition:     condition     ?? null,
        timerHours:    timerHours    ?? null,
        // M-9: given and null = cleared; absent = left as it is. Not for the
        // label: null leaves it, and an EMPTY label on a manual transition is
        // refused by assertManualTransitionsLabelled (tour of 23 Sep 2026 — the
        // comment here promised it, the code wrote the '').
        labelGiven:      given('label') && label != null,
        triggerGiven:    given('trigger'),
        inputFieldGiven: given('inputField'),
        conditionGiven:  given('condition'),
        timerHoursGiven: given('timerHours'),
      }),
    ))
    // B-26: se la transizione non è di questa definizione non si tocca nulla e
    // lo si dice, invece di restituire la definizione come se fosse cambiata.
    if (!written.records.length) throw new NotFoundError('WorkflowTransition', transitionId)
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
  const resolvedTrigger = assertTransitionTrigger(trigger, `new transition ${fromStepName} → ${toStepName}`) ?? 'manual'
  /*
   * Tour of 23 Sep 2026: a new arrow was created with `label: ''` (what the
   * designer sent) or with a fixed English 'New transition' (when none was
   * sent) — a blank or foreign button on every ticket. The label of a manual
   * transition is the text people click: it is required, as on every save.
   */
  const trimmedLabel = (label ?? '').trim()
  if (resolvedTrigger === 'manual' && !trimmedLabel) {
    throw new GraphQLError(
      `The manual transition «${fromStepName}» → «${toStepName}» needs a label: it is the text of the button people click on the ticket.`,
      { extensions: { code: 'BAD_USER_INPUT', i18n: { key: 'errors.workflow.manualTransitionNeedsLabel', params: { from: fromStepName, to: toStepName } } } },
    )
  }
  return withSession(async (session) => {
    const id = uuidv4()
    const result = await session.executeWrite(async (tx) => {
      /**
       * Due archi IDENTICI (stessa coppia di passi, stesso innesco) non si
       * creano (revisione totale · B-27): il motore ne sceglie uno con
       * `LIMIT 1` senza un ordine dichiarato, quindi con condizioni diverse
       * l'esito della transizione dipenderebbe dal piano di esecuzione. Chi
       * vuole due strade diverse usa due inneschi diversi.
       */
      const dup = await tx.run(`
        MATCH (wd:WorkflowDefinition {id: $definitionId, tenant_id: $tenantId})
        // tenant-ok(traversal): step della definizione appena scopata
        MATCH (from:WorkflowStep {definition_id: $definitionId, name: $fromStepName})
              -[tr:TRANSITIONS_TO {trigger: $trigger}]->
              (:WorkflowStep {definition_id: $definitionId, name: $toStepName})
        RETURN tr.id AS id LIMIT 1
      `, { definitionId, tenantId: ctx.tenantId, fromStepName, toStepName, trigger: resolvedTrigger })
      if (dup.records.length) {
        throw new GraphQLError(`A ${resolvedTrigger} transition from ${fromStepName} to ${toStepName} already exists`, {
          extensions: { code: 'BAD_USER_INPUT', i18n: { key: 'errors.workflow.duplicateTransition', params: { from: fromStepName, to: toStepName, trigger: resolvedTrigger } } },
        })
      }
      return tx.run(`
        MATCH (wd:WorkflowDefinition {id: $definitionId, tenant_id: $tenantId})
        // tenant-ok(traversal): step della definizione appena scopata
        MATCH (from:WorkflowStep {definition_id: $definitionId, name: $fromStepName})
        // tenant-ok(traversal): idem
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
        trigger: resolvedTrigger,
        label: trimmedLabel,
        sourceHandle: sourceHandle ?? null, targetHandle: targetHandle ?? null,
        ...customizedParams(ctx),
      })
    })
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
        // tenant-ok(traversal): step della definizione appena scopata
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
 * A person moves an incident, a problem, a request or an article by hand
 * (changes have their own mutation, with the phase side effects). Every
 * check — the write permission of the type, the approvals, the required
 * fields, the step's metadata — and every step action is the pipeline's
 * (services/ticketTransition.ts, wave 7 · B1): here only who asks, and what
 * the answer looks like on the screen.
 */
export async function executeWorkflowTransition(
  _: unknown,
  { instanceId, toStep, notes }: { instanceId: string; toStep: string; notes?: string },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    // Tenant-isolation guard: the instance must belong to the caller's tenant.
    const typeRow = await session.executeRead((tx) => tx.run(
      `MATCH (wi:WorkflowInstance {id: $instanceId, tenant_id: $tenantId}) RETURN wi.entity_type AS entityType`,
      { instanceId, tenantId: ctx.tenantId },
    ))
    if (typeRow.records.length === 0) {
      throw new GraphQLError(`Workflow instance not found: ${instanceId}`, { extensions: { code: 'NOT_FOUND' } })
    }
    // Le change hanno un gate di approvazione multi-parte e side-effect di
    // fase (task, approvazioni, rischio) che vivono in executeChangeTransition:
    // la mutation generica NON deve poter aggirarli.
    const entityType = typeRow.records[0]!.get('entityType') as string
    if (entityType === 'change') {
      throw new GraphQLError('Changes are transitioned with executeChangeTransition (approval gate and phase side effects)', { extensions: { code: 'CONFLICT', i18n: { key: 'errors.workflow.changeUsesChangeTransition' } } })
    }

    workflowLogger.debug({ toStep, instanceId }, 'Transitioning workflow step')
    const outcome = await transitionTicket(session, {
      tenantId: ctx.tenantId, instanceId, toStep, notes: notes ?? null,
      actor: personActor(ctx), triggerType: 'manual',
    })
    if (!outcome.moved) {
      // A guard refused before the engine: the error on the screen. The engine's
      // own no (the arc, its condition) comes back as the result, as before.
      if (outcome.refusal.guard !== 'workflow' || !outcome.refusal.engine) throw refusalError(outcome.refusal)
      return { success: false, ...transitionErrorFields(outcome.refusal.engine), instance: null, actionErrors: null }
    }
    const result = outcome.result

    // Side-effect post-commit falliti: la transizione è già persistita, quindi
    // NON si lancia (l'utente vedrebbe "fallito" con il workflow avanzato) ma
    // finiscono in actionErrors, come quelli dell'engine.
    const postErrors: string[] = []
    // La NOTA di transizione, l'evento dell'ingresso nel passo, la voce di audit
    // e le notify_rule li scrive l'hook `onStepEntered` (workflow/stepEnteredEvents.ts),
    // che vede ogni cammino; i campi del passo li scrive la pipeline. Per gli
    // articoli resta qui la voce di audit dell'ingresso, che vuole chi l'ha chiesto.
    if (entityType === 'kb_article') {
      try {
        await auditStepEntered(session, ctx, 'kb_article', 'KBArticle', outcome.entityId, toStep)
      } catch (e) {
        workflowLogger.error({ instanceId, toStep, err: e }, '[workflow] post-transition side effect failed — audit step entered')
        postErrors.push(`audit step entered: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    const allActionErrors = [...outcome.actionErrors, ...postErrors]

    return {
      success:      true,
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
      /** Delay of a timed wait, in minutes: absent/null = unchanged (lib/stepTimerDelay.ts). */
      timerDelayMinutes?: number | null
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
    assertStepActions(st.exitActions,  `exit_actions of step "${st.stepName}"`, 'exit')
    const purposeValue = normalizeStepPurpose(st.purpose, `step "${st.stepName}"`)
    const category     = normalizeStepCategory(st.category, `step "${st.stepName}"`)
    const deadline     = normalizeStepDeadlineInput(st.deadline, `deadline of step "${st.stepName}"`)
    const timerDelayMinutes = st.timerDelayMinutes == null ? null : assertTimerDelayMinutes(st.timerDelayMinutes, `step "${st.stepName}"`)
    return {
      ...st, category, purposeGiven: purposeValue !== undefined, purpose: purposeValue ?? null, timerDelayMinutes,
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

      // Update each transition; a manual one left without a label rolls the whole save back.
      if (transitions.length > 0) {
        assertManualTransitionsLabelled(await tx.run(`
          MATCH (wd:WorkflowDefinition {id: $definitionId, tenant_id: $tenantId})
          UNWIND $transitions AS tr
          // tenant-ok(traversal): wd già scopata sopra
          MATCH (src:WorkflowStep {definition_id: wd.id})-[t:TRANSITIONS_TO {id: tr.transitionId}]->()
          // Un'etichetta CAMBIATA nel disegnatore è del cliente: le traduzioni spedite non valgono più (#22).
          ${labelTranslationsCypher('t', 'coalesce(tr.label, t.label)')}
          SET t.label          = coalesce(tr.label, t.label),
              t.trigger        = coalesce(tr.trigger, t.trigger),
              t.requires_input = tr.requiresInput,
              t.input_field    = tr.inputField,
              t.condition      = tr.condition,
              t.timer_hours    = tr.timerHours
          // Read by assertManualTransitionsLabelled: each arrow as this write left it.
          RETURN src.name AS fromStep, endNode(t).name AS toStep,
                 (t.trigger = 'manual' AND trim(coalesce(t.label, '')) = '') AS blankManualLabel
        `, { transitions: transitionRows, definitionId, tenantId: ctx.tenantId }))
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
              s.deadline_calendar_id = CASE WHEN st.deadlineGiven THEN st.deadlineCalendarId ELSE s.deadline_calendar_id END,
              // Only a timed wait has a delay (lib/stepTimerDelay.ts).
              s.timer_delay_minutes = CASE WHEN st.timerDelayMinutes IS NOT NULL AND s.type = 'timer_wait' THEN st.timerDelayMinutes ELSE s.timer_delay_minutes END
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
        if (steps.some((st) => st.isInitial === false)) await assertInitialStepRemains(tx, ctx.tenantId, definitionId)
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

/**
 * DUPLICARE UNA DEFINIZIONE DI WORKFLOW (moduli del catalogo, ondata 3).
 *
 * Perché serve: il motore sa già scegliere l'iter per categoria o per
 * identificativo, ma non c'era modo di CREARE una definizione nuova — si
 * potevano solo modificare quelle seminate. Senza questa mutation «un iter per
 * ogni voce di catalogo» resta una promessa: ogni richiesta segue lo stesso
 * flusso.
 *
 * Come copia, e perché in tre passi:
 *  1. la definizione, con `properties(src)` così nessun campo si perde per
 *     strada quando ne aggiungeremo altri, poi le sovrascritture (id, nome,
 *     categoria, versione, i marchi).
 *  2. i passi, ognuno con un riferimento TEMPORANEO all'originale
 *     (`copied_from`): serve solo a ricostruire le transizioni.
 *  3. le transizioni, cercate fra le coppie di passi copiati grazie a quel
 *     riferimento, e poi il riferimento si cancella — un dato di servizio che
 *     resta nel grafo diventa un dato che qualcuno legge per sbaglio.
 *
 * La copia nasce SPENTA e marcata come personalizzata: spenta perché una
 * definizione attiva senza categoria entrerebbe subito nella scelta di ogni
 * ticket nuovo di quel tipo (il ripiego «senza categoria»), e nessuno se lo
 * aspetta da un «duplica»; personalizzata perché il seed di fabbrica non deve
 * mai sovrascriverla.
 */
export async function duplicateWorkflowDefinition(
  _: unknown,
  args: { definitionId: string; name: string; category?: string | null; catalogOnly?: boolean | null },
  ctx: GraphQLContext,
) {
  requirePermission(ctx, 'config.workflow')
  const nome = args.name.trim()
  if (nome === '') {
    throw new ValidationError('The copy needs a name.', { key: 'errors.workflow.copyNameRequired', params: {} })
  }
  const categoria = args.category == null || args.category.trim() === '' ? null : args.category.trim()
  const nuovoId = uuidv4()
  const now = new Date().toISOString()

  return withSession(async (session) => {
    const creata = await session.executeWrite(async (tx) => {
      const sorgente = await tx.run(`
        MATCH (src:WorkflowDefinition {id: $definitionId, tenant_id: $tenantId})
        RETURN src.entity_type AS entityType, src.name AS name`,
      { definitionId: args.definitionId, tenantId: ctx.tenantId })
      const srcRec = sorgente.records[0]
      if (!srcRec) throw new NotFoundError('WorkflowDefinition', args.definitionId)
      const entityType = srcRec.get('entityType') as string

      // Il nome identifica una definizione per (tenant, tipo): `seedWorkflowDefinition`
      // cerca proprio così, e due omonime renderebbero il seed imprevedibile.
      const omonima = await tx.run(`
        MATCH (wd:WorkflowDefinition {tenant_id: $tenantId, entity_type: $entityType, name: $name})
        RETURN wd.id AS id LIMIT 1`, { tenantId: ctx.tenantId, entityType, name: nome })
      if (omonima.records.length > 0) {
        throw new ValidationError(`A ${entityType} workflow called "${nome}" already exists.`,
          { key: 'errors.workflow.copyNameTaken', params: { name: nome, entityType } })
      }

      /**
       * La copia si scrive con una PROIEZIONE DI MAPPA (`src { .*, id: … }`),
       * non con `SET dst = properties(src)` seguito dalle sovrascritture: quella
       * forma scrive prima l'id ORIGINALE, e il vincolo di unicità su
       * `WorkflowDefinition.id` scatta lì — non al commit. Il primo giro nel
       * browser è finito esattamente così, con «Node already exists with
       * property id». Qui le sovrascritture sono dentro la stessa SET, quindi
       * il nodo nasce già con il suo id.
       */
      await tx.run(`
        MATCH (src:WorkflowDefinition {id: $definitionId, tenant_id: $tenantId})
        CREATE (dst:WorkflowDefinition)
        SET dst = src {
          .*,
          id: $newId,
          name: $name,
          category: $category,
          version: 1,
          active: false,
          created_at: $now,
          updated_at: $now,
          customized_at: $now,
          customized_by: $userId,
          copied_from_id: $definitionId,
          catalog_only: $catalogOnly
        }`,
      { definitionId: args.definitionId, tenantId: ctx.tenantId, newId: nuovoId, name: nome, category: categoria, now, userId: ctx.userId,
        catalogOnly: args.catalogOnly === true })

      await tx.run(`
        MATCH (src:WorkflowDefinition {id: $definitionId, tenant_id: $tenantId})-[:HAS_STEP]->(s:WorkflowStep)
        MATCH (dst:WorkflowDefinition {id: $newId, tenant_id: $tenantId})
        CREATE (ns:WorkflowStep)
        SET ns = s {
          .*,
          id: randomUUID(),
          definition_id: $newId,
          tenant_id: $tenantId,
          copied_from: s.id
        }
        CREATE (dst)-[:HAS_STEP]->(ns)`,
      { definitionId: args.definitionId, tenantId: ctx.tenantId, newId: nuovoId })

      // I passi copiati sono limitati al tenant come tutto il resto: il
      // `definition_id` basterebbe (è un uuid appena creato), ma una query di
      // dominio senza `tenant_id` è una query che un domani qualcuno riusa
      // altrove — e lì l'uuid non sarebbe più appena creato.
      await tx.run(`
        MATCH (a:WorkflowStep {definition_id: $newId, tenant_id: $tenantId})
        MATCH (b:WorkflowStep {definition_id: $newId, tenant_id: $tenantId})
        MATCH (oa:WorkflowStep {id: a.copied_from, tenant_id: $tenantId})-[t:TRANSITIONS_TO]->(ob:WorkflowStep {id: b.copied_from, tenant_id: $tenantId})
        CREATE (a)-[nt:TRANSITIONS_TO]->(b)
        SET nt = properties(t)`,
      { newId: nuovoId, tenantId: ctx.tenantId })

      // Il riferimento temporaneo se ne va: ha finito il suo lavoro.
      await tx.run(`
        MATCH (s:WorkflowStep {definition_id: $newId, tenant_id: $tenantId})
        REMOVE s.copied_from`, { newId: nuovoId, tenantId: ctx.tenantId })

      const dst = await tx.run(`
        MATCH (wd:WorkflowDefinition {id: $newId, tenant_id: $tenantId})
        OPTIONAL MATCH (wd)-[:HAS_STEP]->(s:WorkflowStep)
        RETURN properties(wd) AS props, collect(s) AS steps`, { newId: nuovoId, tenantId: ctx.tenantId })
      const rec = dst.records[0]!
      return {
        props: rec.get('props') as Record<string, unknown>,
        steps: (rec.get('steps') ?? []) as Array<{ properties: Record<string, unknown> }>,
        entityType,
      }
    })

    invalidateWorkflowCache(ctx.tenantId, creata.entityType)
    void audit(ctx, 'workflow.duplicated', 'WorkflowDefinition', nuovoId, {
      copiedFrom: args.definitionId, name: nome, category: categoria,
    })
    const transizioni = await loadTransitionRows(session, nuovoId, ctx.tenantId)
    return mapWorkflowDefinition(creata.props, creata.steps, transizioni)
  }, true)
}

/**
 * ACCENDERE O SPEGNERE una definizione (moduli del catalogo, ondata 3).
 *
 * Senza questa, `duplicateWorkflowDefinition` era un vicolo cieco: la copia
 * nasce spenta — di proposito, perché una definizione attiva senza categoria
 * entra subito nel ripiego di ogni ticket nuovo di quel tipo — e non c'era
 * modo di metterla in servizio.
 *
 * Spegnere NON tocca le istanze già create: un ticket a metà del suo iter
 * resta dov'è. Toglie solo la definizione dalla SCELTA dei ticket nuovi, ed è
 * il motivo per cui si può spegnere senza paura.
 *
 * Una cosa la si rifiuta: spegnere l'ULTIMA definizione attiva di un tipo
 * senza categoria. Dopo quella non nasce più nessun ticket di quel tipo, e il
 * messaggio arriverebbe a chi apre un incident invece che a chi ha configurato.
 */
export async function setWorkflowDefinitionActive(
  _: unknown,
  args: { definitionId: string; active: boolean },
  ctx: GraphQLContext,
) {
  requirePermission(ctx, 'config.workflow')
  return withSession(async (session) => {
    const aggiornata = await session.executeWrite(async (tx) => {
      const trovata = await tx.run(`
        MATCH (wd:WorkflowDefinition {id: $definitionId, tenant_id: $tenantId})
        RETURN wd.entity_type AS entityType, wd.name AS name, wd.category AS category, wd.active AS active`,
      { definitionId: args.definitionId, tenantId: ctx.tenantId })
      const rec = trovata.records[0]
      if (!rec) throw new NotFoundError('WorkflowDefinition', args.definitionId)
      const entityType = rec.get('entityType') as string
      const categoria = (rec.get('category') ?? null) as string | null

      if (!args.active && categoria == null) {
        const altre = await tx.run(`
          MATCH (wd:WorkflowDefinition {tenant_id: $tenantId, entity_type: $entityType, active: true})
          WHERE wd.id <> $definitionId AND wd.category IS NULL
          RETURN count(wd) AS n`, { tenantId: ctx.tenantId, entityType, definitionId: args.definitionId })
        if (Number(altre.records[0]?.get('n') ?? 0) === 0) {
          throw new ValidationError(
            `"${rec.get('name') as string}" is the last active ${entityType} workflow without a category: switching it off would stop every new ${entityType} from being created. Activate another one first.`,
            { key: 'errors.workflow.lastActiveDefinition', params: { name: rec.get('name') as string, entityType } },
          )
        }
      }

      // A catalog item that names this workflow creates its requests with it
      // (review of 23 Sep 2026): switched off, every request of that item
      // failed at creation with «No active workflow definition». The items
      // are named, so the admin knows what to change first.
      if (!args.active) {
        const voci = await tx.run(`
          MATCH (i:ServiceCatalogItem {tenant_id: $tenantId, workflow_definition_id: $definitionId})
          WHERE coalesce(i.active, true) = true
          RETURN i.name AS name ORDER BY name LIMIT 10`, { tenantId: ctx.tenantId, definitionId: args.definitionId })
        const nomi = voci.records.map((r) => String(r.get('name')))
        if (nomi.length > 0) {
          throw new ValidationError(
            `"${rec.get('name') as string}" is the workflow of catalog items (${nomi.join(', ')}): switching it off would stop their requests from being created. Give them another workflow first.`,
            { key: 'errors.workflow.usedByCatalogItems', params: { name: rec.get('name') as string, items: nomi.join(', ') } },
          )
        }
      }

      // `WITH` fra SET e MATCH: Cypher lo pretende, e senza si prende un
      // «WITH is required between SET and MATCH» a runtime — che i test con il
      // driver mockato non vedono. Trovato premendo l'interruttore nel browser.
      const scritta = await tx.run(`
        MATCH (wd:WorkflowDefinition {id: $definitionId, tenant_id: $tenantId})
        SET wd.active = $active, wd.updated_at = $now
        WITH wd
        OPTIONAL MATCH (wd)-[:HAS_STEP]->(s:WorkflowStep)
        RETURN properties(wd) AS props, collect(s) AS steps`,
      { definitionId: args.definitionId, tenantId: ctx.tenantId, active: args.active, now: new Date().toISOString() })
      const out = scritta.records[0]!
      return {
        props: out.get('props') as Record<string, unknown>,
        steps: (out.get('steps') ?? []) as Array<{ properties: Record<string, unknown> }>,
        entityType,
      }
    })

    invalidateWorkflowCache(ctx.tenantId, aggiornata.entityType)
    void audit(ctx, args.active ? 'workflow.activated' : 'workflow.deactivated', 'WorkflowDefinition', args.definitionId)
    const transizioni = await loadTransitionRows(session, args.definitionId, ctx.tenantId)
    return mapWorkflowDefinition(aggiornata.props, aggiornata.steps, transizioni)
  }, true)
}
