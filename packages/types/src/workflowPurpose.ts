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

// ── La CATEGORIA del passo (revisione delle otto ondate · B·N-3) ─────────────

/**
 * Come il ticket si vede **da fuori** mentre sta in questo passo: è la classe
 * di stato che liste, portale, contatori e filtri usano.
 *
 * ## Perché è diventata un vocabolario chiuso
 * L'ondata 4 ha dato allo *scopo* un vocabolario chiuso, una tendina e una
 * validazione in scrittura. La *categoria* è rimasta un campo di testo con una
 * `datalist` di **suggerimenti** — e nel frattempo l'ondata 8 le ha fatto
 * decidere cose vere: «risolto» (`engine.ts`, che valorizza `resolved_at` e
 * `root_cause`), la chiusura automatica, l'escalation, le classi di stato.
 *
 * Dal vivo, nella revisione: un'interfaccia in italiano che invita a scrivere
 * una parola inglese è la trappola perfetta. Con `category = 'risolto'` la
 * transizione **riesce**, e `resolved_at` e `root_cause` restano NULL: il
 * ticket risulta risolto per l'utente e mai risolto per i dati — nei report,
 * negli SLA, nel post-incident.
 *
 * ## Le voci, e perché sono queste
 * Sono esattamente quelle che il prodotto usa: quelle scritte dai seed e
 * quelle presenti dal vivo su tutti i workflow di tutti i tenant (verificato
 * prima di chiudere il vocabolario: `active`, `waiting`, `escalated`,
 * `resolved`, `closed`, `draft`, `published`, `failed`). Nessuna voce nuova,
 * nessuna migrazione: chiudere questo vocabolario non cambia un solo dato.
 *
 * Non c'è sovrapposizione con lo scopo: un passo di approvazione e uno di
 * implementazione sono entrambi `active` (lo dice il commento in testa a
 * questo file), e sono scopi diversi.
 */
export const WORKFLOW_STEP_CATEGORIES = [
  /** Il ticket è in lavorazione: il caso normale di un passo intermedio. */
  'active',
  /** In attesa di qualcosa fuori dal controllo di chi lavora (un fornitore, l'utente). */
  'waiting',
  /** Escalato: `escalateIncident` porta il ticket al passo di questa categoria. */
  'escalated',
  /** Risolto: il motore valorizza `resolved_at` e `root_cause` entrando qui. */
  'resolved',
  /** Chiuso: la chiusura automatica porta il ticket al passo di questa categoria. */
  'closed',
  /** Bozza (articoli della base di conoscenza). */
  'draft',
  /** Pubblicato (articoli della base di conoscenza). */
  'published',
  /** Finito male: annullato, rifiutato, non riuscito. */
  'failed',
] as const

export type WorkflowStepCategory = (typeof WORKFLOW_STEP_CATEGORIES)[number]

export function isWorkflowStepCategory(value: unknown): value is WorkflowStepCategory {
  return typeof value === 'string' && (WORKFLOW_STEP_CATEGORIES as readonly string[]).includes(value)
}

// ── Transizioni: innesco e condizione (revisione · B·M-4) ───────────────────

/**
 * Chi percorre l'arco.
 *
 * Era un campo libero lato API con una tendina lato web: una stringa inventata
 * entrava nel grafo e l'arco non veniva percorso da nessuno, in silenzio.
 *
 *  - `manual` — una persona, dal ticket;
 *  - `automatic` — il motore, quando la condizione è soddisfatta (e il job
 *    `timer_wait` per concludere un'attesa);
 *  - `timer` — come `automatic`, ma dice che è un tempo a farlo scattare: il
 *    job `timer_wait` percorre entrambi (era l'unica scelta della tendina che
 *    non faceva niente, ed è quella che un amministratore sceglie per primo);
 *  - `sla_breach` — lo sfondamento di uno SLA (consumatore dell'escalation).
 */
export const WORKFLOW_TRANSITION_TRIGGERS = ['manual', 'automatic', 'timer', 'sla_breach'] as const

export type WorkflowTransitionTrigger = (typeof WORKFLOW_TRANSITION_TRIGGERS)[number]

export function isWorkflowTransitionTrigger(value: unknown): value is WorkflowTransitionTrigger {
  return typeof value === 'string' && (WORKFLOW_TRANSITION_TRIGGERS as readonly string[]).includes(value)
}

/**
 * Le condizioni che il motore sa valutare: un **registro chiuso**, perché
 * ognuna è una funzione scritta nel codice (`apps/api/src/workflow/conditions.ts`,
 * più `rootCause != null` registrata dal motore stesso).
 *
 * Il difetto (B·M-4): il pannello del disegnatore offriva un campo di testo con
 * un segnaposto. Un refuso — `all_assessment_complete` invece di
 * `all_assessments_complete` — si salvava senza un fiato e trasformava quell'arco
 * in un **muro**: il motore risponde «Condizione di transizione sconosciuta» a
 * ogni tentativo, e il ticket non si muove più. È lo schema che l'ondata 2 ha
 * chiuso per le *azioni* di passo e l'ondata 4 per lo *scopo*.
 *
 * Chi aggiunge un evaluator aggiunge il nome qui: il test
 * `workflow/__tests__/conditions.test.ts` verifica che registro ed elenco
 * coincidano, quindi non possono divergere.
 */
export const WORKFLOW_TRANSITION_CONDITIONS = [
  'has_linked_change',
  'all_assessments_complete',
  'all_deployments_complete',
  'all_reviews_confirmed',
  'rootCause != null',
] as const

export type WorkflowTransitionCondition = (typeof WORKFLOW_TRANSITION_CONDITIONS)[number]

export function isWorkflowTransitionCondition(value: unknown): value is WorkflowTransitionCondition {
  return typeof value === 'string' && (WORKFLOW_TRANSITION_CONDITIONS as readonly string[]).includes(value)
}
