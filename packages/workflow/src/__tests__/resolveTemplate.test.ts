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

  it('THROWS when the named field is null — no "null" strings in titles', () => {
    expect(() => resolveTemplate('{description}', { description: null }))
      .toThrow(/did not resolve/)
  })

  it('does NOT fall back to the last path segment as a flat key', () => {
    // Old behaviour: {other.title} would silently resolve ctx.title — a
    // DIFFERENT field than the template named.
    expect(() => resolveTemplate('{other.title}', { title: 'x' }))
      .toThrow(/did not resolve/)
  })
})
