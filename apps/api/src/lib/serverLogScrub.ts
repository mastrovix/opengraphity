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
 * ## Le DUE metà, e perché la prima da sola non bastava
 * **Le forme** (`REGOLE`): URL, email, UUID, data, IP, esadecimale,
 * identificativo, stringa citata, numero. Riconoscono ciò che ha una
 * struttura sintattica.
 *
 * **Le parole** (`mascheraParoleIgnote`): tutto il resto. Sopravvive solo una
 * parola che il prodotto SA di scrivere — il vocabolario generato dai
 * letterali e dagli identificatori del repository — e ogni altra diventa
 * `<w>`.
 *
 * La seconda metà è arrivata il 20 set 2026, dopo che una revisione
 * adversarial ha ESEGUITO la prima e ha mostrato che non teneva:
 *
 *   0 sostituzioni | SLA engine failed for tenant Comune di Bolzano
 *   0 sostituzioni | Contract renewal for Fondazione Cariplo expired
 *   0 sostituzioni | Codice fiscale RSSMRA85M01H501Z non valido
 *   0 sostituzioni | Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…
 *
 * Ragioni sociali, cognomi, hostname interni, codici fiscali e token
 * passavano interi. Una lista di cattivi non si può completare: per ogni
 * forma che aggiungi resta tutto il resto. Quindi si è invertita.
 *
 * ## Che cosa vuol dire «ispezionabile»
 * Quello che viene salvato È quello che si ispeziona: il `template` sul nodo
 * è letteralmente l'uscita di `normalizzaMessaggio()`, non una sua versione
 * accorciata per la vista. `sostituzioni` dice quanti pezzi di FORMA sono
 * stati tolti, `mascherate` quante parole non erano nel vocabolario. Dal 20
 * set 2026 sono anche SCRITTI sul nodo (`substitutions`, `masked_words`):
 * prima questa frase era vera e non si poteva usare, perché il sink li
 * buttava e la query non li salvava — il rischio residuo numero uno era
 * anche l'unico che nessuno poteva interrogare.
 *
 * ## Il rischio che RESTA, detto invece che negato
 * Una frase costruita interamente con parole del vocabolario passa intera.
 * Il caso concreto è un dato di un cliente che coincide con una parola che
 * il prodotto scrive: minuscola («costa»), oppure maiuscola se anche il
 * prodotto la scrive maiuscola. La regola sulla maiuscola (vedi
 * `sopravvive`) chiude la forma in cui un cognome compare davvero.
 *
 * Il verso in cui si sbaglia è dichiarato: una parola tecnica che il
 * vocabolario non ha diventa `<w>` — si perde leggibilità, non
 * riservatezza. Rigenerare il vocabolario è `pnpm vocabolario:log`.
 */
import { createHash } from 'node:crypto'
import { VOCABOLARIO_DEI_LOG } from './vocabolarioDeiLog.js'

/** I segnaposto. Dichiarati, perché un template si legge e si confronta a occhio. */
export const SEGNAPOSTO = {
  url:   '<url>',
  id:    '<id>',
  email: '<email>',
  uuid:  '<uuid>',
  ts:    '<ts>',
  ip:    '<ip>',
  hex:   '<hex>',
  str:   '<str>',
  num:   '<n>',
  /** Una parola che il prodotto non sa di scrivere. Vedi `mascheraParoleIgnote`. */
  w:     '<w>',
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
  /*
   * LETTERE E CIFRE MESCOLATE, LUNGHE: IBAN, codice fiscale, segmenti JWT.
   *
   * Trovato rieseguendo la catena dopo aver invertito lo scrub (20 set 2026):
   * `IBAN IT60X0542811101000000123456` usciva quasi intero. Il motivo è che
   * dentro un blocco alfanumerico NON ci sono confini di parola, quindi né
   * la regola sui numeri né quella sugli identificativi scattavano, e il
   * vocabolario vedeva solo `IT` — una sigla legittima — lasciando le cifre
   * dov'erano.
   *
   * Otto caratteri, e devono esserci SIA una lettera SIA una cifra: così
   * `notifications` (tutte lettere) e `p90` (troppo corto) restano quello che
   * sono, mentre un codice fiscale (16), un IBAN (27) e un segmento di token
   * spariscono interi.
   */
  { nome: 'id',    re: /\b(?=[A-Za-z0-9]*[A-Za-z])(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{8,}\b/g },
  /*
   * LETTERE ATTACCATE A CIFRE: `INC00000042`, `CHG00000003`, `SRV-001`.
   *
   * La regola sui numeri qui sotto pretende un confine di parola, e in
   * `INC00000042` le cifre sono attaccate alle lettere: non scattava. Quindi
   * il NUMERO DI UN TICKET DI UN CLIENTE entrava nel template — cioè
   * nell'unico archivio che attraversa i clienti. Trovato il 20 set 2026
   * sera, da un test scritto per un'altra cosa (i due archivi), con il
   * messaggio vero di un job di sfondo: «SLA engine failed on INC00000042».
   *
   * Due lettere e due cifre come minimo, così `utf8` e `p90` restano quello
   * che sono. Sacrifica qualche termine tecnico (`sha256` → `<id>`), ed è il
   * verso giusto in cui sbagliare.
   */
  { nome: 'id',    re: /\b[A-Za-z]{2,}[-_]?\d{2,}\b/g },
  // Virgolette singole, doppie e backtick: il contenuto di una stringa citata
  // in un messaggio d'errore è sempre un valore, mai la frase.
  { nome: 'str',   re: /(['"`])(?:\\.|(?!\1)[^\\])*\1/g },
  { nome: 'num',   re: /\b\d+(?:[.,]\d+)?\b/g },
]

/*
 * LA SECONDA METÀ: DA LISTA DI CATTIVI A LISTA DI BUONI
 * (20 set 2026, rimedio b).
 *
 * Le nove regole qui sopra riconoscono una FORMA. Tutto ciò che è fatto di
 * parole passava intero, e la revisione l'ha provato eseguendo la catena:
 *
 *   0 sostituzioni | SLA engine failed for tenant Comune di Bolzano
 *   0 sostituzioni | Codice fiscale RSSMRA85M01H501Z non valido
 *   0 sostituzioni | Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
 *
 * Una lista di cattivi non si può completare: per ogni forma che aggiungi
 * resta tutto il resto, e il «rischio che RESTA» dichiarato in testa a questo
 * file era molto più grande di come l'avevo scritto — diceva «il testo
 * costante», ed era vero anche per quello interpolato.
 *
 * Quindi si inverte. Nel template sopravvive solo una parola che il prodotto
 * SA di scrivere — quelle di `vocabolarioDeiLog.ts`, estratte dai letterali
 * del repository — e ogni altra diventa `<w>`.
 *
 * LA MAIUSCOLA CONTA, ed è la metà che rende la regola forte: molti cognomi
 * italiani sono anche parole comuni («Costa», «Conti», «Greco»). Il
 * vocabolario tiene la forma ESATTA, quindi `costa` passa come parola e
 * `Costa` no — a meno che non sia la prima parola della frase, dove la
 * maiuscola è grammatica e non un nome proprio.
 */
const MINUSCOLE: ReadonlySet<string> =
  new Set([...VOCABOLARIO_DEI_LOG].map((w) => w.toLowerCase()))

/**
 * Dopo questi caratteri una maiuscola è grammatica, non un nome proprio.
 * La stringa vuota è l'inizio del messaggio.
 */
const APERTURE: ReadonlySet<string> = new Set(['', '.', ':', '!', '?', '—', '-', '(', '[', '"', '«', '’'])

/** Una parola sopravvive? `inizioFrase` decide se la maiuscola è scusata. */
export function sopravvive(parola: string, inizioFrase: boolean): boolean {
  if (VOCABOLARIO_DEI_LOG.has(parola)) return true
  const basso = parola.toLowerCase()
  if (!MINUSCOLE.has(basso)) return false
  // Il vocabolario ha la parola, ma non in QUESTA forma.
  if (parola === basso) return true                    // minuscola: sempre il verso sicuro
  if (parola === parola.toUpperCase()) return true     // sigla intera: SLA, HTTP, CI
  return inizioFrase                                   // Maiuscola: solo dove è grammatica
}

/** I segnaposto già piazzati dalle regole di forma non si toccano. */
const PAROLA_O_SEGNAPOSTO = /<[a-z]+>|[A-Za-zÀ-ÖØ-öø-ÿ]+/g
/** Una fila di parole ignote è UNA cosa ignota: leggerla come tre non aggiunge niente. */
const FILA_DI_IGNOTE = /<w>(?:[ ]+<w>)+/g

export function mascheraParoleIgnote(testo: string): { testo: string; mascherate: number } {
  let mascherate = 0
  const mascherato = testo.replace(PAROLA_O_SEGNAPOSTO, (token, posizione: number) => {
    if (token.startsWith('<')) return token
    let i = posizione - 1
    while (i >= 0 && testo[i] === ' ') i--
    const precedente = i < 0 ? '' : testo[i]!
    if (sopravvive(token, APERTURE.has(precedente))) return token
    mascherate++
    return SEGNAPOSTO.w
  })
  return { testo: mascherato.replace(FILA_DI_IGNOTE, SEGNAPOSTO.w), mascherate }
}

export interface RigaNormalizzata {
  template:      string
  sostituzioni:  number
  /** Quante parole non stavano nel vocabolario. Vedi `mascheraParoleIgnote`. */
  mascherate:    number
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
  // Le forme prima, le parole dopo: una email va riconosciuta come email,
  // non smontata in tre parole ignote.
  const { testo: mascherato, mascherate } = mascheraParoleIgnote(testo)
  testo = mascherato
  const tagliato = testo.length > MAX_TEMPLATE
  if (tagliato) testo = `${testo.slice(0, MAX_TEMPLATE)}…`
  return { template: testo, sostituzioni, mascherate, tagliato }
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
