#!/usr/bin/env node
/**
 * I PAVIMENTI DELLA COPERTURA NON INVECCHIANO, E LA DISTANZA DAL 95% SI LEGGE.
 *
 * ## Il difetto, in due tempi
 * Il primo: `apps/api` aveva pavimenti di non regressione misurati l'8
 * settembre e mai più toccati. `src/services` stava a 56 con un valore vero
 * del 90 — TRENTAQUATTRO punti di gioco: si poteva cancellare metà dei test di
 * quell'area senza che la CI dicesse niente. E coprivano due aree su tredici.
 *
 * Il secondo, trovato il 22 set 2026 guardando più in là dell'api: gli ALTRI
 * UNDICI workspace non avevano pavimenti affatto. `apps/web` è 12.275
 * istruzioni — più di un terzo del monorepo — e la sua copertura poteva andare
 * a zero con la CI verde.
 *
 * ## E la misura era gonfiata
 * Senza un `include`, v8 conta solo i file che un test IMPORTA. `packages/
 * events` risultava al 95,4% ed era al 49,0%: più della metà dei suoi file non
 * li apriva nessuno, quindi non comparivano nel denominatore.
 * `packages/web-core` dal 79,3% al 41,5%. Ora `copertura.mjs` conta ogni file
 * di sorgente, e un modulo nuovo senza test abbassa il numero invece di
 * restare invisibile.
 *
 * ## Che cosa pretende
 * 1. Nessun pavimento più di `GIOCO_MASSIMO` punti sotto il valore misurato:
 *    se la copertura è salita, il pavimento sale con lei. È il cricchetto.
 * 2. Ogni workspace con dei test ha il suo pavimento dichiarato.
 * 3. Per `apps/api`, che dichiara per AREA: ogni cartella di primo livello
 *    sotto `src/` ha la sua soglia, e nessuna soglia guarda un'area sparita.
 *
 * E a ogni giro stampa la DISTANZA dall'obiettivo — il 95% deciso dal
 * proprietario — workspace per workspace: è il numero che dice se il lavoro
 * sta andando avanti.
 *
 * ## Quando gira
 * Dopo le misure, che scrivono i `coverage-summary.json`. Da solo non misura
 * niente: se un riassunto manca lo dice e si ferma, invece di passare per
 * finta su un workspace che nessuno ha misurato.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OBIETTIVO, GIOCO_MASSIMO, PAVIMENTI } from '../copertura.mjs'

const RADICE = join(dirname(fileURLToPath(import.meta.url)), '..')
const METRICHE = ['lines', 'statements', 'functions', 'branches']

/** Un pavimento «per area» è un oggetto di glob, non di metriche. */
const perArea = (pav) => !METRICHE.some((m) => m in pav)

function riassunto(workspace) {
  const p = join(RADICE, workspace, 'coverage', 'coverage-summary.json')
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) : null
}

/** Somma le metriche dei file che stanno sotto `filtro`. */
function somma(dati, filtro = () => true) {
  const acc = Object.fromEntries(METRICHE.map((m) => [m, [0, 0]]))
  for (const [percorso, v] of Object.entries(dati)) {
    if (percorso === 'total' || !filtro(percorso)) continue
    for (const m of METRICHE) { acc[m][0] += v[m].covered; acc[m][1] += v[m].total }
  }
  return Object.fromEntries(METRICHE.map((m) => {
    const [c, t] = acc[m]
    return [m, { pct: t === 0 ? 100 : (100 * c) / t, coperti: c, totale: t }]
  }))
}

/** Da `src/lib/**` o `src/*.ts` alla cartella che nomina. */
function areaDi(glob) {
  const m = /^src\/([^/*]+)\/\*\*$/.exec(glob)
  if (m) return m[1]
  return glob === 'src/*.ts' ? '.' : null
}

const errori = []
const righe = []

for (const [workspace, pavimento] of Object.entries(PAVIMENTI)) {
  const dati = riassunto(workspace)
  if (!dati) {
    errori.push(
      `[non misurato] ${workspace}: manca coverage/coverage-summary.json. `
      + `Questo controllo legge una misura, non la fa: lancia «pnpm --filter ./${workspace} test:coverage».`,
    )
    continue
  }

  const intero = somma(dati)
  righe.push({ workspace, ...intero })

  if (!perArea(pavimento)) {
    for (const m of METRICHE) {
      if (pavimento[m] === undefined) { errori.push(`[metrica mancante] ${workspace} non dichiara ${m}.`); continue }
      const gioco = intero[m].pct - pavimento[m]
      if (gioco < 0) {
        errori.push(`[sfondato] ${workspace} ${m}: misurato ${intero[m].pct.toFixed(1)}, pavimento ${pavimento[m]}. Copri quello che manca — il pavimento non si abbassa.`)
      } else if (gioco > GIOCO_MASSIMO) {
        errori.push(
          `[pavimento vecchio] ${workspace} ${m}: misurato ${intero[m].pct.toFixed(1)}, pavimento ${pavimento[m]} `
          + `(${gioco.toFixed(1)} punti di gioco). Alzalo a ${Math.floor(intero[m].pct) - 2} in copertura.mjs: il terreno guadagnato si tiene.`,
        )
      }
    }
    continue
  }

  // ── Per area (apps/api) ───────────────────────────────────────────────────
  const conPavimento = new Set()
  const areeMisurate = new Set(
    Object.keys(dati).filter((p) => p !== 'total' && p.includes('/src/'))
      .map((p) => { const d = p.split('/src/')[1]; return d.includes('/') ? d.split('/')[0] : '.' }),
  )

  for (const [glob, valori] of Object.entries(pavimento)) {
    const area = areaDi(glob)
    if (area === null) { errori.push(`[glob strano] ${workspace} «${glob}»: usa «src/<cartella>/**» o «src/*.ts».`); continue }
    if (!areeMisurate.has(area)) { errori.push(`[area sparita] ${workspace} «${glob}» guarda un'area che la misura non conosce: toglilo.`); continue }
    conPavimento.add(area)
    const oggi = somma(dati, (p) => {
      const d = p.split('/src/')[1]
      if (d === undefined) return false
      return (d.includes('/') ? d.split('/')[0] : '.') === area
    })
    for (const m of METRICHE) {
      if (valori[m] === undefined) { errori.push(`[metrica mancante] ${workspace} «${glob}» non dichiara ${m}.`); continue }
      const gioco = oggi[m].pct - valori[m]
      if (gioco < 0) {
        errori.push(`[sfondato] ${workspace} ${glob} ${m}: misurato ${oggi[m].pct.toFixed(1)}, pavimento ${valori[m]}.`)
      } else if (gioco > GIOCO_MASSIMO) {
        errori.push(
          `[pavimento vecchio] ${workspace} ${glob} ${m}: misurato ${oggi[m].pct.toFixed(1)}, pavimento ${valori[m]} `
          + `(${gioco.toFixed(1)} punti di gioco). Alzalo a ${Math.floor(oggi[m].pct) - 2} in copertura.mjs.`,
        )
      }
    }
  }

  for (const area of areeMisurate) {
    if (conPavimento.has(area)) continue
    errori.push(`[area senza pavimento] ${workspace} src/${area === '.' ? '*.ts' : area + '/**'} è misurata ma nessuna soglia la guarda: può scendere a zero senza che la CI dica niente.`)
  }
}

// ── Un workspace con dei test e senza pavimento non deve esistere ────────────
for (const dove of ['apps', 'packages']) {
  for (const nome of readdirSync(join(RADICE, dove))) {
    const workspace = `${dove}/${nome}`
    if (workspace in PAVIMENTI) continue
    if (!existsSync(join(RADICE, workspace, 'vitest.config.ts'))) continue
    errori.push(`[workspace senza pavimento] ${workspace} ha un vitest.config ma nessun pavimento in copertura.mjs.`)
  }
}

// ── L'esito, e la distanza dall'obiettivo ────────────────────────────────────
for (const e of errori) console.error(`ERROR ${e}`)

righe.sort((a, b) => (0.95 * b.statements.totale - b.statements.coperti) - (0.95 * a.statements.totale - a.statements.coperti))
const tot = righe.reduce((a, r) => ({ c: a.c + r.statements.coperti, t: a.t + r.statements.totale }), { c: 0, t: 0 })
console.log(`\ncheck-tetti-copertura: obiettivo ${String(OBIETTIVO)}%, gioco massimo ${String(GIOCO_MASSIMO)} punti.\n`)
console.log(`  ${'workspace'.padEnd(26)} ${'oggi'.padStart(7)}  ${'a 95% mancano'.padStart(14)}`)
for (const r of righe) {
  const manca = Math.max(0, Math.round((OBIETTIVO / 100) * r.statements.totale) - r.statements.coperti)
  console.log(`  ${r.workspace.padEnd(26)} ${r.statements.pct.toFixed(1).padStart(6)}% ${String(manca).padStart(14)}`)
}
const mancaTot = Math.max(0, Math.round((OBIETTIVO / 100) * tot.t) - tot.c)
console.log(`  ${'TOTALE'.padEnd(26)} ${((100 * tot.c) / tot.t).toFixed(1).padStart(6)}% ${String(mancaTot).padStart(14)} istruzioni\n`)
console.log(`${errori.length} errori.`)
process.exit(errori.length > 0 ? 1 : 0)
