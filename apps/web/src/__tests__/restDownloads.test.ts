/**
 * Le chiamate REST del web passano dalla base comune e portano il token
 * (giro nel browser del 14 set 2026).
 *
 * Dal vivo, due difetti della stessa famiglia:
 *  - Report Builder «↓ PDF» e «↓ Excel» aprivano `/api/reports/<file>` con un
 *    link nudo: senza `Authorization`, la scheda finiva su `{"error":"Unauthorized"}`
 *    e la pagina del report si perdeva;
 *  - l'analisi AI costruiva l'indirizzo con `VITE_API_BASE_URL`, una variabile
 *    usata solo lì e puntata sul cliente del bundle: su ogni altro cliente
 *    l'API rifiutava il token («Tenant/host mismatch») e la pagina diceva
 *    «Error: HTTP 401».
 *
 * Il guardiano: nessuna lettura di `VITE_API_BASE_URL`, e ogni link creato per
 * scaricare punta a un oggetto Blob (`URL.createObjectURL`), cioè a qualcosa
 * che il web ha già scaricato con il token.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = join(import.meta.dirname, '..')

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'test') continue
      walk(full, out)
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(full)
  }
  return out
}

const files = walk(SRC).map((f) => ({ rel: relative(SRC, f), src: readFileSync(f, 'utf8') }))

describe('chiamate REST del web', () => {
  it('nessuno legge VITE_API_BASE_URL (la base è apiUrl, da VITE_API_URL)', () => {
    expect(files.filter((f) => f.src.includes('VITE_API_BASE_URL')).map((f) => f.rel)).toEqual([])
  })

  it('ogni link di download punta a un Blob già scaricato con il token', () => {
    const offenders: string[] = []
    for (const f of files) {
      for (const m of f.src.matchAll(/\.href\s*=\s*([A-Za-z_]\w*)/g)) {
        const variable = m[1]!
        const fromBlob = new RegExp(`\\b${variable}\\s*=\\s*URL\\.createObjectURL\\(`).test(f.src)
        if (!fromBlob) offenders.push(`${f.rel}: .href = ${variable}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
