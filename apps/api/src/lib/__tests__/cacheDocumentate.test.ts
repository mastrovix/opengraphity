/**
 * OGNI CACHE SUL CANALE STA NELLA TABELLA DI OPERATIONS (21 set 2026).
 *
 * ## Perché
 * `docs/OPERATIONS.md` §7 elenca le cache che viaggiano sul canale del
 * metamodello, col loro TTL: è la pagina che un operatore legge per sapere
 * quanto può restare vecchio un dato dopo una modifica. E aveva DUE difetti,
 * trovati rileggendola e non da un rosso:
 *
 *  - diceva in grassetto «APERTO — la cache delle regole di notifica non è su
 *    questo canale», mentre `notificationRuleCache.ts` la aggancia dalla
 *    revisione E-20: un operatore credeva a una finestra di 60 secondi che
 *    non esiste più;
 *  - non citava `tenant-language`, `event_policy` e le cache delle
 *    automazioni, che sul canale ci sono.
 *
 * Una pagina che dice il falso è peggio di una che non dice niente, e una
 * tabella si aggiorna solo se qualcosa la costringe. Questo test la
 * costringe: chi registra una cache nuova e non la documenta trova un rosso
 * con il nome che ha scelto.
 *
 * ## Come
 * Statico, come il guardiano del varco: si leggono i sorgenti alla ricerca di
 * `registerMetamodelCacheClearer('nome'` e si confronta con i nomi fra apici
 * inversi nella tabella. I nomi COSTRUITI a runtime (`automation:${prefix}`)
 * non si possono leggere così: si dichiarano qui sotto una volta, col loro
 * perché.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const SRC = join(process.cwd(), 'src')
const OPERATIONS = join(process.cwd(), '../../docs/OPERATIONS.md')

/**
 * I nomi che nascono a runtime e che un grep non può vedere: nella tabella
 * stanno con il segnaposto, qui si dice quale prefisso li genera.
 */
const NOMI_COSTRUITI = new Map([
  ['automation:', '`automation:<prefisso>` — un motore per prefisso, vedi `lib/automationEngine.ts`'],
])

function sorgenti(dir: string, out: string[] = []): string[] {
  for (const nome of readdirSync(dir)) {
    const pieno = join(dir, nome)
    if (statSync(pieno).isDirectory()) {
      if (nome === '__tests__' || nome === 'node_modules' || nome === 'dist') continue
      sorgenti(pieno, out)
    } else if (nome.endsWith('.ts')) {
      out.push(pieno)
    }
  }
  return out
}

/** I nomi registrati come LETTERALI nei sorgenti (esclusi i test). */
const registrati = new Map<string, string>()
for (const file of sorgenti(SRC)) {
  const testo = readFileSync(file, 'utf8')
  for (const m of testo.matchAll(/registerMetamodelCacheClearer\(\s*'([^']+)'/g)) {
    registrati.set(m[1]!, relative(SRC, file).split('\\').join('/'))
  }
}

/*
 * La tabella di OPERATIONS §7. I nomi si prendono SOLO dalla prima colonna:
 * nella seconda ci sono spiegazioni che citano funzioni fra apici inversi
 * (`registerCITypes`, `EVENT_POLICY_CACHE_TTL_MS`), e prenderle per nomi di
 * cache faceva risultare «fantasmi» che fantasmi non erano.
 */
const doc = readFileSync(OPERATIONS, 'utf8')
const tabella = /\| Cache \(nome del clearer\) \| TTL \|\n\|[-| ]+\|\n((?:\|.*\n)+)/.exec(doc)
const primaColonna = (tabella?.[1] ?? '')
  .split('\n')
  .filter((r) => r.startsWith('|'))
  .map((r) => r.split('|')[1] ?? '')
  .join(' ')
const documentati = new Set(
  [...primaColonna.matchAll(/`([^`]+)`/g)]
    .map((m) => m[1]!)
    .filter((n) => !n.includes('/')),
)

describe('le cache sul canale del metamodello sono documentate', () => {
  it('la tabella di OPERATIONS §7 esiste ancora (se cambia forma, questo test va riscritto)', () => {
    expect(tabella, 'tabella «Cache (nome del clearer) | TTL» non trovata in docs/OPERATIONS.md').not.toBeNull()
    expect(registrati.size).toBeGreaterThanOrEqual(6)
  })

  it('ogni cache registrata sta nella tabella', () => {
    const mancanti: string[] = []
    for (const [nome, dove] of registrati) {
      if (documentati.has(nome)) continue
      const costruito = [...NOMI_COSTRUITI.keys()].some((p) => nome.startsWith(p))
      if (costruito) continue
      mancanti.push(`${nome} (${dove})`)
    }
    expect(mancanti, 'Queste cache viaggiano sul canale del metamodello ma non stanno nella tabella di '
      + 'docs/OPERATIONS.md §7: un operatore non sa quanto può restare vecchio quel dato. Aggiungile con il loro TTL.',
    ).toEqual([])
  })

  it('e la tabella non promette cache che non esistono più', () => {
    const fantasmi = [...documentati].filter((n) => {
      if (registrati.has(n)) return false
      // I nomi col segnaposto sono dichiarati in NOMI_COSTRUITI.
      if ([...NOMI_COSTRUITI.keys()].some((p) => n.startsWith(p))) return false
      // I sei della metamodelCache si registrano passando `opts.name`: sono
      // letterali nelle SUE chiamate, non in `registerMetamodelCacheClearer`.
      return !/^(domain-|pre-approved-|ci-labels-|ci-type-name-|ci-metamodel-)/.test(n)
    })
    expect(fantasmi, 'La tabella cita cache che nessun sorgente registra più: togli le righe morte.').toEqual([])
  })
})
