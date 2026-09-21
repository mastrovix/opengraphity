/**
 * LE PROPOSTE DI MIGLIORAMENTO — il vocabolario condiviso (20 set 2026).
 *
 * Programma «Miglioramento continuo», ondata 1: la SPINA. Un nodo che dura,
 * una pagina dove si accetta o si rifiuta, un catalogo chiuso di azioni.
 * Senza AI: le prime proposte le scrive la diagnostica, che è codice
 * deterministico, così la spina si prova per intero prima che un modello
 * entri nel mezzo.
 *
 * ## Perché il titolo NON è una frase
 * Una proposta porta `kind` + `params`, mai prosa, esattamente come
 * `ConfigurationIssue` e come `:Anomaly`. Il motivo sta scritto in testa a
 * `configurationIssues.ts`: l'API non sa in che lingua guarda chi legge. Una
 * frase congelata nel grafo si legge in italiano a un admin che ha scelto
 * l'inglese dal proprio Profilo — il difetto misurato in un browser il 14
 * settembre e corretto. La frase la compone il client.
 *
 * L'unica prosa ammessa è il `rationale` di un analista AI (ondate 4 e 5), e
 * porterà con sé la lingua in cui è stata scritta.
 *
 * ## Perché le aree hanno un nome e non un numero
 * Revisione del 20 set: «area 4» e «ondata 4» erano due cose diverse con lo
 * stesso numero, e ci si inciampava. Le aree hanno un nome.
 */

/** Chi ha scritto la proposta. Non è una categoria che l'admin debba capire: è un filtro. */
export const PROPOSAL_AREAS = ['configuration', 'daily_work', 'operator', 'platform'] as const
export type ProposalArea = (typeof PROPOSAL_AREAS)[number]

export function isProposalArea(v: unknown): v is ProposalArea {
  return typeof v === 'string' && (PROPOSAL_AREAS as readonly string[]).includes(v)
}

/**
 * Il ciclo di vita.
 *
 * `not_now` esiste perché è il caso vero di tutti i giorni: senza, chi vuole
 * rimandare è costretto a rifiutare, e il rifiuto zittisce l'impronta.
 * `expired` esiste perché una proposta aperta e mai letta occuperebbe uno
 * slot del tetto per sempre: cinque proposte ignorate e il prodotto smette di
 * proporre in silenzio, in un modo indistinguibile dal funzionare.
 */
export const PROPOSAL_STATUSES = ['open', 'accepted', 'rejected', 'not_now', 'expired', 'superseded'] as const
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number]

export function isProposalStatus(v: unknown): v is ProposalStatus {
  return typeof v === 'string' && (PROPOSAL_STATUSES as readonly string[]).includes(v)
}

/** Gli stati che occupano uno slot del tetto. */
export const PROPOSAL_OPEN_STATUSES: readonly ProposalStatus[] = ['open', 'not_now']

/**
 * PERCHÉ È STATA RIFIUTATA — e non è una sfumatura.
 *
 * «Hai sbagliato analisi» e «hai ragione ma non lo faccio» sono due
 * informazioni completamente diverse per chi legge il mese dopo, e per la
 * misura di qualità dell'analista: solo la prima dice che l'analista ha
 * prodotto rumore.
 */
export const PROPOSAL_REJECTION_KINDS = ['wrong_analysis', 'valid_but_declined'] as const
export type ProposalRejectionKind = (typeof PROPOSAL_REJECTION_KINDS)[number]

export function isProposalRejectionKind(v: unknown): v is ProposalRejectionKind {
  return typeof v === 'string' && (PROPOSAL_REJECTION_KINDS as readonly string[]).includes(v)
}

/** Una nota di rifiuto più corta di così non dice niente a chi la rilegge. */
export const PROPOSAL_REJECTION_NOTE_MIN = 10
export const PROPOSAL_REJECTION_NOTE_MAX = 2000

/**
 * IL CATALOGO CHIUSO DELLE AZIONI.
 *
 * Una proposta accettata non esegue «quello che ha scritto il modello»:
 * esegue una voce di questo elenco, con parametri tipizzati e validati dal
 * server. Stesso PRINCIPIO delle automazioni (`actionExecutor.ts`), ma
 * esecutore nuovo: le azioni di quel file scrivono tutte su un ticket, e
 * nessuna tocca la configurazione.
 *
 * L'ondata 1 ne porta UNA sola, e non è un ripiego: è l'unica che si chiude
 * in modo deterministico e totalmente reversibile, e serve a provare il
 * cammino accetta → esegui → disfa per intero. Il resto del catalogo entra
 * quando c'è l'analista che lo usa.
 *
 * ESCLUSI PER SEMPRE, e il server rifiuta una proposta che li nomina:
 * l'esecuzione di script, le chiamate a webhook, le transizioni di workflow
 * (`changesStuck.ts` ha già deciso «si segnala, non si ripara»), e
 * l'accensione dello scripting del cliente.
 */
export const PROPOSAL_ACTION_TYPES = [
  'portal_severities.remove_stale',
  /*
   * `automation.create_disabled` (20 set 2026, prerequisito dell'ondata 6).
   *
   * La prima voce che CREA qualcosa. Nasce spenta, porta `origin:
   * 'ai_proposal'` — che non è un'etichetta ma la regola per cui ogni
   * accensione rivalida le sue azioni contro un'allowlist ristretta — e la
   * sua inversa è cancellarla, che qui è legittimo perché si toglie ciò che
   * la proposta stessa aveva messo.
   */
  'automation.create_disabled',
  /*
   * `enum_value_labels.fill` (20 set 2026, ondata 6). L'unica voce del
   * catalogo in cui il MODELLO scrive testo che le persone leggeranno. Tre
   * regole la rendono accettabile, e sono in `lib/configurationAssistActions.ts`:
   * non sovrascrive mai un'etichetta scritta da una persona, rilegge lo stato
   * di adesso invece di fidarsi di quello di quando la proposta è nata, e si
   * disfa per intero rimettendo il documento di prima.
   */
  'enum_value_labels.fill',
] as const
export type ProposalActionType = (typeof PROPOSAL_ACTION_TYPES)[number]

export function isProposalActionType(v: unknown): v is ProposalActionType {
  return typeof v === 'string' && (PROPOSAL_ACTION_TYPES as readonly string[]).includes(v)
}

/**
 * I tipi d'azione che una proposta non può MAI portare, nemmeno indirettamente
 * (per esempio dentro le azioni di un'automazione che propone di creare).
 * Il guardiano `proposalForbiddenActions.test.ts` tiene ferma la lista.
 */
export const PROPOSAL_FORBIDDEN_ACTION_TYPES: readonly string[] = [
  'execute_script',
  'call_webhook',
  'transition_workflow',
]

/**
 * LE PROVE, tipizzate.
 *
 * `n` e `windowDays` ci sono sempre: una proposta fondata su tre righe si
 * deve vedere a colpo d'occhio. I riferimenti portano il tipo, perché la
 * pagina ne fa link e perché il permesso di lettura si decide sul TIPO —
 * come `PERMESSO_LETTURA` dei task: un elenco di 47 incident mostrato a chi
 * non può leggere gli incident è una fuga.
 */
export interface ProposalEvidenceRef {
  entityType: string
  id:         string
  /** L'etichetta con cui si legge, se la conosciamo al momento della scrittura. */
  label?:     string
}

export interface ProposalEvidence {
  /** Quante volte è stata osservata la cosa. */
  n:          number
  /** In quanti giorni di finestra. */
  windowDays: number
  /** I soggetti, per andarli a vedere. Vuoto è legittimo: non tutte le prove sono entità. */
  refs:       ProposalEvidenceRef[]
  /** Numeri accessori da interpolare nella frase (`kind` + `params` li usa entrambi). */
  extra?:     Record<string, string | number>
}

/**
 * LA FASCIA DELLE PROVE, e perché non è il conteggio.
 *
 * «Una proposta rifiutata torna se le prove cambiano in modo sostanziale» non
 * è un predicato eseguibile: se si implementasse come «l'hash delle prove è
 * cambiato», tornerebbe ogni notte. Con la fascia logaritmica 47 → 52 non
 * riapre niente, 47 → 190 sì.
 */
export function evidenceGrade(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.floor(Math.log2(n))
}

/** Giorni di quiete prima che una proposta rifiutata possa tornare, anche con prove nuove. */
export const PROPOSAL_REJECTION_COOLDOWN_DAYS = 30

/**
 * Se torna o no. Deterministica e sul SERVER: se lo decidesse il modello,
 * deciderebbe quando aggirare il proprio rifiuto.
 */
export function proposalMayReturn(opts: {
  rejectedGrade: number
  currentN:      number
  rejectedAt:    Date
  now:           Date
}): boolean {
  const giorni = (opts.now.getTime() - opts.rejectedAt.getTime()) / 86_400_000
  if (giorni < PROPOSAL_REJECTION_COOLDOWN_DAYS) return false
  return evidenceGrade(opts.currentN) > opts.rejectedGrade
}

/** Giorni dopo i quali una proposta mai letta scade e libera lo slot. */
export const PROPOSAL_EXPIRY_DAYS = 30

/** Mesi dopo i quali una proposta chiusa si purga, lasciando solo la lapide del rifiuto. */
export const PROPOSAL_RETENTION_MONTHS = 12

/**
 * I DUE TETTI, e perché sono due.
 *
 * Quello sulle aperte tiene la pagina leggibile; quello sul flusso impedisce
 * che una notte fortunata la riempia e la blocchi per una settimana. Non sono
 * «per analista»: all'admin non importa quale analista ha scritto la
 * proposta, e un tetto per analista garantisce uno slot alla proposta
 * scadente di un'area mentre un'altra ne aveva tre buone da dire.
 *
 * Sono i valori di fabbrica: il tetto è configurazione del tenant, come i
 * limiti dei moduli del catalogo — non una costante del prodotto.
 */
export const PROPOSAL_LIMIT_DEFAULTS = {
  /** Quante proposte aperte può avere un cliente in tutto. */
  maxOpen:    5,
  /** Quante nuove ne possono nascere in un giorno. */
  maxPerDay:  2,
} as const

export const PROPOSAL_LIMIT_RANGES = {
  maxOpen:   { min: 1, max: 50 },
  maxPerDay: { min: 1, max: 20 },
} as const
