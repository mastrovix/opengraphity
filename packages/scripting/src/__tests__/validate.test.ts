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

  it('un apice ESCAPATO non chiude la stringa: quello che segue resta testo', () => {
    // Senza la gestione del `\\`, la stringa si chiuderebbe a metà e la parte
    // dopo tornerebbe a essere «codice» — con dentro `process.`.
    expect(validateScript("return 'l\\'ora di process.env'").valid).toBe(true)
  })
})

describe('gli altri rifiuti, uno per uno', () => {
  it.each([
    ['require',        'const x = require("fs")',          'require()'],
    ['import()',       'return import("fs")',              'Dynamic import()'],
    ['new Function',   'return new Function("return 1")',  'new Function()'],
    ['__dirname',      'return __dirname',                 '__dirname'],
    ['__filename',     'return __filename',                '__dirname'],
    ['globalThis',     'return globalThis.process',        'globalThis'],
    ['while(true)',    'while (true) { }',                 'Infinite loops'],
    ['for(;;)',        'for (;;) { }',                     'Infinite loops'],
  ])('%s si rifiuta, e il messaggio dice cosa', (_nome, codice, atteso) => {
    const r = validateScript(codice)
    expect(r.valid).toBe(false)
    expect(r.errors.join(' | ')).toContain(atteso)
  })

  it('uno script vuoto si ferma SUBITO: un solo errore, non l\'elenco di tutti i divieti', () => {
    for (const vuoto of ['', '   ', '\n\t ']) {
      expect(validateScript(vuoto)).toEqual({ valid: false, errors: ['Script must not be empty'] })
    }
  })

  it('uno script troppo lungo si rifiuta, e gli ALTRI controlli girano lo stesso', () => {
    const lunghissimo = `return ${'"x"+'.repeat(13_000)}1`
    const r = validateScript(lunghissimo)
    expect(r.valid).toBe(false)
    expect(r.errors[0]).toContain('exceeds maximum length')
  })

  it('un codice che li viola TUTTI li elenca tutti: chi corregge li vede in un colpo', () => {
    const r = validateScript('import x from "y"\nreturn process.env && eval("1") && require("fs")')
    expect(r.errors.length).toBeGreaterThanOrEqual(4)
  })

  it('uno script sano passa', () => {
    expect(validateScript('const n = ctx.incident.severity\nreturn n === "high" ? 1 : 0'))
      .toEqual({ valid: true, errors: [] })
  })
})
