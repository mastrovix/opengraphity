/**
 * IL VARCO DELLA FINESTRA DI RILASCIO, in un posto solo.
 *
 * Terza revisione · C1. Il varco esisteva, era giusto, ed era documentato con
 * la frase «una change non pre-approvata che entra lì deve avere le sue
 * approvazioni soddisfatte, **da qualunque passo arrivi e qualunque scopo
 * abbia quel passo**». Quella frase era vera per UN cammino di codice su tre:
 * viveva dentro `executeChangeTransition`, e in `autoTransitions.ts` le
 * occorrenze di `isPreApprovedChangeType`, `assertAllApprovalsSatisfied`,
 * `entersWindow`, `requireRole` e `CHANGE_WINDOW_PURPOSES` erano ZERO.
 *
 * Dal vivo: l'admin aggiunge nel disegnatore un arco `assessment → scheduled`
 * con innesco `automatic` e nessuna condizione — due tendine che l'ondata 2 ha
 * appena reso vocabolari chiusi e quindi invitanti — un operatore chiude
 * l'ultimo assessment task, e la change `normal` finisce in `scheduled` con
 * zero approvazioni, accendendo la soppressione degli allarmi. Nessun errore,
 * nessun log: il log diceva `info`.
 *
 * Da qui in avanti la regola di dominio sta SOLO qui, e i tre cammini la
 * chiamano. Il lint `changeWindowGate.test.ts` pretende che ogni
 * `workflowEngine.transition` su un'istanza di change passi da una di queste
 * due funzioni: aggiungere un quarto cammino senza il varco fa fallire i test.
 *
 * PERCHÉ DUE FUNZIONI E NON UNA. Su un cammino manuale c'è un umano che ha
 * premuto un bottone: il varco LANCIA, e il messaggio nomina le uscite. Su un
 * cammino automatico non c'è nessun umano — `requireRole` non ha senso, e
 * lanciare farebbe fallire l'azione legittima di un operatore (chiudere un
 * assessment task) per colpa di una configurazione che non è sua: sarebbe un
 * vicolo cieco nuovo, cioè l'errore che l'ondata 5 esisteva per togliere. Lì
 * la transizione viene RIFIUTATA: la change resta dov'è, il rifiuto va a
 * `warn` con il contatore `change_window_gate_blocked_total`. Non è un
 * fallback silenzioso — è un rifiuto osservabile.
 */
import { GraphQLError } from 'graphql'
import { CHANGE_WINDOW_PURPOSES } from '@opengraphity/types'
import type { Session } from 'neo4j-driver'
import { logger } from '../../../lib/logger.js'
import { requirePermission } from '../../../lib/permissions.js'
import { isPreApprovedChangeType } from '../../../lib/changePolicy.js'
import { getStepPurpose, getStepNamesByPurpose } from '../../../lib/workflowHelpers.js'
import { assertAllApprovalsSatisfied, areAllApprovalsSatisfied } from './approvalCreation.js'
import { areAllAssessmentsComplete } from '../../../lib/changeAssessments.js'
import { changeWindowGateBlockedTotal } from '../../../middleware/metrics.js'
import type { GraphQLContext } from '../../../context.js'

/** Chi sta attraversando il varco: serve solo per l'etichetta del contatore e del log. */
export type GatePath = 'auto_transition' | 'timer_job' | 'rule_action' | 'sla_breach' | 'step_deadline'

export interface ChangeGateInput {
  tenantId:   string
  changeId:   string
  /** Il tipo della change (`change_type`), non il letterale `standard`. */
  changeType: string
  currentStep: string
  toStep:      string
}

/**
 * Cosa dice la regola di dominio su questa transizione, prima di sapere chi la
 * sta chiedendo.
 *
 *  - `open`                → nessun varco in gioco, o change pre-approvata.
 *  - `use_reject_mutation` → si sta uscendo dall'approvazione verso l'analisi:
 *                            deve passare da `rejectChangeApproval`, che riapre
 *                            gli assessment.
 *  - `needs_approvals`     → il varco è in gioco: servono i requisiti soddisfatti.
 *  - `no_approval_step`    → il varco è in gioco e il cliente non ha NESSUN passo
 *                            di scopo `approval`: non esiste un posto dove approvare.
 *  - `needs_assessments`   → si esce dall'analisi con valutazioni o piano di
 *                            deploy ancora aperti. Vale per OGNI tipo, anche
 *                            pre-approvato: dopo l'analisi il piano non si
 *                            modifica più, e una change uscita senza piano
 *                            restava ferma per sempre (giro del 14 set 2026:
 *                            CHG00000003, standard, da un arco
 *                            `assessment → scheduled` automatico e senza condizione).
 */
export type ChangeGateOutcome =
  | { kind: 'open' }
  | { kind: 'needs_assessments' }
  | { kind: 'use_reject_mutation' }
  | { kind: 'needs_approvals' }
  | { kind: 'no_approval_step' }

/**
 * La regola di dominio, senza attori. Legge gli SCOPI dei due passi (non i
 * nomi: con un passo «CAB settimanale» il varco sui nomi non scattava) e
 * legge i tipi pre-approvati solo quando un varco è davvero in gioco, per non
 * aggiungere una lettura a ogni transizione di ogni workflow.
 */
export async function changeGateOutcome(session: Session, input: ChangeGateInput): Promise<ChangeGateOutcome> {
  const [currentPurpose, targetPurpose] = await Promise.all([
    getStepPurpose(session, input.tenantId, 'change', input.currentStep),
    getStepPurpose(session, input.tenantId, 'change', input.toStep),
  ])

  // Uscire dall'analisi (verso qualunque passo, per qualunque tipo) chiede
  // valutazioni e piano completi. Il ritorno all'analisi resta libero.
  if (currentPurpose === 'assessment' && targetPurpose !== 'assessment'
      && !(await areAllAssessmentsComplete(session, input.changeId, input.tenantId))) {
    return { kind: 'needs_assessments' }
  }

  const entersWindow = targetPurpose != null && (CHANGE_WINDOW_PURPOSES as readonly string[]).includes(targetPurpose)
  const leavesApproval = currentPurpose === 'approval' && targetPurpose !== 'approval'
  if (!leavesApproval && !entersWindow) return { kind: 'open' }

  if (await isPreApprovedChangeType(input.tenantId, input.changeType)) return { kind: 'open' }

  if (leavesApproval && targetPurpose === 'assessment') return { kind: 'use_reject_mutation' }
  if (leavesApproval) return { kind: 'needs_approvals' }

  // Entra nella finestra da un passo che non è quello di approvazione: se il
  // cliente non ha nessun passo di approvazione, rifiutare senza dire dove si
  // approva sarebbe un vicolo cieco.
  const approvalSteps = await getStepNamesByPurpose(session, input.tenantId, 'change', ['approval'])
  return approvalSteps.length === 0 ? { kind: 'no_approval_step' } : { kind: 'needs_approvals' }
}

/**
 * Il varco sul cammino MANUALE: lancia. Conserva parola per parola i messaggi
 * che l'ondata 2 aveva scritto, comprese le due uscite nominate.
 */
export async function assertChangeWindowGate(
  session: Session, ctx: GraphQLContext, input: ChangeGateInput,
): Promise<void> {
  const outcome = await changeGateOutcome(session, input)
  switch (outcome.kind) {
    case 'open':
      return
    case 'needs_assessments':
      throw new GraphQLError(
        'The change cannot leave the assessment: complete every assessment task and the deploy plan first '
        + '(after the assessment the plan can no longer be edited).',
        { extensions: { code: 'CONFLICT', i18n: { key: 'errors.change.assessmentsIncomplete' } } },
      )
    case 'use_reject_mutation':
      throw new GraphQLError(
        'To reject, use "Reject" in the Approval section (rejectChangeApproval), which reopens the assessments',
        { extensions: { code: 'CONFLICT', i18n: { key: 'errors.change.rejectViaApproval' } } },
      )
    case 'no_approval_step':
      throw new GraphQLError(
        `The change is of type "${input.changeType}", which is not among the pre-approved types, and in the change `
        + `workflow no step declares the «Approval» purpose: there is no place to approve it, so it cannot `
        + `enter the release window. Give the «Approval» purpose to the step where approval happens `
        + `(workflow designer), or add "${input.changeType}" to the pre-approved types `
        + `(Settings → Domain matrices).`,
        { extensions: { code: 'CONFLICT', i18n: { key: 'errors.window.noApprovalStep', params: { type: input.changeType } } } },
      )
    case 'needs_approvals':
      requirePermission(ctx, 'approval.override')
      await assertAllApprovalsSatisfied(session, input.changeId, input.tenantId)
      return
  }
}

/**
 * Il varco sui cammini AUTOMATICI: non lancia, risponde sì o no.
 *
 * `true` quando la transizione può partire. `false` quando il varco è in gioco
 * e i requisiti non sono soddisfatti: chi chiama NON deve transire, e il
 * rifiuto è già stato scritto a `warn` e contato qui.
 */
export async function automaticTransitionAllowed(
  session: Session, input: ChangeGateInput, path: GatePath,
): Promise<boolean> {
  const outcome = await changeGateOutcome(session, input)
  if (outcome.kind === 'open') return true

  // `areAllApprovalsSatisfied` è la stessa regola di `assertAllApprovalsSatisfied`
  // in forma booleana: è il pezzo che l'auto-advance legittimo usa già quando
  // l'ultima approvazione arriva e la change deve uscire da sola
  // dall'approvazione. Quel cammino continua a funzionare identico.
  // `areAllApprovalsSatisfied` LANCIA se la change non esiste piu (cancellata
  // mentre il cammino automatico era in volo). Questa funzione promette di non
  // lanciare, e la direzione sicura e rifiutare: trovato eseguendo la verifica
  // dal vivo, dove un changeId inesistente faceva uscire un NOT_FOUND da una
  // funzione che dichiara di rispondere si o no.
  let satisfied = false
  if (outcome.kind === 'needs_approvals') {
    try {
      satisfied = await areAllApprovalsSatisfied(session, input.changeId, input.tenantId)
    } catch (e) {
      logger.warn(
        { changeId: input.changeId, tenantId: input.tenantId, err: e },
        '[change-gate] impossibile leggere i requisiti di approvazione: la transizione automatica viene rifiutata',
      )
    }
  }
  if (satisfied) return true

  changeWindowGateBlockedTotal.inc({ path, reason: outcome.kind })
  logger.warn(
    {
      changeId: input.changeId, changeType: input.changeType,
      from: input.currentStep, to: input.toStep, reason: outcome.kind, path,
    },
    outcome.kind === 'needs_assessments'
      ? '[change-gate] transizione automatica rifiutata: la change uscirebbe dall\'analisi con valutazioni o piano di deploy aperti'
      : '[change-gate] transizione automatica rifiutata: la change entrerebbe nella finestra di rilascio senza approvazioni',
  )
  return false
}

/**
 * Come sopra, ma LANCIA invece di rispondere `false`.
 *
 * Serve all'esecutore delle azioni (`lib/actionExecutor.ts`, azione
 * `transition_workflow`): la cosa mal configurata e la REGOLA, non l'azione di
 * un operatore, e in quel file un'azione che non riesce e gia un errore che
 * finisce nel risultato della regola (`matched + error`) e nei log. Fermarla
 * in silenzio la farebbe risultare eseguita, che e il difetto B-18 che quel
 * file ha appena finito di correggere per il caso gemello.
 */
export async function assertAutomaticTransitionAllowed(
  session: Session, input: ChangeGateInput, path: GatePath,
): Promise<void> {
  if (await automaticTransitionAllowed(session, input, path)) return
  const outcome = await changeGateOutcome(session, input)
  if (outcome.kind === 'needs_assessments') {
    throw new Error(
      `Change "${input.changeId}" (type "${input.changeType}") cannot move from "${input.currentStep}" to `
      + `"${input.toStep}": its assessment tasks or deploy plan are not complete yet. Remove this action from the `
      + `rule, or let it run only after the assessment.`,
    )
  }
  throw new Error(
    `Change "${input.changeId}" (type "${input.changeType}") cannot move from "${input.currentStep}" to `
    + `"${input.toStep}": it would enter the release window without its approvals being satisfied. `
    + `If this move must be automatic, add "${input.changeType}" to the pre-approved types `
    + `(Settings -> Domain matrices); otherwise remove this action from the rule.`,
  )
}

