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
 * PERIMETRO (20 set 2026: allargato). Le query scritte per intero si mandano
 * tutte in EXPLAIN. Quelle COMPOSTE con `${...}` restavano fuori — 368, e da
 * quel buco è passato il difetto del `WITH` di `assignTeamCypher`, che
 * tagliava una variabile letta prima. Adesso si risolvono, ma solo dove è
 * lecito essere certi:
 *
 *   - `${nomeFunzione(argomenti letterali)}` con la funzione esportata da un
 *     sorgente di questo repo: si IMPORTA e si CHIAMA sul serio;
 *   - `${identificatore}` in posizione di etichetta o di tipo di relazione.
 *
 * Il resto resta fuori e si dice perché, motivo per motivo. La strada ovvia —
 * un segnaposto al posto di ogni `${...}` — è sbagliata e vale la pena
 * scrivere il motivo: verificherebbe una query DIVERSA da quella vera, e un
 * guardiano che dice «valida» dopo aver guardato un'altra cosa è peggio di
 * uno che tace. Con un segnaposto, proprio il difetto che ha allargato questo
 * perimetro sarebbe risultato valido.
 *
 * Uso: node scripts/check-cypher.mjs [--verbose] [--composte] [--dump]
 * `--composte` elenca le forme di interpolazione per frequenza.
 * Richiede il Neo4j dello stack locale in piedi (container `infra-neo4j-1`).
 */
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs'
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
const formeComposte = new Map()
const composteDettaglio = []
/** I compositori che restano fuori solo perché non sono esportati: si dicono per nome. */
const nonEsportate = new Set()
const daRisolvere = []
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
      if (t.includes('${')) {
        composte++
        daRisolvere.push({ file: relative(ROOT, file), assoluto: file, query: t })
        // Le forme di interpolazione, per poterle guardare invece che contarle.
        for (const m of t.matchAll(/\$\{([^}]*)\}/g)) {
          const forma = m[1].trim().slice(0, 60)
          const chiave = /^[A-Za-z_][A-Za-z0-9_]*\s*\(/.test(forma) ? forma.replace(/\(.*$/, '()') : '<espressione>'
          formeComposte.set(chiave, (formeComposte.get(chiave) ?? 0) + 1)
        }
        composteDettaglio.push({ file: relative(ROOT, file), query: t.trim() })
        continue
      }
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

/*
 * ── LE QUERY COMPOSTE, RISOLTE PER DAVVERO ─────────────────────────────────
 *
 * Fino al 20 set 2026 qui c'era una resa: le query con `${…}` si contavano e
 * si dichiaravano fuori perimetro. Da quel buco è passato il difetto del
 * `WITH` di `assignTeamCypher`, che tagliava una variabile letta prima e
 * faceva fallire la query solo a tempo di esecuzione.
 *
 * La strada ovvia — mettere un segnaposto al posto di ogni `${…}` — è
 * SBAGLIATA, e vale la pena scrivere perché: produrrebbe una query DIVERSA da
 * quella vera, e un guardiano che dice «verificata» dopo aver verificato
 * un'altra cosa è peggio di uno che tace. Con un segnaposto al posto del
 * frammento, proprio il difetto di stamattina sarebbe risultato valido.
 *
 * Quindi si risolve solo ciò di cui è lecito essere certi, e sono due casi:
 *
 *  1. `${nomeFunzione(argomenti letterali)}` dove la funzione è esportata da
 *     un sorgente di questo repo: si IMPORTA e si CHIAMA (scripts/cypher-fragment.mts,
 *     sotto tsx, sui sorgenti e non su `dist`). Quello che torna è il testo
 *     vero, non una sua imitazione.
 *  2. `${identificatore}` subito dopo un `:` — cioè in posizione di etichetta
 *     o di tipo di relazione. Lì qualunque nome valido va bene: EXPLAIN non
 *     pretende che l'etichetta esista.
 *
 * Tutto il resto — un WHERE costruito, un elenco di campi, una condizione —
 * resta fuori, e si dice quante sono e perché. Una query si verifica solo se
 * TUTTE le sue interpolazioni sono risolte: una sola non risolta e la query
 * intera resta fuori.
 */

/** Gli span `${…}` di un template, con le graffe bilanciate (dentro ci sono oggetti). */
function interpolazioni(t) {
  const out = []
  for (let i = 0; i < t.length - 1; i++) {
    if (t[i] !== '$' || t[i + 1] !== '{') continue
    let prof = 1
    let j = i + 2
    for (; j < t.length && prof > 0; j++) {
      if (t[j] === '{') prof++
      else if (t[j] === '}') prof--
    }
    if (prof !== 0) return null                    // template malformato: non si tocca
    out.push({ inizio: i, fine: j, testo: t.slice(i + 2, j - 1) })
    i = j - 1
  }
  return out
}

/**
 * Gli argomenti di una chiamata, SOLO se sono tutti letterali.
 *
 * Il test è il parse: si porta il testo a JSON (chiavi nude fra virgolette,
 * apici in virgolette) e si prova. Se passa, dentro non c'era nient'altro che
 * letterali — niente variabili, niente chiamate, niente da valutare. Se non
 * passa, la query resta fuori perimetro: meglio non verificarla che chiamare
 * una funzione con argomenti inventati.
 */
function argomentiLetterali(testo) {
  const grezzo = testo.trim()
  if (grezzo === '') return []
  const jsonish = ('[' + grezzo + ']')
    .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":')
    .replace(/'([^'\\]*)'/g, '"$1"')
  try {
    const v = JSON.parse(jsonish)
    return Array.isArray(v) ? v : null
  } catch { return null }
}

/** Nome della funzione → file che la esporta. */
const compositori = new Map()
for (const dir of SCAN) {
  for (const file of walk(dir)) {
    if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue
    for (const m of readFileSync(file, 'utf8').matchAll(/export function ([A-Za-z0-9_]+)\s*\(/g)) {
      compositori.set(m[1], file)
    }
  }
}


// ── LE COSTANTI DEL MODULO ────────────────────────────────────────────────────
/**
 * UN PEZZO DI QUERY CHE VIVE IN UNA COSTANTE (22 set 2026).
 *
 * Duecentoquindici query restavano fuori perimetro per «identificatore in
 * posizione non riconosciuta»: dentro il template c'era `${NOME}`, e il
 * lettore non sapeva che cosa fosse. Guardandoli uno per uno, la maggior parte
 * non erano variabili di giro ma COSTANTI del modulo — pezzi di Cypher scritti
 * una volta e riusati:
 *
 *     const CHANGE_NOT_DELETED = 'coalesce(c.deleted, false) = false'
 *     export const EVENT_ROW_RETURN = `RETURN ${EVENT_ROW_KEYS.join(', ')}`
 *
 * Sono esattamente ciò che si vuole verificare, ed erano l'unica cosa che
 * impediva a quelle query di ricevere un EXPLAIN. Adesso si leggono: dal file
 * stesso, e dal file da cui sono importate.
 *
 * ## Quello che NON si risolve, di proposito
 * Una costante il cui valore contiene a sua volta un `${…}` che non si è
 * saputo sciogliere: sostituirla darebbe a Neo4j un testo con dentro le graffe
 * di JavaScript, cioè un errore inventato da noi su una query sana. E niente
 * che non sia un `const` di primo livello: una variabile di giro (`where`,
 * `whereClause`, `sets.join(', ')`) è costruita a tempo di esecuzione, e
 * indovinarne il valore sarebbe verificare una query che nessuno esegue.
 */

/** Il valore di un letterale che comincia a `da`, o `null`. Gestisce ', " e i template. */
function letteraleDa(testo, da) {
  const apre = testo[da]
  if (apre !== "'" && apre !== '"' && apre !== '`') return null
  let out = ''
  for (let i = da + 1; i < testo.length; i++) {
    const ch = testo[i]
    if (ch === '\\') { out += testo[i + 1] ?? ''; i++; continue }
    if (ch === apre) return { valore: out, fine: i + 1 }
    out += ch
  }
  return null
}

/** `const NOME = <letterale>` e `const NOME = { chiave: <letterale>, … }` di un file. */
function costantiDelFile(file) {
  const memo = costantiDelFile.memo ?? (costantiDelFile.memo = new Map())
  if (memo.has(file)) return memo.get(file)
  const fuori = new Map()
  let testo
  try { testo = readFileSync(file, 'utf8') } catch { memo.set(file, fuori); return fuori }

  /*
   * SENZA SPAZI DAVANTI: solo il PRIMO LIVELLO del modulo.
   *
   * La prima versione accettava un `const` a qualunque rientro, quindi
   * prendeva anche quelli DENTRO le funzioni — `const where = ''`,
   * `const whereClause = …` — che sono esattamente i valori di giro che qui
   * non si vogliono indovinare. Il risultato si e' visto subito: query
   * ricostruite come `MATCH (e:Event) WHERE` e `WHERE ( AND m.tenant_id = …`,
   * cioe' errori inventati da noi su query sane.
   */
  for (const m of testo.matchAll(/(?:^|\n)(?:export\s+)?const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*/g)) {
    const nome = m[1]
    const da = m.index + m[0].length
    const lit = letteraleDa(testo, da)
    if (lit) { fuori.set(nome, lit.valore); continue }
    // Un oggetto di letterali: `{ A: 'x', B: 'y' }`, anche con `as const`.
    if (testo[da] !== '{') continue
    const chiude = testo.indexOf('}', da)
    if (chiude < 0) continue
    const corpo = testo.slice(da + 1, chiude)
    if (corpo.includes('{')) continue
    for (const c of corpo.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:\s*('[^']*'|"[^"]*"|`[^`$]*`)/g)) {
      fuori.set(`${nome}.${c[1]}`, c[2].slice(1, -1))
    }
  }
  memo.set(file, fuori)
  return fuori
}

/** `import { A, B } from './x.js'` → nome importato → file sorgente vero. */
function importazioniDelFile(file) {
  const memo = importazioniDelFile.memo ?? (importazioniDelFile.memo = new Map())
  if (memo.has(file)) return memo.get(file)
  const fuori = new Map()
  let testo
  try { testo = readFileSync(file, 'utf8') } catch { memo.set(file, fuori); return fuori }
  for (const m of testo.matchAll(/import\s*\{([^}]*)\}\s*from\s*'([^']+)'/g)) {
    const da = m[2]
    // Solo i moduli RELATIVI: un pacchetto del workspace passerebbe per il
    // suo `dist`, che è generato e può essere vecchio.
    if (!da.startsWith('.')) continue
    const sorgente = resolve(dirname(file), da.replace(/\.js$/, '.ts'))
    if (!existsSync(sorgente)) continue
    for (const nome of m[1].split(',')) {
      const pulito = nome.trim().split(/\s+as\s+/)[0]?.trim()
      if (pulito) fuori.set(pulito, sorgente)
    }
  }
  memo.set(file, fuori)
  return fuori
}

/**
 * Il valore di `${NOME}` o `${OGGETTO.CHIAVE}` visto da `file`, o `null`.
 * Un solo salto: la costante sta nel file o nel file da cui è importata.
 */
function valoreDellaCostante(file, nome) {
  const qui = costantiDelFile(file)
  if (qui.has(nome)) return qui.get(nome)
  const importate = importazioniDelFile(file)
  const radice = nome.split('.')[0]
  const altrove = importate.get(radice)
  if (!altrove) return null
  const la = costantiDelFile(altrove)
  return la.has(nome) ? la.get(nome) : null
}

/** L'etichetta che si mette al posto di un `${…}` in posizione di etichetta. */
const ETICHETTA_FINTA = 'Incident'

/**
 * Se l'interpolazione che comincia a `pos` sta in posizione di ETICHETTA o di
 * tipo di relazione — `(n:${x})`, `(:${x})`, `[r:${x}]`, `:A|:${x}` — e non in
 * posizione di valore dentro una mappa di proprietà, `{id: ${x}}`.
 *
 * La prima versione guardava solo «il carattere prima è `:`», e la prima
 * corsa ha prodotto un falso positivo su `CREATE (:EventHistoryEntry {id:
 * ${f.id}, …})`: là i due punti separano una chiave dal suo valore, e
 * mettendoci un'etichetta la query diventava assurda. Un guardiano che alza
 * un errore su una query sana è peggio di uno che tace, quindi la regola è
 * diventata stretta: si risale il `:`, si salta l'eventuale nome di
 * variabile, e quello che resta deve aprire un pattern — `(`, `[` o `|`.
 */
function inPosizioneDiEtichetta(query, pos) {
  let prima = query.slice(0, pos).replace(/\s+$/, '')
  if (!prima.endsWith(':')) return false
  prima = prima.slice(0, -1).replace(/\s+$/, '')          // via i due punti
  prima = prima.replace(/[A-Za-z_][A-Za-z0-9_]*$/, '')    // via il nome della variabile, se c'è
  prima = prima.replace(/\s+$/, '')
  const ultimo = prima[prima.length - 1]
  return ultimo === '(' || ultimo === '[' || ultimo === '|'
}

const nonRisolte = new Map()   // motivo → quante
const risolvibili = []         // { file, pezzi, chiamate }
for (const c of daRisolvere) {
  const spans = interpolazioni(c.query)
  if (!spans) { nonRisolte.set('template malformato', (nonRisolte.get('template malformato') ?? 0) + 1); continue }
  const pezzi = []
  const chiamate = []
  let resa = null
  let ultimo = 0
  for (const sp of spans) {
    pezzi.push({ tipo: 'testo', valore: c.query.slice(ultimo, sp.inizio) })
    ultimo = sp.fine
    const testo = sp.testo.trim()

    const chiamata = /^([A-Za-z_][A-Za-z0-9_]*)\s*\(([\s\S]*)\)$/.exec(testo)
    if (chiamata && compositori.has(chiamata[1])) {
      const args = argomentiLetterali(chiamata[2])
      if (args === null) { resa = 'argomenti non letterali'; break }
      pezzi.push({ tipo: 'chiamata', indice: chiamate.length })
      chiamate.push({ file: compositori.get(chiamata[1]), fn: chiamata[1], args })
      continue
    }
    if (chiamata) {
      resa = 'funzione non esportata dai sorgenti'
      // Il NOME serve: «8 funzioni non esportate» non dice quali esportare.
      nonEsportate.add(`${chiamata[1]}  @ ${c.file}`)
      break
    }

    if (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(testo) && inPosizioneDiEtichetta(c.query, sp.inizio)) {
      pezzi.push({ tipo: 'testo', valore: ETICHETTA_FINTA })
      continue
    }

    // Una costante del modulo (o importata da un file vicino): è un pezzo di
    // query scritto una volta e riusato, ed è ciò che si vuole verificare.
    if (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(testo)) {
      const valore = valoreDellaCostante(c.file, testo)
      // Se il valore porta a sua volta un `${…}` non si sostituisce: darebbe a
      // Neo4j le graffe di JavaScript, cioè un errore inventato da noi.
      if (valore != null && !valore.includes('${')) {
        pezzi.push({ tipo: 'testo', valore })
        continue
      }
    }
    resa = /^[A-Za-z_][A-Za-z0-9_.]*$/.test(testo)
      ? 'identificatore in posizione non riconosciuta'
      : 'espressione da valutare'
    break
  }
  if (resa) { nonRisolte.set(resa, (nonRisolte.get(resa) ?? 0) + 1); continue }
  pezzi.push({ tipo: 'testo', valore: c.query.slice(ultimo) })
  risolvibili.push({ file: c.file, pezzi, chiamate })
}

/** Chiama i compositori: UN processo `tsx` per tutte le chiamate di tutte le query. */
function risolviFrammenti(richieste) {
  if (richieste.length === 0) return []
  // `.bin/tsx` è uno script di shell, non un file JS: si esegue, non si dà in pasto a `node`.
  const out = execFileSync(join(ROOT, 'node_modules', '.bin', 'tsx'), [join(ROOT, 'scripts', 'cypher-fragment.mts')], {
    input: JSON.stringify(richieste), encoding: 'utf8', cwd: ROOT, maxBuffer: 64 * 1024 * 1024,
    /*
     * Un tetto al tempo: importare i moduli dell'API accende code e driver, e
     * un import che si impianta non deve appendere il guardiano. Scaduto il
     * tempo, le composte restano fuori perimetro e lo si dice — che è il
     * comportamento di prima, non un silenzio.
     */
    timeout: 180_000,
  })
  return JSON.parse(out)
}

const composteRisolte = []
if (risolvibili.length > 0) {
  const tutte = []
  for (const r of risolvibili) for (const ch of r.chiamate) tutte.push(ch)
  let risposte
  try {
    risposte = risolviFrammenti(tutte)
  } catch (e) {
    console.error(`check-cypher: non sono riuscito a risolvere i frammenti — ${e instanceof Error ? e.message : String(e)}`)
    process.exit(2)
  }
  let k = 0
  for (const r of risolvibili) {
    const mie = risposte.slice(k, k + r.chiamate.length)
    k += r.chiamate.length
    const rotta = mie.find((x) => !x.ok)
    if (rotta) { nonRisolte.set('il compositore ha alzato', (nonRisolte.get('il compositore ha alzato') ?? 0) + 1); continue }
    const query = r.pezzi.map((p) => p.tipo === 'testo' ? p.valore : mie[p.indice].cypher).join('')
    if (query.includes('${')) {
      // Un frammento che porta dentro un'altra interpolazione: non si finge
      // di averla risolta.
      nonRisolte.set('il frammento contiene altre interpolazioni', (nonRisolte.get('il frammento contiene altre interpolazioni') ?? 0) + 1)
      continue
    }
    composteRisolte.push({ file: r.file + ' (composta)', query })
  }
}

let rotte = []
let frammenti = 0
let nonAttribuito = null
try {
  ;({ rotte, frammenti, nonAttribuito } = spiega([...intere, ...composteRisolte]))
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
if (process.argv.includes('--composte')) {
  console.log('\nLe forme di interpolazione nelle query composte, per frequenza:')
  for (const [forma, n] of [...formeComposte.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${forma}`)
  }
}

const fuoriPerimetro = [...nonRisolte.entries()].sort((a, b) => b[1] - a[1])
const totaleFuori = fuoriPerimetro.reduce((n, [, q]) => n + q, 0)

console.log(
  `check-cypher: ${intere.length + composteRisolte.length - frammenti} query verificate con EXPLAIN, tutte valide`
  + ` (${composteRisolte.length} delle quali COMPOSTE, risolte chiamando i compositori veri);`
  + ` nessun tetto parametrico.`
  + ` Fuori perimetro: ${totaleFuori} composte su ${composte}, ${esempi} esempi nei commenti,`
  + ` ${frammenti} pezzi di query che si concludono altrove.`,
)
if (totaleFuori > 0) {
  /*
   * Le non risolte si ELENCANO col motivo, non si contano e basta: «368
   * composte» era un numero che non diceva su cosa lavorare. Un motivo dice
   * anche quale pezzo di guardiano varrebbe la pena costruire dopo.
   */
  console.log('  Perché restano fuori:')
  for (const [motivo, quante] of fuoriPerimetro) console.log(`    ${String(quante).padStart(4)}  ${motivo}`)
  if (nonEsportate.size > 0) {
    console.log('  Basterebbe ESPORTARLE per farle entrare nel perimetro:')
    for (const f of [...nonEsportate].sort()) console.log(`    ${f}`)
  }
}

/*
 * IL CRICCHETTO: il buco può solo rimpicciolirsi (22 set 2026).
 *
 * Questo controllo diceva da sempre quante query restano fuori dal suo
 * sguardo, e nessuno gliene chiedeva conto: il numero poteva crescere a ogni
 * commit senza che niente diventasse rosso. Ed è il numero che conta davvero,
 * perché una query fuori perimetro non riceve nemmeno il controllo del
 * `tenant_id` — l'invariante più importante del prodotto.
 *
 * Adesso il tetto è scritto qui. Una query composta in più lo supera e questo
 * controllo diventa rosso: chi la aggiunge sceglie fra renderla verificabile
 * (un letterale, oppure un compositore ESPORTATO, che questo script sa
 * chiamare) e alzare il tetto DICENDO perché.
 *
 * Il tetto si abbassa quando si guadagna terreno. Non si alza per far passare
 * la giornata.
 */
const TETTO_FUORI_PERIMETRO = 201
if (totaleFuori > TETTO_FUORI_PERIMETRO) {
  console.error(`\ncheck-cypher: le query fuori perimetro sono ${totaleFuori}, il tetto è ${TETTO_FUORI_PERIMETRO}.`)
  console.error('Una query che questo controllo non vede non riceve nemmeno la verifica del tenant_id.')
  console.error('Rendila verificabile — scrivila come letterale, o ESPORTA il compositore che la costruisce —')
  console.error('oppure alza il tetto in scripts/check-cypher.mjs spiegando perché.')
  process.exit(1)
}
if (totaleFuori < TETTO_FUORI_PERIMETRO) {
  console.log(`  (il tetto è ${TETTO_FUORI_PERIMETRO}: se ne sono guadagnate ${TETTO_FUORI_PERIMETRO - totaleFuori}, abbassalo)`)
}
