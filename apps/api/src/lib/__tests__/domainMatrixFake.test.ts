/**
 * Il doppio di `lib/domainMatrix.ts` non può divergere dal vero.
 *
 * `domainMatrixFake.ts` ricopia a mano matrici e vocabolari, perché un mock è
 * globale nel grafo del test e quindi il doppio non può importare il modulo
 * che sostituisce. Una copia a mano è un posto dove le due cose si separano in
 * silenzio — esattamente il difetto che l'ondata 7 chiude — quindi qui si
 * confronta con le fonti vere: i semi (`lib/domainMatrixSeed.ts`, che sono i
 * semi del nucleo con le due correzioni) e i vocabolari spediti
 * (`lib/seedEnumTypes.ts`).
 */
import { describe, it, expect } from 'vitest'
import { DOMAIN_MATRIX_KINDS, type DomainMatrixKind } from '../domainMatrix.js'
import { domainMatrixSeedEntries } from '../domainMatrixSeed.js'
import { SYSTEM_ENUMS } from '../seedEnumTypes.js'
import { DOMAIN_MATRIX_KINDS as FAKE_KINDS, FAKE_ENTRIES, FAKE_VOCABULARIES } from './domainMatrixFake.js'

describe('domainMatrixFake resta uguale al vero', () => {
  it('gli stessi tipi di matrice, con gli stessi ingressi e la stessa uscita', () => {
    expect(Object.keys(FAKE_KINDS)).toEqual(Object.keys(DOMAIN_MATRIX_KINDS))
    for (const kind of Object.keys(DOMAIN_MATRIX_KINDS) as DomainMatrixKind[]) {
      expect(FAKE_KINDS[kind].inputs, kind).toEqual(DOMAIN_MATRIX_KINDS[kind].inputs)
      expect(FAKE_KINDS[kind].output, kind).toBe(DOMAIN_MATRIX_KINDS[kind].output)
    }
  })

  it('le celle sono quelle che la migrazione semina davvero', () => {
    for (const kind of Object.keys(DOMAIN_MATRIX_KINDS) as DomainMatrixKind[]) {
      expect(FAKE_ENTRIES[kind], kind).toEqual(domainMatrixSeedEntries(kind))
    }
  })

  it('i vocabolari sono quelli spediti col prodotto', () => {
    for (const [name, values] of Object.entries(FAKE_VOCABULARIES)) {
      const shipped = SYSTEM_ENUMS.find((e) => e.name === name)
      expect(shipped, `vocabolario ${name} non è fra quelli spediti`).toBeDefined()
      expect(values, name).toEqual(shipped!.values)
    }
  })

  it('copre ogni vocabolario che le matrici dichiarano', () => {
    for (const spec of Object.values(DOMAIN_MATRIX_KINDS)) {
      for (const name of [...spec.inputs, spec.output]) {
        expect(FAKE_VOCABULARIES[name], `il doppio non conosce il vocabolario ${name}`).toBeDefined()
      }
    }
  })
})

/**
 * Lo stesso patto per il doppio delle **soglie di rischio** (rimedio 3): i
 * numeri sono ricopiati a mano in `riskBandsFake.ts` perché un mock non può
 * importare ciò che sostituisce, quindi qualcosa deve impedire che divergano.
 */
describe('riskBandsFake ↔ lib/riskBands.ts', () => {
  it('le soglie di fabbrica e il massimo sono gli stessi', async () => {
    const vero  = await import('../riskBands.js')
    const finto = await import('./riskBandsFake.js')
    expect(finto.FACTORY_RISK_THRESHOLDS).toEqual(vero.FACTORY_RISK_THRESHOLDS)
    expect(finto.MAX_RISK_SCORE).toBe(vero.MAX_RISK_SCORE)
  })

  it('`factoryThresholdsFor` si comporta allo stesso modo', async () => {
    const vero  = await import('../riskBands.js')
    const finto = await import('./riskBandsFake.js')
    expect(finto.factoryThresholdsFor(['a', 'b', 'c'])).toEqual(vero.factoryThresholdsFor(['a', 'b', 'c']))
    expect(finto.factoryThresholdsFor(['a', 'b'])).toBeNull()
    expect(vero.factoryThresholdsFor(['a', 'b'])).toBeNull()
  })

  it('il doppio non scrive, e lo dice invece di fingere', async () => {
    const finto = await import('./riskBandsFake.js')
    await expect(finto.setRiskBandThresholds()).rejects.toThrow(/questo doppio non scrive/)
  })
})
