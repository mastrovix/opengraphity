#!/usr/bin/env node
/**
 * UN CARATTERE SOLO, E DICHIARATO IN UN POSTO SOLO (22 set 2026).
 *
 * ## Il difetto, visto a schermo
 * Il proprietario, guardando le sezioni di una change: «non mi sembra che
 * abbiano tutte il font standard». Aveva ragione, e non era quella pagina: in
 * TUTTO il prodotto i `<button>` erano nel carattere dell'interfaccia del
 * browser — Helvetica su un Mac — mentre titoli, etichette e testi erano in
 * Plus Jakarta Sans.
 *
 * Il motivo è una trappola di CSS che vale la pena scrivere: un `<button>`
 * NON eredita `font-family` dal genitore. Serve una regola esplicita. La
 * regola c'era — `button { font-family: … }` — ma viveva in
 * `apps/web/src/style.css`, l'avanzo del modello di Vite (conteneva ancora
 * `.read-the-docs` e un bottone con lo sfondo `#1a1a1a`) che NESSUNO
 * importava. Un foglio di stile morto che sembrava vivo: chi leggeva il
 * repository trovava la regola e pensava fosse applicata.
 *
 * ## Cosa pretende questo controllo
 * 1. il nome del carattere si scrive in UN posto solo — `--font-family` in
 *    `index.css`, più `fonts.css` che lo definisce con `@font-face`. Ovunque
 *    altro si usa il token. Quattordici copie a mano sparse nei sorgenti sono
 *    esattamente il motivo per cui un punto dimenticato non si nota;
 * 2. la regola globale di `index.css` copre gli elementi che NON ereditano il
 *    carattere: `input`, `textarea`, `select` e `button`. Se domani qualcuno
 *    toglie `button` da lì, questo controllo lo dice subito.
 *
 * Uso: node scripts/check-font.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const RADICE = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const INDEX_CSS = join(RADICE, 'apps', 'web', 'src', 'index.css')

/** Dove il nome del carattere PUÒ comparire: la definizione e il `@font-face`. */
const AMMESSI = [
  'apps/web/src/index.css',
  'apps/web/src/fonts.css',
  'apps/portal/src/index.css',
  'apps/console/src/index.css',
  'scripts/check-font.mjs',
]

const NOME = /'Plus Jakarta Sans'/
const ESTENSIONI = /\.(ts|tsx|css)$/

function* sorgenti(dir) {
  for (const voce of readdirSync(dir)) {
    const p = join(dir, voce)
    if (statSync(p).isDirectory()) {
      if (['node_modules', 'dist', 'coverage', 'build'].includes(voce)) continue
      yield* sorgenti(p)
    } else if (ESTENSIONI.test(voce)) {
      yield p
    }
  }
}

const copie = []
for (const base of ['apps/web/src', 'apps/portal/src', 'apps/console/src', 'packages']) {
  const dir = join(RADICE, base)
  try { statSync(dir) } catch { continue }
  for (const file of sorgenti(dir)) {
    const rel = relative(RADICE, file)
    if (AMMESSI.includes(rel)) continue
    const testo = readFileSync(file, 'utf8')
    testo.split('\n').forEach((riga, i) => {
      // Un commento che NOMINA il carattere non è una copia: è una spiegazione.
      const codice = riga.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '')
      if (NOME.test(codice)) copie.push(`${rel}:${String(i + 1)}`)
    })
  }
}

const css = readFileSync(INDEX_CSS, 'utf8')
const regola = /\n\s*input,\s*textarea,\s*select,\s*button\s*\{[^}]*font-family:\s*var\(--font-family\)/.exec(css)
const definizione = /--font-family:\s*'Plus Jakarta Sans'/.test(css)

let rosso = false
if (copie.length > 0) {
  rosso = true
  console.error(`check-font: il nome del carattere è scritto a mano in ${String(copie.length)} punti:`)
  for (const c of copie) console.error(`  ${c}`)
  console.error('\nUsa `var(--font-family)`: il carattere si cambia in un posto solo.')
}
if (!definizione) {
  rosso = true
  console.error(`\ncheck-font: \`--font-family\` non è definita in ${relative(RADICE, INDEX_CSS)}.`)
}
if (!regola) {
  rosso = true
  console.error('\ncheck-font: la regola globale non copre `input, textarea, select, button`.')
  console.error('Un <button> NON eredita il font: senza quella riga ogni bottone del prodotto')
  console.error('torna al carattere del browser, ed è successo davvero (22 set 2026).')
}
if (rosso) process.exit(1)

console.log(`check-font: un carattere solo, definito in ${relative(RADICE, INDEX_CSS)}; la regola globale copre anche i bottoni.`)
