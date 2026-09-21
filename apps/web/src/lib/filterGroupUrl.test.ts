/**
 * Il gruppo del costruttore di filtri dentro l'URL (C-15 / residuo D·1.7):
 * andata e ritorno senza perdite, e — soprattutto — la differenza fra «non c'è
 * nessun filtro» e «c'è un filtro che non so leggere». Confonderli mostrerebbe
 * più righe di quante il collegamento prometteva, in silenzio.
 */
import { describe, it, expect } from 'vitest'
import { decodeFilterGroup, encodeFilterGroup } from './filterGroupUrl'
import type { FilterGroup, FilterRule } from '@/components/FilterBuilder'

const rule = (over: Partial<FilterRule> = {}): FilterRule => ({
  id: 'r1', field: 'title', operator: 'contains', value: 'Disk', logic: 'AND', ...over,
})

describe('filterGroupUrl', () => {
  it('andata e ritorno: le regole tornano identiche', () => {
    const group: FilterGroup = { rules: [rule(), rule({ id: 'r2', field: 'severity', operator: 'in', value: ['critical', 'warning'], logic: 'OR' })] }
    const encoded = encodeFilterGroup(group)
    expect(encoded).not.toBeNull()
    expect(decodeFilterGroup(encoded)).toEqual(group)
  })

  it('il valore è sicuro per un URL: niente +, / o = da ricodificare', () => {
    // Un valore con accenti e simboli: base64 «normale» produrrebbe + e /.
    const encoded = encodeFilterGroup({ rules: [rule({ value: 'però?/+ è' })] })!
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(decodeFilterGroup(encoded)).toEqual({ rules: [rule({ value: 'però?/+ è' })] })
  })

  it('niente gruppo o gruppo vuoto: niente parametro', () => {
    expect(encodeFilterGroup(null)).toBeNull()
    expect(encodeFilterGroup({ rules: [] })).toBeNull()
  })

  it('parametro assente o vuoto: nessun filtro (non è un errore)', () => {
    expect(decodeFilterGroup(null)).toBeNull()
    expect(decodeFilterGroup('')).toBeNull()
  })

  it('parametro illeggibile o incoerente: «invalid», mai «nessun filtro»', () => {
    expect(decodeFilterGroup('non-base64!!')).toBe('invalid')
    expect(decodeFilterGroup(btoa('{"rules":'))).toBe('invalid')          // JSON troncato
    expect(decodeFilterGroup(btoa('"una stringa"'))).toBe('invalid')      // non un oggetto
    expect(decodeFilterGroup(btoa('{"rules":[]}'))).toBe('invalid')       // un `?f=` che non filtra nulla non è un filtro
    expect(decodeFilterGroup(btoa('{"rules":[{"id":"r1","field":"title","operator":"inventato","logic":"AND","value":"x"}]}'))).toBe('invalid')
    expect(decodeFilterGroup(btoa('{"rules":[{"id":"r1","field":"","operator":"contains","logic":"AND","value":"x"}]}'))).toBe('invalid')
    expect(decodeFilterGroup(btoa('{"rules":[{"id":"r1","field":"title","operator":"contains","logic":"XOR","value":"x"}]}'))).toBe('invalid')
    expect(decodeFilterGroup(btoa('{"rules":[{"id":"r1","field":"title","operator":"in","logic":"AND","value":[1,2]}]}'))).toBe('invalid')
  })

  it('gli operatori senza valore restano validi (`value: null`)', () => {
    const group: FilterGroup = { rules: [rule({ operator: 'is_empty', value: null })] }
    expect(decodeFilterGroup(encodeFilterGroup(group))).toEqual(group)
  })

  it('`between` conserva il secondo estremo', () => {
    const group: FilterGroup = { rules: [rule({ field: 'lastSeenAt', operator: 'between', value: '2026-09-01', value2: '2026-09-10' })] }
    expect(decodeFilterGroup(encodeFilterGroup(group))).toEqual(group)
  })
})
