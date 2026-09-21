/**
 * lib/deployWindows.ts — parser dei passi del piano di rilascio (JSON corrotto
 * → errore, mai un piano vuoto) e predicato "istante in finestra" usato dalla
 * soppressione degli allarmi.
 */
import { describe, it, expect } from 'vitest'
import { GraphQLError } from 'graphql'
import { parseDeploySteps, windowContains, anyDeployWindowContains, assertWindowDate } from '../deployWindows.js'

const AT = Date.parse('2026-09-09T10:00:00Z')

describe('assertWindowDate (1.17: fuso esplicito)', () => {
  it('vuota → vuota; Z, +02:00, -0500 → accettate; senza offset o non parsabile → ValidationError (BAD_USER_INPUT) con il campo', () => {
    expect(assertWindowDate('', 'f')).toBe('')
    expect(assertWindowDate(undefined, 'f')).toBe('')
    expect(assertWindowDate('2026-09-09T10:00:00Z', 'f')).toBe('2026-09-09T10:00:00Z')
    expect(assertWindowDate('2026-09-09T10:00:00.000Z', 'f')).toBe('2026-09-09T10:00:00.000Z')
    expect(assertWindowDate('2026-09-09T12:00:00+02:00', 'f')).toBe('2026-09-09T12:00:00+02:00')
    expect(assertWindowDate('2026-09-09T05:00:00-0500', 'f')).toBe('2026-09-09T05:00:00-0500')
    for (const bad of ['2026-09-09T22:00', '2026-09-09T22:00:00', '2026-09-09']) {
      const err = (() => { try { assertWindowDate(bad, 'steps[0].releaseWindow.start'); return null } catch (e) { return e as GraphQLError } })()
      expect(err).toBeInstanceOf(GraphQLError)
      expect(err!.extensions['code']).toBe('BAD_USER_INPUT')
      expect(err!.message).toMatch(/steps\[0\]\.releaseWindow\.start must carry an explicit UTC offset/)
    }
    expect(() => assertWindowDate('ieri', 'f')).toThrow(/f is not an ISO 8601 date/)
  })
})

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

  it('(1.17) una finestra con data senza offset esplicito → ValidationError che indica passo e campo; con offset → accettata', () => {
    const local = JSON.stringify([{ title: 'ok', validationWindow: { start: '2026-09-09T08:00:00Z', end: '2026-09-09T09:00:00Z' }, releaseWindow: { start: '2026-09-09T22:00', end: '2026-09-09T23:00Z' } }])
    expect(() => parseDeploySteps(local)).toThrow(/steps\[0\]\.releaseWindow\.start must carry an explicit UTC offset/)
    const offset = JSON.stringify([{ title: 'ok', validationWindow: { start: '', end: '' }, releaseWindow: { start: '2026-09-10T00:00:00+02:00', end: '2026-09-10T01:00:00+02:00' } }])
    expect(parseDeploySteps(offset)[0]!.releaseWindow).toEqual({ start: '2026-09-10T00:00:00+02:00', end: '2026-09-10T01:00:00+02:00' })
    // la soppressione confronta millisecondi assoluti: 00:00+02:00 = 22:00Z del giorno prima
    expect(anyDeployWindowContains([offset], Date.parse('2026-09-09T22:30:00Z'))).toBe(true)
    expect(() => anyDeployWindowContains([local], AT)).toThrow(/explicit UTC offset/)
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
