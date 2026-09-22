#!/usr/bin/env node
/**
 * I PAVIMENTI DELLA COPERTURA NON INVECCHIANO IN SILENZIO (22 set 2026).
 *
 * ## Il difetto
 * `apps/api/vitest.config.ts` porta i pavimenti di non regressione per area.
 * Li aveva misurati il G-10 l'8 settembre; da allora la copertura e' cresciuta
 * e loro sono rimasti fermi. `src/services/**` era a 56 con un valore vero del
 * 90: TRENTAQUATTRO punti di gioco. Un pavimento con trentaquattro punti di
 * gioco non e' un pavimento, e' un ricordo — si poteva cancellare meta' dei
 * test di quell'area e la CI non diceva niente.
 *
 * E coprivano due aree su tredici: `src/graphql/**`, la piu' grande, non ne
 * aveva nessuno.
 *
 * Nessuno di questi due problemi fa cadere una CI. Vitest controlla che la
 * copertura non SCENDA sotto il pavimento; che il pavimento sia diventato
 * ridicolo, o che manchi del tutto, non lo guarda nessuno. Questo si'.
 *
 * ## Che cosa pretende
 * 1. Nessun pavimento piu' di `GIOCO_MASSIMO` punti sotto il valore misurato:
 *    se la copertura e' salita, il pavimento sale con lei.
 * 2. Ogni cartella di primo livello sotto `src/` ha il suo pavimento. Un'area
 *    nuova senza pavimento e' esattamente com'era `src/graphql/**`.
 * 3. Nessun pavimento su un'area che non esiste piu'.
 *
 * ## Quando gira
 * Dopo `pnpm --filter @opengraphity/api test:coverage`, che scrive il
 * `coverage-summary.json` da cui legge. Da solo non misura niente: se il
 * riassunto manca lo dice e si ferma, invece di passare per finta.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const RADICE = join(dirname(fileURLToPath(import.meta.url)), '..')
const RIASSUNTO = join(RADICE, 'apps/api/coverage/coverage-summary.json')
const CONFIG = join(RADICE, 'apps/api/vitest.config.ts')
const SORGENTI = join(RADICE, 'apps/api/src')

/**
 * Quanto puo' stare sotto un pavimento prima di essere da rialzare.
 *
 * Cinque punti: sotto, si inseguirebbe il rumore (una manciata di rami in piu'
 * o in meno fra due esecuzioni), sopra, si torna al ricordo. Chi alza un
 * pavimento lo mette due punti sotto il valore del giorno, quindi ha tre punti
 * di crescita prima di doverci tornare.
 */
const GIOCO_MASSIMO = 5

const METRICHE = ['lines', 'statements', 'functions', 'branches']

if (!existsSync(RIASSUNTO)) {
  console.error(
    `ERROR ${RIASSUNTO} non c'e'. Questo controllo legge una misura, non la fa: `
    + `lancia prima «pnpm --filter @opengraphity/api test:coverage».`,
  )
  process.exit(1)
}

// ── i pavimenti dichiarati ────────────────────────────────────────────────────
function pavimenti() {
  const testo = readFileSync(CONFIG, 'utf-8')
  const da = testo.indexOf('thresholds: {')
  if (da < 0) throw new Error('vitest.config.ts: nessun blocco thresholds')
  const apre = testo.indexOf('{', da)
  let livello = 0, chiude = -1
  for (let i = apre; i < testo.length; i++) {
    if (testo[i] === '{') livello++
    else if (testo[i] === '}' && --livello === 0) { chiude = i; break }
  }
  const blocco = testo.slice(apre, chiude + 1)
  const fuori = new Map()
  for (const m of blocco.matchAll(/'([^']+)':\s*\{([^}]*)\}/g)) {
    const valori = {}
    for (const v of m[2].matchAll(/(lines|statements|functions|branches):\s*(\d+)/g)) valori[v[1]] = Number(v[2])
    fuori.set(m[1], valori)
  }
  return fuori
}

/** Da `src/lib/**` o `src/*.ts` alla cartella che nomina (`lib`, o la radice). */
function areaDi(glob) {
  const m = glob.match(/^src\/([^/*]+)\/\*\*$/)
  if (m) return m[1]
  if (glob === 'src/*.ts') return '.'
  return null
}

// ── la misura ─────────────────────────────────────────────────────────────────
const riassunto = JSON.parse(readFileSync(RIASSUNTO, 'utf-8'))
const misura = new Map()
for (const [percorso, v] of Object.entries(riassunto)) {
  if (percorso === 'total') continue
  const dentro = percorso.split('/src/')[1]
  if (dentro === undefined) continue
  const area = dentro.includes('/') ? dentro.split('/')[0] : '.'
  if (!misura.has(area)) misura.set(area, Object.fromEntries(METRICHE.map((m) => [m, [0, 0]])))
  const a = misura.get(area)
  for (const m of METRICHE) { a[m][0] += v[m].covered; a[m][1] += v[m].total }
}
const percentuali = (area) => Object.fromEntries(
  METRICHE.map((m) => {
    const [coperti, totale] = misura.get(area)[m]
    return [m, totale === 0 ? 100 : (100 * coperti) / totale]
  }),
)

// ── i controlli ───────────────────────────────────────────────────────────────
const errori = []
const dichiarati = pavimenti()
const conPavimento = new Set()

for (const [glob, valori] of dichiarati) {
  const area = areaDi(glob)
  if (area === null) { errori.push(`[glob strano] «${glob}» non nomina un'area: usa «src/<cartella>/**» o «src/*.ts».`); continue }
  if (!misura.has(area)) { errori.push(`[area sparita] il pavimento «${glob}» guarda un'area che la misura non conosce: toglilo.`); continue }
  conPavimento.add(area)
  const oggi = percentuali(area)
  for (const m of METRICHE) {
    if (valori[m] === undefined) { errori.push(`[metrica mancante] «${glob}» non dichiara ${m}.`); continue }
    const gioco = oggi[m] - valori[m]
    if (gioco < 0) {
      errori.push(`[sfondato] ${glob} ${m}: misurato ${oggi[m].toFixed(1)}, pavimento ${valori[m]}. Copri quello che manca — il pavimento non si abbassa.`)
    } else if (gioco > GIOCO_MASSIMO) {
      errori.push(
        `[pavimento vecchio] ${glob} ${m}: misurato ${oggi[m].toFixed(1)}, pavimento ${valori[m]} `
        + `(${gioco.toFixed(1)} punti di gioco). Alzalo a ${Math.floor(oggi[m]) - 2}: con tutto quel gioco non difende piu' niente.`,
      )
    }
  }
}

for (const voce of readdirSync(SORGENTI, { withFileTypes: true })) {
  const area = voce.isDirectory() ? voce.name : '.'
  if (!misura.has(area) || conPavimento.has(area)) continue
  conPavimento.add(area)
  const oggi = percentuali(area)
  errori.push(
    `[area senza pavimento] src/${area === '.' ? '*.ts' : area + '/**'} e' misurata (${METRICHE.map((m) => oggi[m].toFixed(0)).join('/')}) `
    + `ma nessuna soglia la guarda: puo' scendere a zero senza che la CI dica niente.`,
  )
}

for (const e of errori) console.error(`ERROR ${e}`)
console.log(`check-tetti-copertura: ${dichiarati.size} pavimenti, ${misura.size} aree misurate, gioco massimo ${GIOCO_MASSIMO} punti. ${errori.length} errori.`)
process.exit(errori.length > 0 ? 1 : 0)
