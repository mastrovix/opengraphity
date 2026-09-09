/**
 * lib/ciNameKey.ts — chiave di ricerca per nome dei CI (minuscola, senza spazi
 * ai bordi), scritta da chi crea/rinomina un CI e letta da matchCI.
 */
import { describe, it, expect } from 'vitest'
import { ciNameKey } from '../ciNameKey.js'

describe('ciNameKey', () => {
  it('minuscolo e senza spazi ai bordi; vuoto o non stringa → null (mai una chiave fabbricata)', () => {
    expect(ciNameKey('DB-01')).toBe('db-01')
    expect(ciNameKey('  Web-01.Example.local ')).toBe('web-01.example.local')
    expect(ciNameKey('')).toBeNull()
    expect(ciNameKey('   ')).toBeNull()
    expect(ciNameKey(null)).toBeNull()
    expect(ciNameKey(undefined)).toBeNull()
    expect(ciNameKey(42)).toBeNull()
  })
})
