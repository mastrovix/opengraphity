import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { cssVar, cssVarPx, resetCssVarCache } from './cssVar'
import { setCssVars } from '@/test/utils'

let cleanup: () => void = () => {}
beforeEach(() => { resetCssVarCache() })
afterEach(() => { cleanup(); cleanup = () => {} })

describe('cssVar', () => {
  it('risolve il valore letto da :root (trim incluso)', () => {
    cleanup = setCssVars({ '--color-brand': '  #0284c7 ' })
    expect(cssVar('--color-brand')).toBe('#0284c7')
  })

  it('variabile non definita → throw con il nome (fail-loud, nessun default)', () => {
    expect(() => cssVar('--missing-token')).toThrow('[cssVar] variabile CSS non definita in :root: --missing-token')
  })

  it('valore vuoto conta come non definito', () => {
    cleanup = setCssVars({ '--empty': '' })
    expect(() => cssVar('--empty')).toThrow(/non definita/)
  })

  it('memoizza: dopo il primo hit non rilegge :root finché resetCssVarCache()', () => {
    cleanup = setCssVars({ '--x': '1px' })
    expect(cssVar('--x')).toBe('1px')
    document.documentElement.style.setProperty('--x', '2px')
    expect(cssVar('--x')).toBe('1px')
    resetCssVarCache()
    expect(cssVar('--x')).toBe('2px')
  })
})

describe('cssVarPx', () => {
  it('"14px" → 14, "12.5px" → 12.5', () => {
    cleanup = setCssVars({ '--font-size-body': '14px', '--half': '12.5px' })
    expect(cssVarPx('--font-size-body')).toBe(14)
    expect(cssVarPx('--half')).toBe(12.5)
  })
  it('valore non numerico → throw con nome e valore', () => {
    cleanup = setCssVars({ '--font-family': 'Inter, sans-serif' })
    expect(() => cssVarPx('--font-family')).toThrow('[cssVar] --font-family non è una misura in px: "Inter, sans-serif"')
  })
  it('variabile assente → stesso errore di cssVar', () => {
    expect(() => cssVarPx('--nope')).toThrow(/non definita in :root: --nope/)
  })
})
