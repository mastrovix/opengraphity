/**
 * Il vocabolario della criticità ha DUE copie che devono restare uguali
 * (revisione 2 · C-7): il metamodello che la semina come campo enum della
 * BusinessApplication (`scripts/seed-metamodel.ts`) e la lista che valida il
 * filtro `ServiceMapFilter.criticality` (`lib/serviceVocabularies.ts`).
 *
 * Senza questo test, aggiungere una criticità nel metamodello darebbe un
 * filtro che rifiuta un valore legittimo — e il banner dei servizi critici
 * tornerebbe a tacere, che è esattamente il guasto che C-7 chiudeva.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { SERVICE_CRITICALITIES, SERVICE_CRITICAL_CRITICALITIES } from '../serviceVocabularies.js'
import { IMPACT_BY_CRITICALITY } from '../../services/serviceImpact/incident.js'

const seedPath = fileURLToPath(new URL('../../scripts/seed-metamodel.ts', import.meta.url))

describe('vocabolario della criticità', () => {
  it('coincide con il campo enum del metamodello', () => {
    const src = readFileSync(seedPath, 'utf8')
    const m = src.match(/name:\s*'criticality'[\s\S]{0,400}?enum_values:\s*\[([^\]]+)\]/)
    if (!m) throw new Error("seed-metamodel.ts: campo 'criticality' con enum_values non trovato (il test va aggiornato insieme al seed)")
    const seeded = m[1]!.split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean)
    expect(seeded).toEqual([...SERVICE_CRITICALITIES])
  })

  it('ogni criticità ha un impatto dichiarato, e le due «critiche» sono quelle a impatto alto', () => {
    for (const c of SERVICE_CRITICALITIES) expect(IMPACT_BY_CRITICALITY[c], `impatto mancante per ${c}`).toBeDefined()
    const high = SERVICE_CRITICALITIES.filter((c) => IMPACT_BY_CRITICALITY[c] === 'high')
    expect(high).toEqual([...SERVICE_CRITICAL_CRITICALITIES])
  })
})
