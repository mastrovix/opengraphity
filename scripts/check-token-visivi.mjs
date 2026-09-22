#!/usr/bin/env node
/**
 * I TOKEN VISIVI DELLA CONSOLE NON SI SCOLLANO DAL PORTALE (22 set 2026).
 *
 * ## Il debito, e perché era invisibile
 * `apps/console/src/index.css` porta i token del portale COPIATI, e lo dice:
 *
 *   «I token sono copiati e non importati perché le due app non condividono un
 *    foglio di stile: packages/web-core porta il codice, non il CSS. Copiarli è
 *    un debito piccolo e dichiarato — se un giorno il brand cambia, cambia in
 *    due posti, e questa riga dice dove.»
 *
 * Dichiarato sì, ma la dichiarazione è una frase: non impedisce niente. Il
 * giorno in cui il brand cambia nel portale e non nella console, tutto compila,
 * tutti i test passano, e il difetto si vede solo aprendo le due app una
 * accanto all'altra. Qui la frase diventa un controllo.
 *
 * ## Che cosa pretende
 * 1. Ogni token che console e portale definiscono ENTRAMBI ha lo stesso valore,
 *    salvo le eccezioni qui sotto, che portano il motivo.
 * 2. Ogni `var(--x)` che la console usa è definito nella console. Una copia
 *    incompleta lascia il colore al valore di ripiego del browser (niente), e
 *    un bordo che sparisce non fa cadere nessun test.
 * 3. Nessun esadecimale nei sorgenti `.tsx` della console: là vale la stessa
 *    regola di web e portale (`no-restricted-syntax` in eslint), che però
 *    guarda i loro sorgenti e non i suoi.
 *
 * ## Perché NON confronta web e portale
 * Divergono di proposito: il brand del portale (#0EA5E9) non è quello del web,
 * e quasi tutti i token del web sono indirezioni verso la sua tavolozza
 * (`var(--accent)`) mentre il portale scrive i valori. Pretendere che
 * combacino vorrebbe dire o un elenco di eccezioni lungo quanto il file, o
 * rifare la tavolozza del web: due lavori che nessuno ha chiesto. La console
 * invece DICHIARA di parlare la lingua del portale, ed è quella dichiarazione
 * che qui si verifica.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const RADICE = join(dirname(fileURLToPath(import.meta.url)), '..')

const PORTALE = 'apps/portal/src/index.css'
const CONSOLE = 'apps/console/src/index.css'
const SORGENTI_CONSOLE = 'apps/console/src'

/**
 * I token che la console tiene DIVERSI di proposito, col motivo.
 *
 * Oggi è vuota: console e portale coincidono su tutti e tredici i token che
 * condividono. Lo stacco voluto della console — la zona di cancellazione — è
 * nelle regole, non nei token, e resta dov'è.
 */
const DIVERGENZE_VOLUTE = new Map([
  // ['--nome-token', 'il motivo, in una riga'],
])

/**
 * Il CSS senza i suoi commenti.
 *
 * Serve prima di ogni lettura: un commento che CITA un token — questa
 * spiegazione lo fa — non lo definisce e non lo usa. È lo stesso inciampo del
 * Cypher dentro la prosa, e ci sono cascato scrivendo questo file: il
 * guardiano ha segnalato il `var(--…)` del proprio commento.
 */
function senzaCommenti(testo) {
  return testo.replace(/\/\*[\s\S]*?\*\//g, '')
}

function bloccoRoot(percorso) {
  const testo = senzaCommenti(readFileSync(join(RADICE, percorso), 'utf-8'))
  const da = testo.indexOf(':root')
  if (da < 0) throw new Error(`${percorso}: nessun blocco :root`)
  const a = testo.indexOf('\n}', da)
  if (a < 0) throw new Error(`${percorso}: il blocco :root non si chiude`)
  return testo.slice(da, a)
}

function token(percorso) {
  const mappa = new Map()
  for (const m of bloccoRoot(percorso).matchAll(/^\s*(--[a-z0-9-]+)\s*:\s*([^;]+);/gm)) {
    mappa.set(m[1], m[2].trim())
  }
  return mappa
}

/** Confronto dei valori: l'esadecimale non distingue maiuscole, lo spazio non conta. */
const normale = (v) => v.replace(/\s+/g, ' ').trim().toLowerCase()

const errori = []

// ── 1. console ↔ portale ──────────────────────────────────────────────────────
const daPortale = token(PORTALE)
const daConsole = token(CONSOLE)

for (const [nome, valoreConsole] of daConsole) {
  if (!daPortale.has(nome)) continue
  const valorePortale = daPortale.get(nome)
  if (normale(valoreConsole) === normale(valorePortale)) {
    if (DIVERGENZE_VOLUTE.has(nome)) {
      errori.push(`[eccezione morta] ${nome} è dichiarato diverso di proposito ma i due valori coincidono (${valoreConsole}): togli la riga da DIVERGENZE_VOLUTE.`)
    }
    continue
  }
  if (DIVERGENZE_VOLUTE.has(nome)) continue
  errori.push(
    `[scollato] ${nome}: la console dice ${valoreConsole}, il portale ${valorePortale}. `
    + `La console dichiara di parlare la lingua visiva del portale: allineali, oppure dichiara il motivo in DIVERGENZE_VOLUTE.`,
  )
}

// ── 2. ogni var(--x) della console è definito nella console ───────────────────
const cssConsole = senzaCommenti(readFileSync(join(RADICE, CONSOLE), 'utf-8'))
const usati = new Set([...cssConsole.matchAll(/var\(\s*(--[a-z0-9-]+)/g)].map((m) => m[1]))
for (const nome of [...usati].sort()) {
  if (!daConsole.has(nome)) {
    errori.push(`[mai definito] ${CONSOLE} usa var(${nome}) ma non lo definisce: il browser non ha un valore di ripiego, la proprietà semplicemente non si applica.`)
  }
}

// ── 3. niente esadecimali nei .tsx della console ──────────────────────────────
function tsxDi(cartella) {
  const fuori = []
  for (const voce of readdirSync(join(RADICE, cartella), { withFileTypes: true })) {
    if (voce.isDirectory()) fuori.push(...tsxDi(join(cartella, voce.name)))
    else if (voce.name.endsWith('.tsx')) fuori.push(join(cartella, voce.name))
  }
  return fuori
}
for (const file of tsxDi(SORGENTI_CONSOLE)) {
  const righe = readFileSync(join(RADICE, file), 'utf-8').split('\n')
  righe.forEach((riga, i) => {
    const m = riga.match(/#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3}(?:[0-9a-fA-F]{2})?)?\b/)
    if (m && !/^\s*(\/\/|\*|\/\*)/.test(riga)) {
      errori.push(`[colore cablato] ${file}:${i + 1} «${m[0]}» — usa un token (var(--…)), come in web e portale.`)
    }
  })
}

// ── esito ─────────────────────────────────────────────────────────────────────
for (const e of errori) console.error(`ERROR ${e}`)
console.log(
  `check-token-visivi: ${daConsole.size} token nella console, `
  + `${[...daConsole.keys()].filter((k) => daPortale.has(k)).length} condivisi col portale, `
  + `${DIVERGENZE_VOLUTE.size} divergenze dichiarate. ${errori.length} errori.`,
)
process.exit(errori.length > 0 ? 1 : 0)
