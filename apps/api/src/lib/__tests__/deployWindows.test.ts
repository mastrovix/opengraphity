/**
 * lib/deployWindows.ts — parser dei passi del piano di rilascio (JSON corrotto
 * → errore, mai un piano vuoto) e predicato "istante in finestra" usato dalla
 * soppressione degli allarmi.
 */
import { describe, it, expect } from 'vitest'
import { parseDeploySteps, windowContains, anyDeployWindowContains } from '../deployWindows.js'

const AT = Date.parse('2026-09-09T10:00:00Z')

describe('parseDeploySteps', () => {
  it('stringa vuota / non stringa → []; passi non oggetto scartati; campi mancanti → stringhe vuote', () => {
    expect(parseDeploySteps('')).toEqual([])
    expect(parseDeploySteps(null)).toEqual([])
    expect(parseDeploySteps(JSON.stringify([{ title: 'a' }, 'x', null]))).toEqual([{ title: 'a', validationWindow: { start: '', end: '' }, releaseWindow: { start: '', end: '' } }])
  })

  it('JSON corrotto o non lista → errore esplicito', () => {
    expect(() => parseDeploySteps('{nope')).toThrow(/Corrupt deploy steps JSON/)
    expect(() => parseDeploySteps('{"a":1}')).toThrow(/not an array/)
  })
})

describe('windowContains / anyDeployWindowContains', () => {
  it('start ≤ at ≤ end; estremi inclusi; finestra vuota o non parsabile → false', () => {
    expect(windowContains({ start: '2026-09-09T09:00:00Z', end: '2026-09-09T11:00:00Z' }, AT)).toBe(true)
    expect(windowContains({ start: '2026-09-09T10:00:00Z', end: '2026-09-09T10:00:00Z' }, AT)).toBe(true)
    expect(windowContains({ start: '2026-09-09T10:00:01Z', end: '2026-09-09T11:00:00Z' }, AT)).toBe(false)
    expect(windowContains({ start: '', end: '2026-09-09T11:00:00Z' }, AT)).toBe(false)
    expect(windowContains({ start: 'ieri', end: 'domani' }, AT)).toBe(false)
  })

  it('anyDeployWindowContains: vero se una releaseWindow O una validationWindow di un passo di un piano contiene l\'istante; i piani null si ignorano', () => {
    const release = JSON.stringify([{ title: 'r', validationWindow: { start: '', end: '' }, releaseWindow: { start: '2026-09-09T09:00:00Z', end: '2026-09-09T11:00:00Z' } }])
    const validation = JSON.stringify([{ title: 'v', validationWindow: { start: '2026-09-09T09:30:00Z', end: '2026-09-09T10:30:00Z' }, releaseWindow: { start: '', end: '' } }])
    const past = JSON.stringify([{ title: 'p', validationWindow: { start: '2026-09-08T09:00:00Z', end: '2026-09-08T11:00:00Z' }, releaseWindow: { start: '2026-09-08T12:00:00Z', end: '2026-09-08T13:00:00Z' } }])
    expect(anyDeployWindowContains([null, release], AT)).toBe(true)
    expect(anyDeployWindowContains([validation], AT)).toBe(true)
    expect(anyDeployWindowContains([past, null, '[]'], AT)).toBe(false)
    expect(anyDeployWindowContains([], AT)).toBe(false)
    expect(() => anyDeployWindowContains(['{bad'], AT)).toThrow(/Corrupt deploy steps JSON/)
  })
})
