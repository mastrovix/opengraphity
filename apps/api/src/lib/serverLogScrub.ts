/**
 * LO SCRUBBING DEI LOG DEL SERVER (20 set 2026, ondata 3 di «Miglioramento
 * continuo»).
 *
 * ## Perché esiste
 * I log del server contengono identificativi di TUTTI i tenant, anche di chi
 * ha spento ogni interruttore AI. Persistendoli nel grafo si costruisce un
 * archivio che attraversa il perimetro fra i clienti — e il prodotto ha già
 * pagato questo difetto una volta (`lib/logTenantScope.ts`: la pagina Log
 * mostrava le righe di tutti i clienti serviti dallo stesso processo).
 *
 * La difesa non è una promessa nel prompt di un modello: è che **la riga
 * intera non viene mai scritta**. Nel grafo finisce solo ciò che esce da
 * qui, e ciò che esce da qui è per costruzione un TEMPLATE — la frase con i
 * pezzi variabili sostituiti da segnaposto. Non c'è un percorso che scrive
 * il messaggio grezzo e uno che lo oscura dopo: ce n'è uno solo.
 *
 * ## Che cosa vuol dire «ispezionabile»
 * Quello che viene salvato È quello che si ispeziona: il `template` sul nodo
 * è letteralmente l'uscita di `normalizzaMessaggio()`, non una sua versione
 * accorciata per la vista. Chi vuole sapere cosa il prodotto conserva di sé
 * stesso apre la riga e lo legge. `sostituzioni` dice quanti pezzi sono
 * stati tolti: un template con zero sostituzioni è una frase costante del
 * codice, ed è il caso in cui vale la pena guardare.
 *
 * ## Il rischio che RESTA, detto invece che negato
 * Un messaggio il cui testo COSTANTE contiene già dati di un cliente passa
 * indenne: `logger.error(\`Ticket ACME-Backup non chiuso\`)` è una stringa
 * sola quando pino la vede, senza virgolette e senza numeri. Non è un buco
 * di questo modulo — è la regola già scritta in `lib/logger.ts` («never log
 * raw job.data / request bodies») applicata male da chi scrive quella riga.
 * Qui si tagliano i pezzi variabili e si dichiara il limite; il tetto sulla
 * lunghezza (`MAX_TEMPLATE`) limita quanto può uscire da una riga sola.
 */
import { createHash } from 'node:crypto'

/** I segnaposto. Dichiarati, perché un template si legge e si confronta a occhio. */
export const SEGNAPOSTO = {
  url:   '<url>',
  email: '<email>',
  uuid:  '<uuid>',
  ts:    '<ts>',
  ip:    '<ip>',
  hex:   '<hex>',
  str:   '<str>',
  num:   '<n>',
} as const

/**
 * Quanto può essere lungo un template. Un messaggio più lungo di così non è
 * una frase: è un payload che qualcuno ha loggato per sbaglio, ed è
 * esattamente il caso in cui NON lo vogliamo nel grafo per intero.
 */
export const MAX_TEMPLATE = 300

/** Quanto della prima riga di stack si tiene: basta a dire «dove», non «con cosa». */
export const MAX_STACK_HEAD = 200

/*
 * L'ORDINE CONTA, e per questo le regole sono una lista e non un oggetto.
 *
 * `<url>` prima di `<n>`, altrimenti una porta diventa `<n>` e l'URL non si
 * riconosce più. Le stringhe fra virgolette DOPO uuid/email/url, così una
 * stringa che contiene un id si legge come `<str>` e non come `'<uuid>'`:
 * un pezzo variabile è un pezzo variabile, quanti segnaposto annidati
 * contenga non interessa a nessuno.
 */
const REGOLE: ReadonlyArray<{ nome: keyof typeof SEGNAPOSTO; re: RegExp }> = [
  { nome: 'url',   re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"`)\]]+/gi },
  { nome: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { nome: 'uuid',  re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi },
  { nome: 'ts',    re: /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g },
  { nome: 'ip',    re: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g },
  { nome: 'hex',   re: /\b[0-9a-f]{8,}\b/gi },
  // Virgolette singole, doppie e backtick: il contenuto di una stringa citata
  // in un messaggio d'errore è sempre un valore, mai la frase.
  { nome: 'str',   re: /(['"`])(?:\\.|(?!\1)[^\\])*\1/g },
  { nome: 'num',   re: /\b\d+(?:[.,]\d+)?\b/g },
]

export interface RigaNormalizzata {
  template:      string
  sostituzioni:  number
  /** `true` quando il messaggio era più lungo di `MAX_TEMPLATE` ed è stato tagliato. */
  tagliato:      boolean
}

/**
 * Il messaggio diventa un template: stessa forma per due occorrenze dello
 * stesso errore, valori diversi.
 *
 * Esempio vero, dal difetto dell'ondata 2:
 *   «Variable `previousTeamName` not defined (line 30, column 16 (offset: 1252))»
 *   → «Variable <str> not defined (line <n>, column <n> (offset: <n>))»
 */
export function normalizzaMessaggio(messaggio: string): RigaNormalizzata {
  let testo = (messaggio ?? '').replace(/\s+/g, ' ').trim()
  let sostituzioni = 0
  for (const { nome, re } of REGOLE) {
    testo = testo.replace(re, () => { sostituzioni++; return SEGNAPOSTO[nome] })
  }
  const tagliato = testo.length > MAX_TEMPLATE
  if (tagliato) testo = `${testo.slice(0, MAX_TEMPLATE)}…`
  return { template: testo, sostituzioni, tagliato }
}

/**
 * La prima riga di stack: dice DOVE, e si ferma lì.
 *
 * Il percorso di un file dentro il container non è un dato di nessun cliente;
 * gli argomenti, che a volte compaiono nelle righe successive, sì. Per questo
 * si tiene una riga sola, e passa comunque dallo scrubbing.
 */
export function primaRigaDiStack(stack: unknown): string | null {
  if (typeof stack !== 'string' || stack.trim() === '') return null
  const righe = stack.split('\n').map((r) => r.trim()).filter((r) => r !== '')
  // La prima riga di uno stack di Node è il messaggio, non il luogo: si vuole
  // la prima che comincia con `at `, se c'è.
  const luogo = righe.find((r) => r.startsWith('at ')) ?? righe[0]
  if (!luogo) return null
  const { template } = normalizzaMessaggio(luogo)
  return template.length > MAX_STACK_HEAD ? `${template.slice(0, MAX_STACK_HEAD)}…` : template
}

/**
 * La FIRMA di una classe di errori: servizio, modulo, livello e template.
 *
 * È ciò che il connettore raggruppa (§ `serverLogEvents.ts`). Non contiene il
 * tenant: lo stesso guasto che colpisce tre clienti è UN guasto, e contarlo
 * tre volte darebbe tre incident sullo stesso CI.
 */
export function firmaDi(parti: { service: string; module: string; level: string; template: string }): string {
  const grezzo = `${parti.service}|${parti.module}|${parti.level}|${parti.template}`
  return createHash('sha256').update(grezzo).digest('hex').slice(0, 32)
}
