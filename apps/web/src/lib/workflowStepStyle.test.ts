/**
 * Workflow step badges and transition buttons are coloured by the step's
 * CATEGORY, which tenants edit in the designer. If this lookup regresses, a
 * "Resolve" button stops looking like the primary action, a failed step
 * looks like a harmless draft, or — worse — a tenant's new category renders
 * silently neutral and nobody notices the map is missing it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SOFT_BUTTON, styleForCategory, buttonStyleForCategory, isDestructiveTransition, transitionButtonColors, DANGER_BUTTON, BRAND_BUTTON, REJECTION_INPUT_FIELD } from './workflowStepStyle'

afterEach(() => { vi.restoreAllMocks() })

describe('styleForCategory', () => {
  it('gives each known category its own colours, distinct from the neutral fallback', () => {
    const neutral = styleForCategory(null)
    for (const category of ['active', 'waiting', 'escalated', 'resolved', 'failed']) {
      const s = styleForCategory(category)
      expect(s.bg).toBeTruthy()
      expect(s.color).toBeTruthy()
      expect(s).not.toEqual(neutral)
    }
    // resolved and published are the same outcome for the user: same colour.
    expect(styleForCategory('published')).toEqual(styleForCategory('resolved'))
    // failed must never look like success.
    expect(styleForCategory('failed')).not.toEqual(styleForCategory('resolved'))
  })

  it('a step without a category is neutral and is not an error', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(styleForCategory(undefined)).toEqual(styleForCategory(''))
    expect(styleForCategory(null)).toEqual(styleForCategory('draft'))
    expect(err).not.toHaveBeenCalled()
  })

  it('an unknown category falls back to neutral but says so on the console (no silent fallback)', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(styleForCategory('tenant_custom')).toEqual(styleForCategory(null))
    expect(err).toHaveBeenCalledWith(expect.stringContaining('"tenant_custom"'))
  })
})

describe('buttonStyleForCategory', () => {
  it('outcome categories get a solid button whose border matches its background', () => {
    for (const category of ['resolved', 'published', 'escalated', 'failed']) {
      const s = buttonStyleForCategory(category)
      expect(s.backgroundColor).toBe(s.borderColor)
      expect(s.backgroundColor).not.toBe('var(--color-brand)')
    }
    // Escalating/failing is a warning action, resolving is a positive one.
    expect(buttonStyleForCategory('failed').backgroundColor).not.toBe(buttonStyleForCategory('resolved').backgroundColor)
  })

  it('closing is a quiet, outlined button, not a loud solid one', () => {
    expect(buttonStyleForCategory('closed')).toEqual({ backgroundColor: 'transparent', color: 'var(--text-primary)', borderColor: 'var(--border)' })
  })

  it('any other (or missing) category uses the soft neutral style: sugar-paper blue (26 Sep 2026)', () => {
    const brand = { backgroundColor: 'var(--color-section-head)', borderColor: 'var(--color-section-head)', color: 'var(--color-section-head-text)' }
    expect(buttonStyleForCategory('active')).toMatchObject(brand)
    expect(buttonStyleForCategory(null)).toMatchObject(brand)
    expect(buttonStyleForCategory(undefined)).toMatchObject(brand)
    expect(buttonStyleForCategory('tenant_custom')).toMatchObject(brand)
  })
})

/**
 * D27 (tour of 23 Sep 2026): the only action on a request in approval was
 * «Reject», drawn as the blue primary button. What ends a ticket badly is
 * decided HERE, from the workflow's metadata, for every page that draws
 * transitions.
 */
describe('isDestructiveTransition', () => {
  it('a transition towards a step of category «failed» (cancelled, rejected) is destructive', () => {
    expect(isDestructiveTransition('failed')).toBe(true)
    expect(isDestructiveTransition('failed', null)).toBe(true)
  })

  it('a transition that asks for a rejection reason is destructive whatever the category: the shipped «rejected» request step is filed under «closed»', () => {
    expect(REJECTION_INPUT_FIELD).toBe('rejection_reason')
    expect(isDestructiveTransition('closed', 'rejection_reason')).toBe(true)
    expect(isDestructiveTransition(null, 'rejection_reason')).toBe(true)
  })

  it('anything else is not: closing, resolving, moving on, asking for notes or a root cause', () => {
    for (const [category, input] of [['closed', null], ['resolved', 'rootCause'], ['active', 'notes'], [null, null], [undefined, undefined]] as const) {
      expect(isDestructiveTransition(category, input), `${String(category)} / ${String(input)}`).toBe(false)
    }
  })

  it('the step NAME plays no part: a step called «rejected» with no such metadata is not destructive', () => {
    // The page receives names too, but a customer renames steps: only metadata decides.
    expect(isDestructiveTransition('active', null)).toBe(false)
  })
})

describe('transitionButtonColors', () => {
  it('a destructive transition is always danger, in both palettes', () => {
    expect(transitionButtonColors('closed', 'rejection_reason', 'brand')).toEqual(DANGER_BUTTON)
    expect(transitionButtonColors('failed', null, 'byCategory')).toEqual(DANGER_BUTTON)
    expect(DANGER_BUTTON.backgroundColor).toBe('var(--color-danger)')
  })

  it('otherwise: the category colours or the soft neutral style; the brand palette keeps the primary style', () => {
    expect(transitionButtonColors('resolved', null, 'byCategory')).toEqual(buttonStyleForCategory('resolved'))
    expect(transitionButtonColors('resolved', null, 'brand')).toEqual(BRAND_BUTTON)
    expect(transitionButtonColors(null, null, 'byCategory')).toEqual(SOFT_BUTTON)
  })

  it('the failed category and the danger style are the same thing', () => {
    expect(buttonStyleForCategory('failed')).toEqual(DANGER_BUTTON)
  })
})
