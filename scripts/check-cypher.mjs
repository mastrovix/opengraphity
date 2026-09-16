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
import { readFileSync, readdirSync, statSync } from 'node:fs'
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
const sembraQuery = (t) => PAROLE_CYPHER.test(t) && t.includes('(') && t.trim().length > 24

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
    const src = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    if (!src.includes('`')) continue
    for (const t of templates(src)) {
      if (!sembraQuery(t)) continue
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
    { input: script, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
  } catch (e) {
    if (e.status === undefined) throw e            // docker non c'e: lo dice il chiamante
    uscita = String(e.stdout ?? '')
  }
  // Si cammina l'uscita in ordine: ogni marcatore chiude la query di quell'indice.
  const rotte = []
  let i = 0
  for (const riga of uscita.split('\n')) {
    const m = /§CC§(\d+)/.exec(riga)
    if (m) { i = Number(m[1]) + 1; continue }
    if (/Invalid input|SyntaxError|Neo\.ClientError\.Statement\.SyntaxError/.test(riga)) {
      const q = queries[i]
      if (q && !rotte.some((r) => r.file === q.file && r.query === q.query)) {
        rotte.push({ ...q, errore: riga.trim().slice(0, 150) })
      }
    }
  }
  return rotte
}

let rotte = []
try {
  rotte = spiega(intere)
} catch (e) {
  console.error(`check-cypher: Neo4j non raggiungibile nel container "${CONTAINER}" (${e instanceof Error ? e.message : String(e)}).`)
  console.error('Questo controllo ha bisogno dello stack locale in piedi: `docker compose -f infra/docker-compose.yml up -d neo4j`.')
  process.exit(2)
}

if (process.argv.includes('--dump')) {
  for (const q of intere) console.log('---\n' + suUnaRiga(q.query) + '\n    @ ' + q.file)
}
if (verbose) for (const q of intere) console.log(`  ${q.file}: ${q.query.slice(0, 70).replace(/\s+/g, ' ')}…`)

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
console.log(`check-cypher: ${intere.length} query scritte per intero, tutte valide (EXPLAIN). Fuori perimetro: ${composte} composte con \${…}, ${esempi} esempi nei commenti.`)
