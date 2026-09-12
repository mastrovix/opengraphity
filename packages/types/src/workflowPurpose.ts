/**
 * Lo SCOPO di un passo di workflow: cosa succede in quel passo, in un
 * vocabolario chiuso e indipendente dal nome che il cliente gli dà.
 *
 * ## Il difetto che questo vocabolario chiude (B-4 / C-9 / D-22)
 * Il codice riconosce i passi delle change e dei problem dal NOME: la finestra
 * di soppressione degli allarmi cerca `'deployment'` e `'scheduled'`, il varco
 * delle approvazioni cerca `'approval'`, la sincronizzazione con i problem
 * cerca `'change_requested'`. Quindi: un cliente che inserisce un passo «CAB»
 * fra `approval` e `scheduled` rende impossibile approvare; uno che rinomina
 * `deployment` non silenzia più gli allarmi durante il rilascio e apre incident
 * falsi, **senza un errore**.
 *
 * ## Scopo e categoria sono due cose diverse, e servono entrambe
 * - `category` (già esistente: active | waiting | escalated | resolved |
 *   closed | draft | published | failed) dice **come il ticket si vede da
 *   fuori**: liste, portale, contatori. Gli incident la usano già e reggono
 *   alla rinomina.
 * - `purpose` (questo file) dice **che ruolo ha il passo nel processo**: è
 *   quello che il motore e le guardie devono riconoscere per decidere, e che
 *   la categoria non può esprimere (un passo di approvazione e uno di
 *   implementazione sono entrambi `active`).
 *
 * Non c'è sovrapposizione: dove basta la categoria si usa la categoria.
 *
 * ## Perché «purpose» e non «ruolo» o «fase»
 * «Ruolo», in ITSM, è della persona. `type`, `category`, `scope` e `phase`
 * sono già occupati nel modello (`WorkflowStep.type`, `.category`,
 * `CITypeDefinition.scope`, `ci_phase` delle change).
 */

/** Vocabolario chiuso. Ogni voce esiste perché un ramo di codice la riconosce. */
export const WORKFLOW_STEP_PURPOSES = [
  /** Valutazione dell'impatto e del rischio (change: era `assessment`). */
  'assessment',
  /** Pianificazione del rilascio (change: era `planning`). */
  'planning',
  /** Raccolta delle approvazioni: qui nascono i requisiti di approvazione (era `approval`). */
  'approval',
  /** Approvata e messa in calendario: la finestra è programmata ma non aperta (era `scheduled`). */
  'scheduled',
  /** Il rilascio è in corso: è la finestra in cui gli allarmi si silenziano (era `deployment`). */
  'implementation',
  /** Verifica dell'esito del rilascio (nessun passo di fabbrica: disponibile al cliente). */
  'validation',
  /** Revisione a posteriori (era `review`). */
  'review',
  /** Presa in carico iniziale e smistamento (era `triage`). */
  'triage',
  /** Analisi della causa radice di un problem (era `under_investigation`). */
  'investigation',
  /** Il problem aspetta una change (era `change_requested`). */
  'change_requested',
  /** La change del problem è in corso (era `change_in_progress`). */
  'change_in_progress',
] as const

export type WorkflowStepPurpose = (typeof WORKFLOW_STEP_PURPOSES)[number]

export function isWorkflowStepPurpose(value: unknown): value is WorkflowStepPurpose {
  return typeof value === 'string' && (WORKFLOW_STEP_PURPOSES as readonly string[]).includes(value)
}

/**
 * I passi della finestra di manutenzione: dentro questi la soppressione degli
 * allarmi e la manutenzione dei servizi sono attive. `scheduled` è la finestra
 * programmata, `implementation` quella aperta — la distinzione serve a
 * `changeIsInWindow`, che tratta diversamente le due.
 */
export const CHANGE_WINDOW_PURPOSES: readonly WorkflowStepPurpose[] = ['scheduled', 'implementation']

/**
 * Nome di fabbrica → scopo. **Serve a una cosa sola**: la migrazione che
 * assegna lo scopo ai passi già esistenti, e il seed che nasce già con lo
 * scopo scritto. Il codice di produzione NON deve leggere questa mappa: se lo
 * facesse, tornerebbe a riconoscere i passi dal nome, che è il difetto.
 */
export const FACTORY_STEP_PURPOSES: Readonly<Record<string, WorkflowStepPurpose>> = {
  assessment:         'assessment',
  planning:           'planning',
  approval:           'approval',
  scheduled:          'scheduled',
  deployment:         'implementation',
  review:             'review',
  triage:             'triage',
  security_review:    'review',
  under_investigation: 'investigation',
  change_requested:   'change_requested',
  change_in_progress: 'change_in_progress',
}
