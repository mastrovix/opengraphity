/**
 * I MODULI DEL CATALOGO SERVIZI (ondata 1).
 *
 * Prima di questa ondata il modulo di una service request era UNO per tutte:
 * i campi personalizzati si cercavano per tipo di entità (`service_request`) e
 * la voce di catalogo precompilava titolo, descrizione e priorità, nient'altro.
 * «Nuovo portatile» e «Nuovo accesso» chiedevano le stesse cose.
 *
 * Da qui ogni voce di catalogo ha il suo modulo, e il modulo è fatto di due
 * pezzi distinti:
 *
 *  1. la LIBRERIA dei campi, del tenant: `centro_di_costo`, `modello`,
 *     `data_inizio` — ognuno definito UNA volta, con tipo, etichette per
 *     lingua, aiuto e validazione. Vive come nodi `:FormField`.
 *  2. il MODULO della voce, che compone i campi della libreria in sezioni e
 *     per ciascuno può sovrascrivere obbligatorietà, valore iniziale, aiuto e
 *     le condizioni che lo mostrano. Vive come JSON su
 *     `ServiceCatalogItem.form`.
 *
 * PERCHÉ DUE PEZZI. Se ogni voce definisse i propri campi, dieci moduli che
 * chiedono il centro di costo darebbero dieci proprietà diverse sui ticket, e
 * nessun report saprebbe sommarle. Con la libreria il centro di costo è UNA
 * colonna per tutte le richieste.
 *
 * PERCHÉ LE RISPOSTE RESTANO PROPRIETÀ DEL TICKET e non un documento JSON: da
 * quella scelta dipendono i filtri avanzati delle liste, i report
 * (raggruppamento, metrica, colonne), i widget della dashboard, le condizioni
 * di automazioni e business rule e l'esportazione — tutti leggono
 * «n.<campo>» in Cypher. Il regalo è che «se il costo supera mille chiedi
 * l'approvazione» non va costruito: è già esprimibile, perché la risposta è
 * una proprietà come la priorità.
 *
 * Questo file è il CONTRATTO condiviso: lo importano l'API (validazione in
 * scrittura), il web e il portale (rendering). Il valutatore delle condizioni
 * sta qui proprio perché deve essere lo STESSO nel browser e sul server: il
 * browser decide cosa mostrare, il server decide cosa accettare, e se i due
 * ragionassero in modo diverso un campo nascosto diventerebbe un varco.
 */
import { CUSTOM_FIELD_NAME_RE } from './ticketCustomFields.js'

/**
 * I tipi di campo che il renderer SA RENDERE. L'elenco cresce quando cresce il
 * renderer, non prima: un tipo dichiarato e non reso sarebbe configurabile e
 * inerte, che è la famiglia di difetti peggiore (l'interfaccia promette).
 *
 * Resta fuori la TABELLA RIPETIBILE («elenca gli utenti da abilitare»): è
 * l'unico tipo che non può essere una colonna, quindi uscirebbe da filtri,
 * report e condizioni. Se servirà, sarà una scelta dichiarata, non una svista.
 */
export const FORM_FIELD_TYPES = [
  'text',      // una riga
  'textarea',  // più righe
  'number',
  'date',
  'datetime',
  'boolean',
  'enum',      // una scelta da un vocabolario del Dizionario
  'multi_enum', // più scelte dallo stesso vocabolario
  'note',      // nessuna risposta: istruzioni per chi compila
  // ── Ondata 2 ──────────────────────────────────────────────────────────────
  'attachment', // uno o più file: la risposta sono nodi :Attachment, non una proprietà
  'ref_ci',     // un CI della CMDB: la risposta è una relazione nel grafo
  'ref_user',   // una persona
  'ref_team',   // una squadra
  // ── Ondata 7 ──────────────────────────────────────────────────────────────
  'table',      // una TABELLA di righe: la risposta sono nodi :FormTableRow, non una proprietà
] as const
export type FormFieldType = (typeof FORM_FIELD_TYPES)[number]

export function isFormFieldType(v: unknown): v is FormFieldType {
  return typeof v === 'string' && (FORM_FIELD_TYPES as readonly string[]).includes(v)
}

/** I tipi che hanno bisogno di un vocabolario del Dizionario. */
export const FORM_FIELD_TYPES_WITH_VOCABULARY: readonly FormFieldType[] = ['enum', 'multi_enum']
/** I tipi che NON portano una risposta: una nota è istruzione, non domanda. */
export const FORM_FIELD_TYPES_WITHOUT_ANSWER: readonly FormFieldType[] = ['note']
/** I tipi che portano più valori: la risposta è una lista. */
export const FORM_FIELD_TYPES_MULTI: readonly FormFieldType[] = ['multi_enum']

/**
 * DOVE FINISCE LA RISPOSTA. Con l'ondata 2 non è più una cosa sola, e la
 * distinzione va tenuta ferma perché decide cosa si può filtrare:
 *
 *  - `AS_PROPERTY`: una proprietà del nodo ticket. Filtrabile, riportabile,
 *    leggibile dalle condizioni delle business rule. È il caso normale.
 *  - `AS_ATTACHMENT`: nodi `:Attachment` agganciati al ticket e al campo. NON
 *    è una proprietà, quindi NON si filtra — e la pagina lo dice.
 *  - `AS_REFERENCE`: una relazione verso un CI, una persona o una squadra.
 *    Non è una proprietà, ma si filtra per NOME del nodo puntato (il
 *    costruttore di filtri sa già interrogare una relazione), che è ciò che
 *    una persona cerca: «assegnato a Mario Rossi», non un identificativo.
 */
export const FORM_FIELD_TYPES_AS_PROPERTY: readonly FormFieldType[] =
  ['text', 'textarea', 'number', 'date', 'datetime', 'boolean', 'enum', 'multi_enum']
export const FORM_FIELD_TYPES_AS_ATTACHMENT: readonly FormFieldType[] = ['attachment']
export const FORM_FIELD_TYPES_AS_REFERENCE: readonly FormFieldType[] = ['ref_ci', 'ref_user', 'ref_team']
/**
 *  - `AS_ROWS`: una TABELLA (ondata 7). La risposta sono nodi `:FormTableRow`
 *    appesi al ticket, uno per riga, con una proprietà per colonna. Non è una
 *    proprietà del ticket e non può diventarlo: una proprietà è un valore, una
 *    tabella è una lista di RECORD. Quindi non è una colonna nelle liste, non
 *    è un widget e non è una colonna di report — si filtra però, per riga
 *    («esiste una riga dove ruolo = amministratore»), che è la domanda che una
 *    persona fa davvero.
 */
export const FORM_FIELD_TYPES_AS_ROWS: readonly FormFieldType[] = ['table']

export function isFormTableType(t: string): boolean {
  return (FORM_FIELD_TYPES_AS_ROWS as readonly string[]).includes(t)
}

/** L'etichetta Neo4j del nodo puntato da un campo di riferimento. */
export const FORM_REFERENCE_LABELS: Readonly<Record<string, string>> = {
  ref_ci:   'ConfigurationItem',
  ref_user: 'User',
  ref_team: 'Team',
}

/**
 * Il tipo di relazione, uno per genere di riferimento. NON è composto dal nome
 * del campo — un tipo di relazione interpolato in Cypher esce dal perimetro
 * del guardiano `check-cypher.mjs`, che non potrebbe più mandarlo in EXPLAIN.
 * Quale campo lo ha creato sta nella proprietà `field` della relazione.
 */
export const FORM_REFERENCE_REL_TYPES: Readonly<Record<string, string>> = {
  ref_ci:   'FORM_REFERS_TO_CI',
  ref_user: 'FORM_REFERS_TO_USER',
  ref_team: 'FORM_REFERS_TO_TEAM',
}

/** La proprietà del nodo puntato che si mostra e su cui si filtra. */
export const FORM_REFERENCE_SEARCH_PROPS: Readonly<Record<string, string>> = {
  ref_ci:   'name',
  ref_user: 'name',
  ref_team: 'name',
}

export function isFormReferenceType(t: string): boolean {
  return (FORM_FIELD_TYPES_AS_REFERENCE as readonly string[]).includes(t)
}

export function isFormAttachmentType(t: string): boolean {
  return (FORM_FIELD_TYPES_AS_ATTACHMENT as readonly string[]).includes(t)
}

/**
 * I tipi che una CONDIZIONE può guardare: solo quelli che diventano una
 * proprietà. Un allegato o un riferimento avrebbero bisogno di leggere nodi
 * per essere valutati, e il valutatore delle condizioni gira anche nel browser
 * su quello che ha in mano: meglio vietarlo nel costruttore che offrirlo e
 * farlo sbagliare a metà.
 */
export function canBeConditionSubject(fieldType: string): boolean {
  return (FORM_FIELD_TYPES_AS_PROPERTY as readonly string[]).includes(fieldType)
}

/**
 * I CAMPI CALCOLATI (ondata 6). Un campo della libreria può portare una
 * `formula`: un pezzo di JavaScript che riceve le risposte già date (`input`)
 * e RESTITUISCE il valore. Lo stesso contratto dei default dei campi CI, e lo
 * stesso pezzo di codice gira in due sandbox — QuickJS nel browser, mentre si
 * compila, e isolated-vm sul server al salvataggio, che è quello di cui ci si
 * fida.
 *
 * Quali tipi possono essere calcolati: quelli che diventano una proprietà
 * SINGOLA. Fuori la selezione multipla (una formula che restituisce una lista
 * è un altro lavoro: servirebbe validare ogni elemento e decidere l'ordine),
 * fuori le note (non hanno risposta), fuori allegati e riferimenti (una
 * formula non può creare un file né scegliere un nodo del grafo).
 */
export const FORM_FIELD_TYPES_COMPUTABLE: readonly FormFieldType[] =
  ['text', 'textarea', 'number', 'date', 'datetime', 'boolean', 'enum']

export function canBeComputed(fieldType: string): boolean {
  return (FORM_FIELD_TYPES_COMPUTABLE as readonly string[]).includes(fieldType)
}

/**
 * Cosa vede una formula: le risposte dei campi NON calcolati.
 *
 * Perché non tutte: una formula che leggesse un altro campo calcolato
 * aprirebbe le catene, e con le catene i cicli (A guarda B, B guarda A) —
 * che andrebbero riconosciuti e rifiutati. Togliendoli dal perimetro il
 * problema non esiste: una formula guarda quello che ha scritto una persona.
 * Se domani servirà l'ordinamento, si aggiungerà con il riconoscimento dei
 * cicli, non di sfroso.
 */
export function formulaInput(
  answers: Readonly<Record<string, unknown>>,
  campiCalcolati: ReadonlySet<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [nome, valore] of Object.entries(answers)) {
    if (campiCalcolati.has(nome)) continue
    out[nome] = valore
  }
  return out
}

/**
 * L'`entity_type` degli allegati caricati su una BOZZA di modulo, prima che il
 * ticket esista.
 *
 * Il problema che risolve: un campo allegato si compila mentre la richiesta non
 * c'è ancora, e nel portale il caricamento era possibile solo DOPO la
 * creazione. Il file si carica subito con un identificativo di bozza scelto dal
 * client; alla creazione i nodi `:Attachment` passano dalla bozza al ticket —
 * nessun file si muove sul disco. Le bozze mai reclamate le pulisce la
 * manutenzione notturna.
 */
export const FORM_DRAFT_ENTITY_TYPE = 'form_draft'

/** Il nome di un campo della libreria è il nome della proprietà sul ticket: stesse regole dei campi personalizzati. */
export const FORM_FIELD_NAME_RE = CUSTOM_FIELD_NAME_RE

/** Testo per lingua dentro il JSON del modulo: `{ en: 'Cost centre', it: 'Centro di costo' }`. */
export type LocalizedText = Readonly<Record<string, string>>

// ── Le condizioni ───────────────────────────────────────────────────────────
//
// Dichiarative, non script: così il costruttore può mostrarle, spiegarle e
// verificarle, e il server può rivalutarle senza eseguire codice del cliente.

export const FORM_CONDITION_OPS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'filled', 'empty'] as const
export type FormConditionOp = (typeof FORM_CONDITION_OPS)[number]

export function isFormConditionOp(v: unknown): v is FormConditionOp {
  return typeof v === 'string' && (FORM_CONDITION_OPS as readonly string[]).includes(v)
}

/** Gli operatori che non guardano un valore di confronto. */
export const FORM_CONDITION_OPS_WITHOUT_VALUE: readonly FormConditionOp[] = ['filled', 'empty']

export interface FormConditionRule {
  /** Il nome di un campo della libreria usato nello stesso modulo. */
  readonly field: string
  readonly op: FormConditionOp
  /** Assente per `filled` e `empty`. */
  readonly value?: string
}

export interface FormCondition {
  /** `all` = tutte le regole, `any` = almeno una. */
  readonly match: 'all' | 'any'
  readonly rules: readonly FormConditionRule[]
}

/** Le risposte in corso di compilazione: nome del campo → valore. */
export type FormAnswers = Readonly<Record<string, FormAnswerValue>>
export type FormAnswerValue = string | number | boolean | readonly string[] | null | undefined

/** Una risposta «non data»: assente, nulla, stringa vuota o lista vuota. */
export function isFormAnswerEmpty(value: FormAnswerValue): boolean {
  if (value == null) return true
  if (typeof value === 'string') return value.trim() === ''
  if (Array.isArray(value)) return value.length === 0
  return false
}

/**
 * Una regola su una risposta. I confronti d'ordine (`gt`, `gte`, `lt`, `lte`)
 * sono numerici quando ENTRAMBI i lati sono numeri, altrimenti alfabetici sul
 * testo: così funzionano sia su «costo > 1000» che su «data_inizio >=
 * 2026-01-01», che in ISO si ordina come testo.
 *
 * Una risposta vuota fa fallire ogni regola tranne `empty`: un campo non
 * ancora compilato non deve far comparire quello che dipende da lui.
 */
export function evaluateFormRule(rule: FormConditionRule, answers: FormAnswers): boolean {
  const raw = answers[rule.field]
  if (rule.op === 'filled') return !isFormAnswerEmpty(raw)
  if (rule.op === 'empty')  return isFormAnswerEmpty(raw)
  if (isFormAnswerEmpty(raw)) return false
  const atteso = rule.value ?? ''

  // Le liste (selezione multipla) si confrontano per appartenenza: `eq` vuol
  // dire «fra le scelte c'è», `contains` idem — la differenza fra i due non
  // avrebbe senso su una lista.
  if (Array.isArray(raw)) {
    const dentro = raw.some((v) => String(v) === atteso)
    if (rule.op === 'eq' || rule.op === 'contains') return dentro
    if (rule.op === 'ne') return !dentro
    return false // i confronti d'ordine non hanno senso su una lista
  }

  const testo = typeof raw === 'boolean' ? (raw ? 'true' : 'false') : String(raw)
  switch (rule.op) {
    case 'eq':       return testo === atteso
    case 'ne':       return testo !== atteso
    case 'contains': return testo.toLowerCase().includes(atteso.toLowerCase())
    default: {
      const a = Number(testo), b = Number(atteso)
      const numerico = testo.trim() !== '' && atteso.trim() !== '' && Number.isFinite(a) && Number.isFinite(b)
      const cmp = numerico ? (a < b ? -1 : a > b ? 1 : 0) : testo.localeCompare(atteso)
      if (rule.op === 'gt')  return cmp > 0
      if (rule.op === 'gte') return cmp >= 0
      if (rule.op === 'lt')  return cmp < 0
      return cmp <= 0
    }
  }
}

/**
 * La condizione di visibilità. **Assente = visibile**: un campo senza
 * condizioni si vede sempre, ed è il caso normale.
 *
 * Un elenco di regole VUOTO con `match: 'all'` sarebbe «tutte le zero regole
 * sono vere» = visibile; con `any` sarebbe «almeno una di zero» = nascosto per
 * sempre, cioè un campo che nessuno può compilare. La validazione della
 * definizione rifiuta un elenco vuoto proprio per non dover scegliere qui.
 */
export function evaluateFormCondition(condition: FormCondition | undefined, answers: FormAnswers): boolean {
  if (!condition || condition.rules.length === 0) return true
  return condition.match === 'any'
    ? condition.rules.some((r) => evaluateFormRule(r, answers))
    : condition.rules.every((r) => evaluateFormRule(r, answers))
}

// ── La definizione del modulo ───────────────────────────────────────────────

/** Un campo della libreria dentro una sezione, con le sovrascritture del modulo. */
export interface CatalogFormItem {
  /** Nome del campo nella libreria del tenant. */
  readonly field: string
  /** Sovrascrive `FormField.required` per questo modulo: obbligatorio qui e no altrove. */
  readonly required?: boolean
  /** Valore iniziale proposto (testo, come arriva dal modulo). */
  readonly defaultValue?: string
  /** Aiuto specifico di questo modulo; assente = quello della libreria. */
  readonly help?: LocalizedText
  /** Larghezza nella griglia della sezione. */
  readonly width?: 'full' | 'half'
  /** Se assente, il campo si vede sempre. */
  readonly visibleWhen?: FormCondition
  /**
   * Se `false` il campo NON viene offerto a chi compila dal portale (resta
   * visibile e compilabile dall'area di lavoro). Assente = offerto.
   */
  readonly endUser?: boolean
}

export interface CatalogFormSection {
  /** Stabile: lo usano il rendering e i riferimenti. */
  readonly id: string
  readonly title: LocalizedText
  readonly description?: LocalizedText
  readonly visibleWhen?: FormCondition
  readonly items: readonly CatalogFormItem[]
}

/**
 * La forma del documento salvato su `ServiceCatalogItem.form`.
 *
 * `version` è la versione dello SCHEMA di questo documento (cambia quando
 * cambiamo noi la forma, e allora serve una migrazione nominata, come per
 * `Tenant.event_policy`). `revision` è la versione PUBBLICATA del modulo, che
 * sale a ogni pubblicazione del cliente: il ticket porta la sua e così il
 * modulo di ieri resta ricostruibile senza duplicare un solo valore.
 */
export interface CatalogFormDefinition {
  readonly version: number
  readonly revision: number
  readonly sections: readonly CatalogFormSection[]
}

/** La versione dello schema del documento scritta dal codice di oggi. */
export const CATALOG_FORM_VERSION = 1

/** Un modulo appena creato: una sezione vuota, per non far vedere una pagina bianca. */
export function emptyCatalogForm(): CatalogFormDefinition {
  return {
    version: CATALOG_FORM_VERSION,
    revision: 0,
    sections: [{ id: 'main', title: {}, items: [] }],
  }
}

/**
 * LE VOCI DEL MODULO DA COMPILARE, date queste risposte — **in un posto solo**.
 *
 * Era scritta tre volte: `visibleFormItems` nell'API, `visibleCatalogFormItems`
 * in `web-core`, e una terza copia in linea dentro il corpo del renderer.
 * Condiviso c'era solo il valutatore di UNA condizione, mentre il commento del
 * renderer affermava «è la stessa funzione che il server richiama». Tre copie
 * della regola che decide cosa si può scrivere su un ticket sono tre modi di
 * divergere: basta aggiungere una dimensione di visibilità da un lato — come è
 * successo con `endUser` — e il client mostra un campo che il server rifiuta,
 * cioè chi compila non ha via d'uscita (revisione del 17 set 2026).
 *
 * `endUser: true` = chi compila è un utente finale del portale, e le voci che
 * il modulo destina all'area di lavoro non gli si chiedono.
 */
export function formItemsToFill(
  def: CatalogFormDefinition, answers: FormAnswers, opts: { endUser?: boolean } = {},
): CatalogFormItem[] {
  const out: CatalogFormItem[] = []
  for (const s of def.sections) {
    if (!evaluateFormCondition(s.visibleWhen, answers)) continue
    for (const i of s.items) {
      if (opts.endUser && i.endUser === false) continue
      if (!evaluateFormCondition(i.visibleWhen, answers)) continue
      out.push(i)
    }
  }
  return out
}

/**
 * IL MODULO COME LO VEDE L'UTENTE FINALE: via le voci che il modulo non offre
 * nel portale, e via le sezioni che così restano senza voci.
 *
 * Perché esiste (revisione del 17 set 2026): `catalogFormToFill` dichiarava
 * l'argomento `endUser` e non lo leggeva mai, quindi al portale arrivava la
 * definizione INTEGRALE — le voci «solo area di lavoro», le loro etichette,
 * i loro aiuti e, con i campi, il codice delle formule. Il filtro esisteva
 * solo nel browser, cioè dove chiunque può toglierlo. La scrittura era già
 * chiusa (il server rifiuta un campo non offerto), quindi era divulgazione e
 * non un varco — ma una promessa scritta nello schema e nel commento della
 * query del portale, e non mantenuta.
 *
 * Una sezione vuota si toglie: il suo titolo è comunque un dato interno, e
 * mostrare un'intestazione senza campi sarebbe un modulo rotto.
 */
export function catalogFormForEndUser(def: CatalogFormDefinition): CatalogFormDefinition {
  const sections = def.sections
    .map((s) => ({ ...s, items: s.items.filter((i) => i.endUser !== false) }))
    .filter((s) => s.items.length > 0)
  return { ...def, sections }
}

/** Tutti i campi referenziati dal modulo, nell'ordine in cui compaiono. */
export function catalogFormFieldNames(def: CatalogFormDefinition): string[] {
  return def.sections.flatMap((s) => s.items.map((i) => i.field))
}

/** I campi citati dalle condizioni (di sezione o di campo): devono esistere nel modulo. */
export function catalogFormConditionFieldNames(def: CatalogFormDefinition): string[] {
  const nomi: string[] = []
  const raccogli = (c: FormCondition | undefined) => { if (c) for (const r of c.rules) nomi.push(r.field) }
  for (const s of def.sections) {
    raccogli(s.visibleWhen)
    for (const i of s.items) raccogli(i.visibleWhen)
  }
  return nomi
}

/** Il testo nella lingua chiesta, poi la prima disponibile, poi il ripiego. */
export function localizedText(text: LocalizedText | undefined, language: string | null | undefined, fallback: string): string {
  if (!text) return fallback
  if (language && text[language]) return text[language]!
  const prima = Object.values(text).find((v) => v.trim() !== '')
  return prima ?? fallback
}

// ── La tabella ripetibile (ondata 7) ────────────────────────────────────────
//
// «Elenca le persone da abilitare: nome, ruolo, data di inizio» — tre righe
// oggi, sette domani. È l'unico tipo che NON diventa una proprietà del ticket,
// e per una ragione che vale la pena scrivere: una proprietà è un valore, una
// tabella è una lista di record. Metterla in una proprietà vorrebbe dire un
// JSON dentro il nodo, cioè esattamente il documento opaco che tutto questo
// modulo evita: non si filtra, non si riporta, non si somma.
//
// Quindi le righe sono NODI (`:FormTableRow`), come gli allegati sono nodi e i
// riferimenti sono relazioni. Si pagano due cose — una lettura in più per
// mostrarle, e una sottoquery per filtrarle — e si guadagna che «esiste una
// riga dove ruolo = amministratore» è una domanda che si può fare.

/** I tipi che una COLONNA di tabella può avere: valori scalari, niente di annidato. */
export const FORM_TABLE_COLUMN_TYPES = ['text', 'number', 'date', 'boolean', 'enum'] as const
export type FormTableColumnType = (typeof FORM_TABLE_COLUMN_TYPES)[number]

export function isFormTableColumnType(v: unknown): v is FormTableColumnType {
  return typeof v === 'string' && (FORM_TABLE_COLUMN_TYPES as readonly string[]).includes(v)
}

export interface FormTableColumn {
  /** Il nome della proprietà sulla riga: stesse regole del nome di un campo. */
  readonly name: string
  readonly labels: LocalizedText
  readonly fieldType: FormTableColumnType
  /** Il vocabolario del Dizionario, solo per `enum`. */
  readonly vocabulary?: string | null
  /** Obbligatoria: una riga senza questo valore non si salva. */
  readonly required?: boolean
}

/**
 * La definizione delle colonne, sul campo della libreria. Versionata come il
 * documento del modulo (`CatalogFormDefinition`) e per lo stesso motivo: se un
 * giorno la forma cambia, chi legge deve accorgersene invece di indovinare.
 */
export interface FormTableDefinition {
  readonly version: number
  readonly columns: readonly FormTableColumn[]
}

export const FORM_TABLE_VERSION = 1
export const FORM_TABLE_V1_KEYS = ['version', 'columns'] as const

/** Una riga come viaggia fra browser, API e grafo: valore per nome di colonna. */
export type FormTableRow = Readonly<Record<string, string | null>>

export function emptyFormTable(): FormTableDefinition {
  return { version: FORM_TABLE_VERSION, columns: [] }
}

/** L'etichetta di una colonna nella lingua chiesta, col ripiego del nome. */
export function formTableColumnLabel(column: FormTableColumn, language?: string | null): string {
  return localizedText(column.labels, language, column.name)
}

/**
 * Una riga è VUOTA quando nessuna cella ha un valore. Serve in un posto solo,
 * ma è la regola che decide cosa si salva: una riga aggiunta e mai compilata
 * non è un dato, è un clic — e salvarla darebbe righe fantasma nei report.
 */
export function isFormTableRowEmpty(row: FormTableRow): boolean {
  return Object.values(row).every((v) => v == null || String(v).trim() === '')
}
