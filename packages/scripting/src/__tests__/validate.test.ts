import { describe, it, expect } from 'vitest'
import { validateScript } from '../validate.js'

/**
 * E-34 (revisione totale): i controlli sono espressioni regolari sul testo, e
 * rifiutavano uno script per una parola in un COMMENTO o in una STRINGA. Ora
 * commenti e stringhe non contano; il codice vero sì.
 */
describe('E-34 — commenti e stringhe non fanno rifiutare uno script', () => {
  it('«import» in un commento o in una stringa passa; un import vero no', () => {
    expect(validateScript('// import rules from the CMDB\nreturn 1').valid).toBe(true)
    expect(validateScript('/* import the CI list */ return 1').valid).toBe(true)
    expect(validateScript("return 'import data'").valid).toBe(true)
    expect(validateScript("import fs from 'fs'\nreturn 1").valid).toBe(false)
  })

  it('anche gli altri divieti guardano il codice, non il testo', () => {
    expect(validateScript("return 'use process.env'").valid).toBe(true)
    expect(validateScript('// eval() è vietato\nreturn 2').valid).toBe(true)
    expect(validateScript('return process.env.SECRET').valid).toBe(false)
    expect(validateScript('return eval("1+1")').valid).toBe(false)
  })

  it('le stringhe non chiuse e i commenti non chiusi non fanno cadere il controllo', () => {
    expect(() => validateScript('return "senza fine')).not.toThrow()
    expect(() => validateScript('/* senza fine')).not.toThrow()
  })
})
