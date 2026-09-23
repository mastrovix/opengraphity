#!/usr/bin/env node
/**
 * IL VOCABOLARIO DEI LOG: generatore (20 set 2026, rimedio b).
 *
 * ## Perché esiste
 * `lib/serverLogScrub.ts` nasceva come lista di CATTIVI: nove regole che
 * riconoscono un URL, una email, un UUID, un IP, un esadecimale. Funziona per
 * ciò che ha una forma, e non vede niente di ciò che è fatto di parole. La
 * revisione del 20 set l'ha provato eseguendo la catena vera:
 *
 *   0 sostituzioni | SLA engine failed for tenant Comune di Bolzano
 *   0 sostituzioni | Contract renewal for Fondazione Cariplo expired
 *   0 sostituzioni | Codice fiscale RSSMRA85M01H501Z non valido
 *   0 sostituzioni | Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
 *
 * Ragioni sociali, cognomi, hostname interni, codici fiscali e token
 * passavano interi dentro `:ServerLogEntry` — l'archivio senza tenant, quello
 * che attraversa il perimetro fra i clienti — e da lì nel prompt mandato al
 * modello, nel titolo di un incident e dentro una proposta che resta nel
 * grafo dodici mesi.
 *
 * Una lista di cattivi non si può completare: per ogni forma che aggiungi
 * resta tutto il resto. Quindi si inverte — lista di BUONI. Nel template
 * sopravvive solo una parola che il prodotto SA di scrivere; ogni altra
 * diventa `<w>`.
 *
 * ## Da dove vengono le parole
 * Dai letterali di stringa del repository stesso. È la sorgente giusta per
 * una ragione sola e sufficiente: il codice non contiene i dati dei clienti.
 * Una parola che sta in un sorgente è una parola che abbiamo scritto noi, e
 * quindi non è il cognome di nessuno.
 *
 * I file di test sono ESCLUSI apposta: è lì che vivono «Mario Rossi», «Acme»
 * e «Banca Sella», ed è esattamente la roba che non deve entrare in un
 * vocabolario il cui compito è lasciar passare solo ciò che non identifica
 * nessuno.
 *
 * ## Il verso in cui sbaglia
 * Una parola tecnica che il vocabolario non ha diventa `<w>`: si perde
 * leggibilità, non si perde riservatezza. È il verso giusto, lo stesso
 * dichiarato per la regola `<id>`. Il prezzo si paga in chiarezza del
 * template, e si ripaga rigenerando il vocabolario.
 *
 * ## Uso
 *   node scripts/genera-vocabolario-log.mjs          # riscrive il modulo
 *   node scripts/genera-vocabolario-log.mjs --check  # fallisce se è da rigenerare
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const RADICE = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const USCITA = join(RADICE, 'apps/api/src/lib/vocabolarioDeiLog.ts')

/** Dove si pescano i letterali. Solo codice nostro. */
const ALBERI = ['apps/api/src', 'apps/web/src', 'apps/portal/src', 'apps/console/src', 'packages']

/**
 * Che cosa NON si guarda.
 *
 * I test per primi: contengono nomi di persone e di aziende inventati, che
 * somigliano in tutto e per tutto a quelli veri — e un vocabolario che li
 * contenesse lascerebbe passare la parola «Rossi» in un template. Per la
 * stessa ragione i dati di prova (`lib/testData/**`): il generatore del
 * tenant di dimostrazione tiene elenchi di nomi e cognomi italiani veri —
 * rigenerando senza escluderli, «Costa», «Conti», «Greco» e «Monti» sono
 * entrati nel vocabolario e la pulizia dei log ha smesso di nasconderli. Le locale
 * i18n perché sono la lingua dell'interfaccia, non quella dei log, e
 * gonfierebbero il vocabolario di decine di migliaia di parole senza che una
 * sola di esse arrivi mai in un messaggio d'errore.
 */
const ESCLUSI = [
  /__tests__/, /\.test\.[jt]sx?$/, /\.spec\.[jt]sx?$/,
  /node_modules/, /\/dist\//, /\/build\//, /\/coverage\//,
  /\/i18n\/locales\//, /\/seed[^/]*\.[jt]s$/, /\/fixtures?\//,
  /\/test\//, /\/mocks?\//, /\/testData\//,
  /*
   * E il vocabolario stesso (22 set 2026). Si rileggeva: una parola entrata
   * una volta per sbaglio — «Costa» e «Conti», cognomi arrivati da un elenco
   * di nomi finti — ci restava per sempre, perché la rigenerazione successiva
   * la ritrovava nel proprio file anche dopo che la sorgente era sparita.
   * Un guardiano che si alimenta da sé non torna mai indietro.
   */
  /\/vocabolarioDeiLog\.ts$/,
]

/**
 * LE PAROLE CHE NON ENTRANO MAI, da nessuna sorgente.
 *
 * Il prodotto usa nomi di persone e di aziende INVENTATI come esempi — nei
 * segnaposto dei campi, nelle righe d'uso degli script, nelle mock. Sono per
 * costruzione indistinguibili da quelli veri: è il loro scopo. Un vocabolario
 * il cui compito è escludere i dati dei clienti non può contenere le parole
 * che il prodotto stesso usa PER FINGERE un dato di un cliente.
 *
 * Trovate rigenerando la prima volta: `acme`, `mario`, `rossi` erano entrate
 * da `onboard-tenant.ts`, da `LoginSecurityPage.tsx` e dalle mock del web.
 */
const MAI = new Set([
  'acme', 'mario', 'rossi', 'bianchi', 'verdi', 'esempio', 'example', 'sample', 'dummy', 'foo', 'bar', 'baz',
  'contoso', 'initech', 'umbrella', 'globex', 'wayne', 'stark',
])

const ESTENSIONI = /\.(ts|tsx|mts|cts)$/

function* file(dir) {
  let voci
  try { voci = readdirSync(dir) } catch { return }
  for (const v of voci) {
    const p = join(dir, v)
    const rel = relative(RADICE, p)
    if (ESCLUSI.some((re) => re.test(`/${rel}`))) continue
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) yield* file(p)
    else if (ESTENSIONI.test(p)) yield p
  }
}

/** I letterali di stringa: apici singoli, doppi e backtick. */
const LETTERALI = [
  /'(?:\\.|[^'\\\n])*'/g,
  /"(?:\\.|[^"\\\n])*"/g,
  /`(?:\\.|[^`\\])*`/g,
]

/**
 * Una parola: solo lettere, accentate comprese.
 *
 * Niente cifre: un token con le cifre dentro l'ha già preso una regola di
 * forma (`<id>`, `<n>`, `<hex>`) prima che si arrivi al vocabolario.
 */
const PAROLA = /[A-Za-zÀ-ÖØ-öø-ÿ]+/g

/** Oltre questa lunghezza non è una parola: è un token, e i token non passano. */
const MAX_PAROLA = 30

/**
 * Via i commenti PRIMA di cercare i letterali.
 *
 * Un commento d'uso come `--admin-email mario@acme.com` non è un messaggio
 * che il prodotto scrive: è documentazione, e i suoi esempi sono finti nomi
 * di persone. Erano la sorgente di metà delle parole della lista `MAI`.
 */
function senzaCommenti(testo) {
  return testo.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
}

/**
 * Le parole con la LORO maiuscola, non abbassate.
 *
 * È la metà che dà forza al vocabolario. Molti cognomi italiani sono anche
 * parole comuni — «Costa», «Conti», «Greco», «Monti» — e un vocabolario
 * tutto minuscolo li lascerebbe passare appena compaiono maiuscoli in mezzo
 * a una frase, che è esattamente come compare un cognome. Tenendo la forma
 * esatta, «Costa» passa solo se il prodotto scrive davvero «Costa»
 * maiuscolo da qualche parte; «costa» minuscolo resta una parola italiana.
 */
function paroleDi(testo) {
  const trovate = new Set()
  const pulito = senzaCommenti(testo)
  const aggiungi = (w) => {
    if (w.length <= MAX_PAROLA && !MAI.has(w.toLowerCase())) trovate.add(w)
  }
  for (const re of LETTERALI) {
    for (const m of pulito.matchAll(re)) {
      for (const p of m[0].matchAll(PAROLA)) aggiungi(p[0])
    }
  }
  /*
   * ANCHE I NOSTRI IDENTIFICATORI, non solo i letterali.
   *
   * Trovato facendo cadere un test esistente: `at scriviProposta
   * (/app/dist/lib/proposals.js:120:15)` diventava `at <w> (...)`. La prima
   * riga di uno stack è fatta di NOMI DI FUNZIONE, che stanno nel codice e
   * non dentro le virgolette — quindi il vocabolario non li conosceva e
   * `stack_head` perdeva l'unica informazione per cui esiste: il DOVE.
   *
   * Sono nomi che abbiamo scritto noi, quindi valgono come i letterali: il
   * codice non contiene i dati di nessun cliente.
   */
  for (const m of pulito.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) {
    for (const p of m[0].matchAll(PAROLA)) aggiungi(p[0])
    aggiungi(m[0].replace(/[_$0-9]/g, ''))
  }
  return trovate
}

/**
 * IL NUCLEO SCRITTO A MANO.
 *
 * Sono le parole che compaiono nei messaggi d'errore delle LIBRERIE e del
 * runtime — Node, ioredis, il driver Neo4j, BullMQ, Apollo — che per
 * definizione non stanno nei nostri letterali ma finiscono lo stesso nei
 * nostri template, soprattutto in `stack_head`. Senza queste, la prima riga
 * di un'eccezione diventa una fila di `<w>` e la diagnostica perde il suo
 * pezzo più utile.
 */
const NUCLEO = `
econnrefused econnreset etimedout enotfound epipe eaddrinuse ehostunreach enetunreach eacces eexist enoent emfile
getaddrinfo connect socket hang up closed unexpectedly timeout timed out refused reset aborted abort
readonly writable readable stream buffer chunk encoding parse parsing serialize deserialize malformed
promise rejection unhandled uncaught exception throw thrown stack trace caused nested
redis ioredis cluster sentinel subscriber publisher pubsub reconnect reconnecting retry retries attempt attempts
neo constraint deadlock transaction session driver bolt cypher routing leader follower replica database unavailable
forbidden unauthorized unauthenticated authentication authorization token expired signature issuer audience claim
graphql resolver mutation query subscription schema introspection variable directive fragment operation
bullmq queue worker job stalled delayed repeat lock renew concurrency drained completed failed active waiting
apollo express middleware router handler request response header body payload status code method route path
certificate handshake protocol version negotiation cipher hostname dns lookup
memory heap allocation limit exceeded quota rate throttled
undefined null nan infinity object array string number boolean function symbol property method argument arguments
error err message name cause code errno syscall address port family
`.trim().split(/\s+/)

function genera() {
  const parole = new Set(NUCLEO.filter((w) => !MAI.has(w)))
  let quantiFile = 0
  for (const albero of ALBERI) {
    for (const f of file(join(RADICE, albero))) {
      quantiFile++
      for (const p of paroleDi(readFileSync(f, 'utf8'))) parole.add(p)
    }
  }
  const ordinate = [...parole].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : a < b ? -1 : 1))
  return { ordinate, quantiFile }
}

function modulo(ordinate, quantiFile) {
  const righe = []
  for (let i = 0; i < ordinate.length; i += 12) {
    righe.push(`  ${ordinate.slice(i, i + 12).map((w) => `'${w}'`).join(', ')},`)
  }
  return `/**
 * IL VOCABOLARIO DEI LOG — FILE GENERATO, non si modifica a mano.
 *
 * Lo produce \`scripts/genera-vocabolario-log.mjs\`; \`pnpm check:vocabolario\`
 * fallisce se questo file e i sorgenti non dicono la stessa cosa.
 *
 * A che serve: nel template che finisce in \`:ServerLogEntry\` — l'unico
 * archivio del prodotto che attraversa il perimetro fra i clienti —
 * sopravvive SOLO una parola che sta qui dentro. Ogni altra diventa
 * \`<w>\`. È l'inversione decisa il 20 set 2026: da lista di cattivi
 * (nove regole di forma, cieche davanti a un cognome) a lista di buoni.
 *
 * Le parole vengono dai letterali di stringa del repository, esclusi i
 * test e i commenti — il codice non contiene i dati dei clienti, i test e
 * gli esempi d'uso sì (è lì che vivono «Mario Rossi» e «Banca Sella»).
 * Più un nucleo scritto a mano con il lessico d'errore di Node, ioredis,
 * Neo4j, BullMQ e Apollo, che nei nostri letterali non c'è ma nei nostri
 * stack sì.
 *
 * LA MAIUSCOLA CONTA: le forme sono esatte. Molti cognomi italiani sono
 * anche parole comuni («Costa», «Conti», «Greco»), e una lista tutta
 * minuscola li lascerebbe passare appena compaiono maiuscoli in mezzo a
 * una frase — che è come compare un cognome. Vedi \`sopravvive()\` in
 * \`serverLogScrub.ts\` per la regola che li confronta.
 *
 * Parole: ${String(ordinate.length)} — da ${String(quantiFile)} file.
 */

/** Le parole che possono sopravvivere in un template di piattaforma, nella LORO forma. */
export const VOCABOLARIO_DEI_LOG: ReadonlySet<string> = new Set([
${righe.join('\n')}
])
`
}

const { ordinate, quantiFile } = genera()
const atteso = modulo(ordinate, quantiFile)

if (process.argv.includes('--check')) {
  let attuale = ''
  try { attuale = readFileSync(USCITA, 'utf8') } catch { /* manca: è un errore */ }
  if (attuale !== atteso) {
    console.error('✗ vocabolario dei log non allineato ai sorgenti.')
    console.error('  Rigeneralo:  node scripts/genera-vocabolario-log.mjs')
    process.exit(1)
  }
  console.log(`✓ vocabolario dei log allineato (${String(ordinate.length)} parole)`)
} else {
  writeFileSync(USCITA, atteso)
  console.log(`✓ scritto ${relative(RADICE, USCITA)} — ${String(ordinate.length)} parole da ${String(quantiFile)} file`)
}
