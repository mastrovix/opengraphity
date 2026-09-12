/**
 * Il vocabolario della criticità dell'applicazione di business (C-7).
 *
 * ## Contratto rinegoziato nell'ondata 7, e perché
 * Questo file pinnava due cose:
 *
 *  1. `SERVICE_CRITICALITIES` (lib/serviceVocabularies.ts) uguale all'
 *     `enum_values` del campo nel seme del metamodello. La copia serviva a
 *     validare il filtro della pagina Servizi. Ora il filtro valida contro il
 *     **vocabolario del cliente** (`assertDomainValue`), quindi la copia non è
 *     più la sorgente della validazione — resta il seme, e quello che conta è
 *     che il vocabolario SPEDITO (`SYSTEM_ENUMS.service_criticality`) sia lo
 *     stesso del campo. È ciò che il primo test misura adesso.
 *
 *  2. **`serviceImpactOf('boh') === 'medium'`** e «le due critiche sono quelle
 *     a impatto alto» via `IMPACT_BY_CRITICALITY`. Il primo era esattamente il
 *     difetto C-7 — una criticità aggiunta o rinominata dava impatto medio con
 *     un solo `log.warn`, quindi P3 su un servizio mission critical — e
 *     `IMPACT_BY_CRITICALITY` non esiste più: la traduzione è la matrice
 *     `service_impact` del cliente. La garanzia che serviva davvero («ogni
 *     criticità ha un impatto dichiarato, e le critiche sono quelle a impatto
 *     alto») resta, misurata sul SEME della matrice invece che su una tabella
 *     del codice.
 *
 * `SERVICE_CRITICAL_CRITICALITIES` non viene più citata: era usata solo da
 * questo test e da nessun lettore in produzione (verifica C-7). Chi ha bisogno
 * delle criticità «critiche» adesso le chiede a
 * `criticalServiceCriticalities`, che le ricava dalla matrice.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { SYSTEM_ENUMS } from '../seedEnumTypes.js'
import { domainMatrixSeedEntries } from '../domainMatrixSeed.js'

const seedPath = fileURLToPath(new URL('../../scripts/seed-metamodel.ts', import.meta.url))

function criticalityFromMetamodelSeed(): string[] {
  const src = readFileSync(seedPath, 'utf8')
  const m = src.match(/name:\s*'criticality'[\s\S]{0,400}?enum_values:\s*\[([^\]]+)\]/)
  if (!m) throw new Error("seed-metamodel.ts: campo 'criticality' con enum_values non trovato (il test va aggiornato insieme al seed)")
  return m[1]!.split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean)
}

describe('vocabolario della criticità', () => {
  it('il vocabolario spedito `service_criticality` coincide col campo enum del metamodello', () => {
    // La migrazione 20260917_1800 aggancia il campo a QUESTO vocabolario: se i
    // due divergessero, il cliente vedrebbe nel disegnatore valori diversi da
    // quelli che la matrice sa tradurre.
    const shipped = SYSTEM_ENUMS.find((e) => e.name === 'service_criticality')
    expect(shipped, 'vocabolario service_criticality assente da SYSTEM_ENUMS').toBeDefined()
    expect(shipped!.values).toEqual(criticalityFromMetamodelSeed())
  })

  it('il seme della matrice `service_impact` copre OGNI criticità spedita', () => {
    // NB: il seme del NUCLEO ha chiavi generiche (critical/high/medium/low)
    // che non appartengono a nessun vocabolario di criticità; quello che si
    // semina davvero è `domainMatrixSeedEntries` (lib/domainMatrixSeed.ts),
    // cioè la tabella che il codice usava. Se si seminassero le chiavi del
    // nucleo alla lettera, ogni incident di servizio fallirebbe il primo
    // giorno: e' questo il test che lo impedisce.
    // Una criticità senza cella non è più un `medium` silenzioso: è un errore
    // dell'apertura dell'incident. Quindi il seme deve essere completo, o il
    // prodotto nascerebbe rotto.
    const entries = domainMatrixSeedEntries('service_impact')
    for (const c of criticalityFromMetamodelSeed()) {
      expect(entries[c], `cella mancante per la criticità ${c}`).toBeDefined()
    }
    expect(Object.keys(entries).sort()).toEqual(criticalityFromMetamodelSeed().sort())
  })

  it('le criticità a impatto alto del seme sono le due «critiche» di sempre', () => {
    // È la definizione che il banner «servizi critici giù» usa adesso
    // (criticalServiceCriticalities legge la matrice e prende l'impatto più
    // alto del vocabolario `impact`, che è l'ultimo: `high`).
    const impact = SYSTEM_ENUMS.find((e) => e.name === 'impact')!.values
    const highest = impact[impact.length - 1]
    expect(highest).toBe('high')
    const entries = domainMatrixSeedEntries('service_impact')
    const critical = Object.keys(entries).filter((k) => entries[k] === highest)
    expect(critical).toEqual(['mission_critical', 'business_critical'])
  })
})
