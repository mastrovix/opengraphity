/**
 * Fail-fast contract for resolveTemplate: unresolved placeholders THROW.
 * The old behaviour left the literal `{incident.title}` in created entities
 * and a flat-key fallback could resolve a different field than the one named.
 */
import { describe, it, expect } from 'vitest'
import { resolveTemplate } from '../actions.js'

describe('resolveTemplate (fail-fast)', () => {
  it('resolves flat placeholders', () => {
    expect(resolveTemplate('Ciao {title}', { title: 'Incidente X' })).toBe('Ciao Incidente X')
  })

  it('resolves namespaced placeholders against a nested ctx', () => {
    const ctx = { title: 'Incidente X', incident: { title: 'Incidente X' } }
    expect(resolveTemplate('Investigazione: {incident.title}', ctx)).toBe('Investigazione: Incidente X')
  })

  it('THROWS on an unresolved placeholder instead of leaving the literal', () => {
    expect(() => resolveTemplate('Ciao {missing.field}', { title: 'x' }))
      .toThrow(/placeholder \{missing\.field\} did not resolve/)
  })

  /**
   * CONTRATTO RINEGOZIATO (revisione totale · E-10). Un campo che NON esiste
   * resta un errore: il template è sbagliato. Un campo che esiste ed è VUOTO è
   * un dato legittimo — un incident aperto dal portale senza descrizione — e
   * prima faceva fallire l'INTERA azione: il problem da creare non nasceva, e
   * l'errore finiva in `actionErrors`, che per gli incident il web non chiede.
   * Nessuna stringa «null» nei titoli: risolve al vuoto.
   */
  it('un campo che esiste ed è vuoto risolve al vuoto, non fa fallire l\'azione (E-10)', () => {
    expect(resolveTemplate('Da {title}: {description}', { title: 'DB giù', description: null })).toBe('Da DB giù: ')
    expect(resolveTemplate('{description}', { description: '' })).toBe('')
    // Nessuna stringa «null» o «undefined» finisce nel testo.
    expect(resolveTemplate('{description}', { description: undefined })).toBe('')
  })

  it('un campo che NON esiste resta un errore: il template è sbagliato', () => {
    expect(() => resolveTemplate('{description}', { title: 'x' })).toThrow(/did not resolve/)
  })

  it('does NOT fall back to the last path segment as a flat key', () => {
    // Old behaviour: {other.title} would silently resolve ctx.title — a
    // DIFFERENT field than the template named.
    expect(() => resolveTemplate('{other.title}', { title: 'x' }))
      .toThrow(/did not resolve/)
  })
})
