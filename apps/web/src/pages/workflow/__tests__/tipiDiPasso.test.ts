/**
 * LA PALETTE OFFRE SOLO QUELLO CHE IL MOTORE ESEGUE (revisione AI, ondata 10).
 *
 * Il disegnatore offriva «Biforcazione», «Ricongiunzione» e «Sotto-workflow».
 * Il motore non ne conosce nessuno: entrando in un `parallel_fork` seguiva UNA
 * transizione come da un passo normale, quindi chi disegnava due rami ne
 * vedeva partire uno solo — senza un errore, senza un log.
 *
 * Il guardiano lega le due sponde: la palette del browser e l'elenco di
 * `@opengraphity/types` che anche l'API usa per rifiutare in scrittura.
 * Rimetterne uno nella palette senza implementarlo fa fallire qui.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ADDABLE_STEP_TYPES, UNIMPLEMENTED_STEP_TYPES } from '@opengraphity/types'

const TOOLBAR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '../WorkflowToolbar.tsx',
)

/** I `type:` della palette, letti dal sorgente: l'elenco è un letterale. */
function tipiOffertiDallaPalette(): string[] {
  const src = fs.readFileSync(TOOLBAR, 'utf8')
  const blocco = src.slice(src.indexOf('const SPECIAL_STEP_TYPES = ['))
  const fine = blocco.indexOf('\n]')
  return [...blocco.slice(0, fine).matchAll(/\{ type: '([a-z_]+)'/g)].map((m) => m[1]!)
}

describe('i tipi di passo della palette', () => {
  it('sono esattamente quelli che il motore sa eseguire', () => {
    expect(tipiOffertiDallaPalette().sort()).toEqual([...ADDABLE_STEP_TYPES].sort())
  })

  it('nessuno dei tipi non implementati è offerto', () => {
    const offerti = new Set(tipiOffertiDallaPalette())
    for (const tipo of UNIMPLEMENTED_STEP_TYPES) expect(offerti.has(tipo)).toBe(false)
  })
})
