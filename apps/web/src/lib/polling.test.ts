import { describe, it, expect, afterEach } from 'vitest'
import { pausedWhenHidden, isDocumentHidden } from './polling'

/** jsdom espone `document.hidden` in sola lettura: lo si ridefinisce per il test. */
function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
}

describe('pausedWhenHidden', () => {
  afterEach(() => { setHidden(false) })

  it('restituisce pollInterval e skipPollAttempt', () => {
    const opts = pausedWhenHidden(15_000)
    expect(opts.pollInterval).toBe(15_000)
    expect(typeof opts.skipPollAttempt).toBe('function')
  })

  it('a scheda visibile il tick non è saltato', () => {
    setHidden(false)
    expect(pausedWhenHidden(1000).skipPollAttempt()).toBe(false)
    expect(isDocumentHidden()).toBe(false)
  })

  it('a scheda nascosta il tick è saltato; torna a interrogare quando riappare', () => {
    const { skipPollAttempt } = pausedWhenHidden(1000)
    setHidden(true)
    expect(skipPollAttempt()).toBe(true)
    setHidden(false)
    expect(skipPollAttempt()).toBe(false)
  })

  it('intervallo non valido → errore, non un polling silenzioso a 0', () => {
    expect(() => pausedWhenHidden(0)).toThrow(/pollInterval non valido/)
    expect(() => pausedWhenHidden(Number.NaN)).toThrow(/pollInterval non valido/)
  })
})
