#!/usr/bin/env node
/**
 * OGNI QUERY CYPHER SCRITTA PER INTERO DEVE ESSERE VALIDA.
 *
 * Da dove viene questo guardiano: riscrivendo una lettura per farle usare
 * l'unione di etichette era rimasto un `OR e:Change` PENZOLANTE dopo il
 * pattern — Cypher non valido. Il motore SLA lanciava a ogni evento, e per un
 * giorno intero NESSUN ticket ha ricevuto uno SLA. Non l'ha visto nessuno:
 * TypeScript non guarda dentro una stringa, i test di quel modulo simulano la
 * funzione che contiene la query, e un giro nel browser che apre le pagine non
 * esegue un consumer in background. L'ha trovato il primo giro che ha creato
 * un ticket davvero.
 *
 * Come funziona: si estraggono i template Cypher dai sorgenti e si manda
 * `EXPLAIN` a Neo4j, che ANALIZZA e pianifica senza eseguire — e senza bisogno
 * dei parametri. Una query che non si parsa è un errore.
 *
 * PERIMETRO DICHIARATO: solo le query scritte per intero. Quelle composte con
 * `${...}` (un WHERE costruito, un'etichetta che viene dal metamodello del
 * cliente) non esistono finché non si sa cosa ci va dentro, e qui non si
 * possono giudicare: si contano e si dice quante sono. Il difetto che ha fatto
 * nascere questo controllo era in una query scritta per intero.
 *
 * Uso: node scripts/check-cypher.mjs [--verbose]
 * Richiede il Neo4j dello stack locale in piedi (container `infra-neo4j-1`).
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CONTAINER = process.env['NEO4J_CONTAINER'] ?? 'infra-neo4j-1'
const verbose = process.argv.includes('--verbose')

const SCAN = [
  join(ROOT, 'apps', 'api', 'src'),
  ...readdirSync(join(ROOT, 'packages'))
    .map((p) => join(ROOT, 'packages', p, 'src'))
    .filter(esiste),
]

function esiste(p) { try { statSync(p); return true } catch { return false } }

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules' || entry === 'dist') continue
      yield* walk(full)
    } else if (/\.ts$/.test(entry) && !/\.(test|spec)\.ts$/.test(entry)) {
      yield full
    }
  }
}

/**
 * Cosa conta come QUERY. Una parola di Cypher non basta: nel codice ci sono
 * frammenti che valgono una parola sola (`\`MERGE\`` passato come argomento
 * per comporre una scrittura) e non sono query. Servono anche un pattern fra
 * parentesi e un minimo di lunghezza.
 */
const PAROLE_CYPHER = /\b(MATCH|MERGE|CREATE|OPTIONAL MATCH|DETACH DELETE|UNWIND|CALL \{)\b/
/**
 * UN FRAMMENTO NON E UNA QUERY (20 set 2026).
 *
 * Alcuni template sono PEZZI che vengono concatenati altrove: cominciano con
 * `OPTIONAL MATCH`, `RETURN`, `WITH`, e citano variabili legate dalla parte
 * che li precede. Mandarli a EXPLAIN da soli produce «Variable `c` not
 * defined» — un errore vero su una query che non esiste, cioe rumore.
 *
 * La regola: una query intera COMINCIA con una clausola che puo cominciare.
 * Finche il guardiano riconosceva solo gli errori di sintassi la cosa non si
 * vedeva, perche quegli errori erano semantici e passavano inosservati
 * insieme a tutti gli altri.
 */
const INIZIO_DI_QUERY = /^\s*(?:\/\/[^\n]*\n\s*)*(MATCH|MERGE|CREATE|UNWIND|CALL|EXPLAIN|PROFILE|SHOW|DROP|ALTER)\b/i
const sembraQuery = (t) => PAROLE_CYPHER.test(t) && t.includes('(') && t.trim().length > 24 && INIZIO_DI_QUERY.test(t)

/**
 * QUALI RIGHE DELL'USCITA SONO UN ERRORE (20 set 2026).
 *
 * Prima qui c'era `/Invalid input|SyntaxError|…SyntaxError/`: solo la
 * SINTASSI. Un errore SEMANTICO — «Type mismatch: expected Float but was
 * List<Float>», che EXPLAIN rifiuta eccome — non corrispondeva a nessuno dei
 * tre, e il guardiano stampava «tutte valide» con la query rotta sotto il
 * naso. Preso sul fatto una seconda volta, il 20 set, scrivendo gli aggregati
 * del lavoro quotidiano: `percentileCont` e una funzione di aggregazione e
 * non accetta una lista, Neo4j lo diceva, e questo controllo taceva.
 *
 * La lezione e la stessa della prima volta, un piano piu in la: non basta che
 * il guardiano guardi nel posto giusto, deve RICONOSCERE quello che vede.
 */
const ERRORE_DI_NEO4J = /Invalid input|SyntaxError|SemanticError|Type mismatch|Neo\.ClientError\.Statement\.|Unknown function|not defined|Expected/

/**
 * VIA I COMMENTI A BLOCCO, MA NON QUELLO CHE STA IN UNA STRINGA (17 set 2026).
 *
 * Prima era una `replace` con una regex, e `/*` dentro una stringa apriva un
 * finto commento: tutto fino al primo `*\/` veniva mangiato, la parita dei
 * backtick si spostava, e l'estrattore costruiva una "query" fatta di codice.
 * Visto dal vivo su `lib/tenantOnboarding.ts`, dove i redirect di Keycloak
 * contengono il jolly — `https://${slug}.${domain}/*`. Il guardiano diceva «una
 * query non valida» indicando una riga che query non era: chi lo legge impara a
 * non fidarsi.
 *
 * Qui si cammina sul sorgente sapendo dove si e: dentro una stringa (apice,
 * doppio apice, backtick) o dentro un commento di riga, un `/*` e testo.
 */
function senzaCommentiABlocco(src) {
  let out = ''
  let i = 0
  while (i < src.length) {
    const c = src[i]
    // Stringhe: si salta fino alla chiusura, rispettando gli escape.
    if (c === "'" || c === '"' || c === '`') {
      const fine = (() => {
        for (let j = i + 1; j < src.length; j++) {
          if (src[j] === '\\') { j++; continue }
          if (src[j] === c) return j
          // Un apice singolo o doppio non attraversa la riga: se ci arriva, non
          // era una stringa (un apostrofo in un commento di riga, per esempio).
          if (c !== '`' && src[j] === '\n') return -1
        }
        return -1
      })()
      if (fine === -1) { out += c; i++; continue }
      out += src.slice(i, fine + 1)
      i = fine + 1
      continue
    }
    // Commento di riga: resta (un `http://` in una stringa non si deve rompere).
    if (c === '/' && src[i + 1] === '/') {
      const fine = src.indexOf('\n', i)
      const stop = fine === -1 ? src.length : fine
      out += src.slice(i, stop)
      i = stop
      continue
    }
    // Commento a blocco: via, ed e il solo caso in cui si butta qualcosa.
    if (c === '/' && src[i + 1] === '*') {
      const fine = src.indexOf('*/', i + 2)
      i = fine === -1 ? src.length : fine + 2
      continue
    }
    out += c
    i++
  }
  return out
}

/**
 * I template del file. Si prendono i letterali con i backtick, dal delimitatore
 * al suo compagno, saltando quelli annidati in un'espressione `${...}`.
 */
function templates(src) {
  const out = []
  for (let i = 0; i < src.length; i++) {
    if (src[i] !== '`') continue
    let j = i + 1, prof = 0
    for (; j < src.length; j++) {
      if (src[j] === '\\') { j++; continue }
      if (src[j] === '$' && src[j + 1] === '{') { prof++; j++; continue }
      if (prof > 0) { if (src[j] === '}') prof--; continue }
      if (src[j] === '`') break
    }
    /**
     * Il backtick apre dopo un `//` sulla stessa riga: e un esempio in un
     * commento di riga, non codice. (I commenti a blocco sono gia spariti; i
     * commenti di riga NO, per non rompere un `http://` dentro una stringa.)
     */
    const inizioRiga = src.lastIndexOf('\n', i) + 1
    const prima = src.slice(inizioRiga, i)
    if (!prima.includes('//')) out.push(src.slice(i + 1, j))
    i = j
  }
  return out
}

const intere = []
/**
 * SECONDO CONTROLLO, tutto testuale: un tetto passato come PARAMETRO.
 *
 * `LIMIT $max` con un numero JS arriva a Neo4j come FLOAT, e `LIMIT` vuole un
 * INTEGER: la query esplode a runtime con «'200.0' is not a valid value».
 * EXPLAIN non lo vede (i parametri non ci sono), un test con un driver finto
 * nemmeno (il tipo lo rifiuta il server), e l'errore arriva quindi in
 * produzione — è arrivato: ha spento l'intera pagina di diagnostica il 17 set
 * 2026. La forma giusta è interpolare la costante nel template.
 */
const tettiParametrici = []
let composte = 0
let esempi = 0
for (const dir of SCAN) {
  for (const file of walk(dir)) {
    /**
     * I commenti a blocco spariscono PRIMA dell'estrazione: e li che vivono gli
     * esempi scritti in prosa (`MERGE (e {name, tenant_id: $x})`, una
     * scorciatoia che Cypher non accetta e che nessuno esegue). Restano i
     * commenti di riga, cosi un `http://` dentro una stringa non si rompe.
     */
    const src = senzaCommentiABlocco(readFileSync(file, 'utf8'))
    if (!src.includes('`')) continue
    for (const t of templates(src)) {
      if (!sembraQuery(t)) continue
      // Prima dello scarto delle composte: una query composta ha lo stesso
      // problema, e il controllo e testuale — non ha bisogno di EXPLAIN.
      const tetto = /\b(LIMIT|SKIP)\s+\$([A-Za-z_][A-Za-z0-9_]*)/i.exec(t)
      if (tetto) tettiParametrici.push({ file: relative(ROOT, file), clausola: `${tetto[1].toUpperCase()} $${tetto[2]}` })
      if (t.includes('${')) { composte++; continue }
      /**
       * Un ESEMPIO dentro un commento, non una query. Si riconosce da tre
       * segni: i puntini di sospensione, un segnaposto fra parentesi angolari,
       * o una riga che comincia con l'asterisco di continuazione di un
       * commento a blocco — quello finisce dentro il testo e Neo4j lo legge
       * come un moltiplicatore.
       */
      if (/[…]|<[a-z]+>/.test(t) || /^\s*\*\s/m.test(t)) { esempi++; continue }
      intere.push({ file: relative(ROOT, file), query: t.trim() })
    }
  }
}

/**
 * Una query su UNA riga, pronta per cypher-shell: i commenti `//` e i blocchi
 * `/* *\/` spariscono (appiattendo la query, un `//` mangerebbe tutto il
 * resto), e gli spazi diventano uno solo.
 */
/**
 * Le sequenze di escape del SORGENTE diventano quello che sono a runtime:
 * `\\d` nel file e `\d` nella query, `\n` e un a capo. Senza questo passaggio
 * una regex dentro una query sembrerebbe rotta a Neo4j e non lo e.
 */
function daSorgente(t) {
  return t.replace(/\\(.)/g, (_, c) => (
    c === 'n' ? '\n' : c === 't' ? '\t' : c === 'r' ? '\r' : c
  ))
}

function suUnaRiga(q) {
  return daSorgente(q)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').map((r) => r.replace(/\/\/.*$/, '')).join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Le manda tutte in un colpo, con un MARCATORE fra una e l'altra: cosi un
 * errore si attribuisce alla sua query, e quindi al suo file. Senza il
 * marcatore si saprebbe che qualcosa e rotto, non cosa — e un guardiano che
 * non dice dove guardare non lo usa nessuno.
 */
function spiega(queries) {
  const script = queries
    .map((q, i) => `EXPLAIN ${suUnaRiga(q.query)};\nRETURN '§CC§${i}' AS m;`)
    .join('\n')
  let uscita
  let uscitaMalata = false
  try {
    /**
     * `2>&1` NON e un dettaglio: gli errori vanno nell'errore standard e i
     * marcatori nell'uscita, e leggendoli separati l'ORDINE si perde — tutti i
     * marcatori prima, tutti gli errori dopo, e nessun errore si attribuisce
     * piu alla sua query. (Preso sul fatto: la prima versione di questo
     * guardiano diceva «tutte valide» con la query rotta sotto il naso.)
     */
    uscita = execFileSync('docker', ['exec', '-i', CONTAINER, 'sh', '-c',
      'cypher-shell -u neo4j -p "${NEO4J_AUTH#neo4j/}" --format plain --fail-at-end 2>&1'],
    {
      input: script, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
      /*
       * `maxBuffer` per prudenza, non per un difetto osservato (20 set 2026).
       * 1240 EXPLAIN producono ~9.900 righe di piano, circa 600 KB, e il
       * limite predefinito di `execFileSync` e UN megabyte: non e stato
       * superato, ma il margine e sottile e cresce col codice. Superandolo,
       * Node ucciderebbe il figlio e lo script leggerebbe l'uscita TRONCATA,
       * dichiarando valide query che non ha mai visto.
       */
      maxBuffer: 256 * 1024 * 1024,
    })
  } catch (e) {
    if (e.status === undefined) throw e            // docker non c'e: lo dice il chiamante
    uscita = String(e.stdout ?? '')
    uscitaMalata = true
  }
  // Si cammina l'uscita in ordine: ogni marcatore chiude la query di quell'indice.
  const rotte = []
  const frammenti = new Set()
  let i = 0
  let errori = 0
  for (const riga of uscita.split('\n')) {
    const m = /§CC§(\d+)/.exec(riga)
    if (m) { i = Number(m[1]) + 1; continue }
    /*
     * UN PEZZO DI QUERY, non una query rotta (20 set 2026). Alcuni template
     * cominciano con `MATCH` e NON finiscono: sono la prima meta di una query
     * che viene composta altrove, e Neo4j dice «Query cannot conclude with
     * MATCH». Non e un difetto del prodotto, e questo guardiano non puo
     * verificarli — quindi li CONTA e lo dice, invece di spacciarli per
     * errori o di tacerli.
     */
    if (/Query cannot conclude with/.test(riga)) { frammenti.add(i); continue }
    if (ERRORE_DI_NEO4J.test(riga)) {
      errori++
      const q = queries[i]
      if (q && !rotte.some((r) => r.file === q.file && r.query === q.query)) {
        rotte.push({ ...q, errore: riga.trim().slice(0, 150) })
      }
    }
  }
  /*
   * L'ULTIMA RETE: se cypher-shell è uscito male e non siamo riusciti ad
   * attribuire nemmeno un errore, questo guardiano NON dice «tutte valide».
   * Dice che non ha capito, e mostra l'uscita grezza.
   *
   * Senza, un errore di una classe che `ERRORE_DI_NEO4J` non conosce ancora
   * diventa silenzio — ed è esattamente il modo in cui un guardiano smette di
   * proteggere senza che nessuno se ne accorga.
   */
  if (uscitaMalata && errori === 0 && frammenti.size === 0) {
    if (process.env['CC_DUMP_USCITA']) writeFileSync('/tmp/cc-uscita.txt', uscita)
    return { rotte, frammenti: frammenti.size, nonAttribuito: uscita.split('\n').filter((r) => r.trim() !== '').slice(-12).join('\n') }
  }
  return { rotte, frammenti: frammenti.size, nonAttribuito: null }
}

let rotte = []
let frammenti = 0
let nonAttribuito = null
try {
  ;({ rotte, frammenti, nonAttribuito } = spiega(intere))
} catch (e) {
  /*
   * Un difetto DI QUESTO SCRIPT non si spaccia per «Neo4j irraggiungibile»:
   * chi legge andrebbe a controllare i container invece del codice. Si
   * distingue dal messaggio di docker.
   */
  const messaggio = e instanceof Error ? e.message : String(e)
  const eDocker = /docker|ENOENT|container|connection refused/i.test(messaggio)
  if (!eDocker) {
    console.error(`check-cypher: questo controllo si e rotto da solo — ${messaggio}`)
    process.exit(2)
  }
  console.error(`check-cypher: Neo4j non raggiungibile nel container "${CONTAINER}" (${messaggio}).`)
  console.error('Questo controllo ha bisogno dello stack locale in piedi: `docker compose -f infra/docker-compose.yml up -d neo4j`.')
  process.exit(2)
}

if (process.argv.includes('--dump')) {
  for (const q of intere) console.log('---\n' + suUnaRiga(q.query) + '\n    @ ' + q.file)
}
if (verbose) for (const q of intere) console.log(`  ${q.file}: ${q.query.slice(0, 70).replace(/\s+/g, ' ')}…`)

if (nonAttribuito) {
  console.error('check-cypher: Neo4j ha rifiutato qualcosa e non sono riuscito ad attribuirlo a una query.')
  console.error('Non dico «tutte valide» quando non ho capito. Uscita grezza (ultime righe):')
  console.error(nonAttribuito)
  process.exit(1)
}

if (rotte.length > 0) {
  console.error(`check-cypher: ${rotte.length} query NON valide (EXPLAIN le rifiuta):`)
  for (const r of rotte) {
    console.error(`  ${r.file}`)
    console.error(`    ${suUnaRiga(r.query).slice(0, 110)}`)
    console.error(`    → ${r.errore}`)
  }
  console.error('\nUna query che non si parsa non e mai stata eseguita: nessun test la copre.')
  process.exit(1)
}

if (tettiParametrici.length > 0) {
  console.error(`check-cypher: ${tettiParametrici.length} tetti passati come PARAMETRO (Neo4j li riceve come float e rifiuta la query):`)
  for (const t of tettiParametrici) console.error(`  ${t.file}\n    ${t.clausola}`)
  console.error('\nInterpola la costante nel template (`LIMIT ${MAX}`), come topology.ts e services.ts.')
  process.exit(1)
}
console.log(`check-cypher: ${intere.length - frammenti} query verificate con EXPLAIN, tutte valide; nessun tetto parametrico. Fuori perimetro: ${composte} composte con \${…}, ${esempi} esempi nei commenti, ${frammenti} pezzi di query che si concludono altrove.`)
