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
