/**
 * Le formule dei campi calcolati NEL BROWSER (moduli del catalogo, ondata 6).
 *
 * Qui gira QuickJS vero, non una finta: il punto di questi test è che il
 * sandbox fa quello che promette — calcola, non esplode su una formula
 * sbagliata, e non vede niente della pagina. Il valore che conta lo scrive
 * comunque il server; questo è quello che l'utente vede mentre compila, e se
 * i due dessero numeri diversi sarebbe peggio che non mostrarlo affatto.
 */
import { describe, it, expect } from 'vitest'
import { computeFormulas, runFormula } from '../formulaRunner.js'

describe('runFormula', () => {
  it('calcola con le risposte in `input` e restituisce con `return`', async () => {
    expect(await runFormula('return input.costo * 2', { costo: 21 })).toEqual({ value: 42, error: null })
  })

  it('una formula che non restituisce niente dà «nessun valore», non zero', async () => {
    expect(await runFormula('const x = 1', {})).toEqual({ value: null, error: null })
  })

  it('un errore torna DENTRO l\'esito: chi compila non deve vedere la pagina rotta', async () => {
    const r = await runFormula('return input.a.b.c', {})
    expect(r.value).toBeNull()
    expect(r.error).toBeTruthy()
  })

  it('un errore di sintassi è un errore, non un valore', async () => {
    const r = await runFormula('return 1 +', {})
    expect(r.error).toBeTruthy()
  })

  it('il sandbox non vede la pagina: `window` e `fetch` non esistono', async () => {
    expect((await runFormula('return typeof window', {})).value).toBe('undefined')
    expect((await runFormula('return typeof fetch', {})).value).toBe('undefined')
  })

  it('i testi e le date si compongono come in JavaScript normale', async () => {
    expect((await runFormula('return input.nome.toUpperCase()', { nome: 'ada' })).value).toBe('ADA')
  })
})

describe('computeFormulas', () => {
  const campi = [
    { name: 'costo' },
    { name: 'totale', formula: 'return (input.costo || 0) * 1.22' },
    { name: 'raddoppio', formula: 'return input.totale * 2' },
  ]

  it('calcola tutti i campi con formula e lascia stare gli altri', async () => {
    const { values, errors } = await computeFormulas(campi, { costo: 100 })
    expect(values['totale']).toBeCloseTo(122)
    expect(Object.keys(values)).not.toContain('costo')
    expect(errors).toEqual({})
  })

  it('una formula NON vede gli altri campi calcolati: niente catene, quindi niente cicli', async () => {
    const { values } = await computeFormulas(campi, { costo: 100 })
    // `raddoppio` guarda `totale`, che è calcolato: per lui non esiste.
    expect(values['raddoppio']).toBeNull()
  })

  it('niente formule = niente lavoro (e niente WASM caricato)', async () => {
    expect(await computeFormulas([{ name: 'a' }, { name: 'b' }], { a: 1 })).toEqual({ values: {}, errors: {} })
  })

  it('l\'errore di una formula non ferma le altre', async () => {
    const { values, errors } = await computeFormulas([
      { name: 'rotta', formula: 'return pippo.pluto' },
      { name: 'sana', formula: 'return 7' },
    ], {})
    expect(errors['rotta']).toBeTruthy()
    expect(values['sana']).toBe(7)
  })
})
