/**
 * The word allow-list of the server-log scrubber, in the forms of a word that
 * the vocabulary does not hold VERBATIM.
 *
 * The persisted log archive crosses the tenant perimeter, so a word survives
 * only if the product itself writes it. Case matters: many Italian surnames are
 * also common words ("Costa", "Conti"), so a Capitalised form mid-sentence is
 * masked unless it is literally in the vocabulary. What must keep holding:
 *  - the all-lowercase form of a known word survives (always the safe side);
 *  - an ALL-CAPS form survives (acronyms: SLA, HTTP);
 *  - a Capitalised form survives only at the start of a sentence.
 * If this regresses in the permissive direction, customer names reach the
 * shared archive; in the strict one, templates fill up with `<w>` and stop
 * grouping errors.
 *
 * The words are picked from the generated vocabulary at run time so the test
 * does not depend on which literals the repository happens to contain today.
 */
import { describe, it, expect } from 'vitest'
import { sopravvive, normalizzaMessaggio, primaRigaDiStack, MAX_STACK_HEAD, SEGNAPOSTO } from '../serverLogScrub.js'
import { VOCABOLARIO_DEI_LOG } from '../vocabolarioDeiLog.js'

/** A camelCase word whose lowercase, UPPERCASE and Capitalised forms are all absent verbatim. */
const base = [...VOCABOLARIO_DEI_LOG].find((w) => {
  if (!/^[a-z]+[A-Z][a-z]+$/.test(w)) return false
  const lower = w.toLowerCase()
  const cap = lower[0]!.toUpperCase() + lower.slice(1)
  return !VOCABOLARIO_DEI_LOG.has(lower) && !VOCABOLARIO_DEI_LOG.has(w.toUpperCase()) && !VOCABOLARIO_DEI_LOG.has(cap)
})!
const lower = base.toLowerCase()
const upper = base.toUpperCase()
const capitalised = lower[0]!.toUpperCase() + lower.slice(1)

describe('sopravvive — forms not stored verbatim in the vocabulary', () => {
  it('the fixture word exists (the vocabulary still has camelCase identifiers)', () => {
    expect(base).toBeTruthy()
  })

  it('the lowercase form of a known word survives anywhere', () => {
    expect(sopravvive(lower, false)).toBe(true)
    expect(sopravvive(lower, true)).toBe(true)
  })

  it('the ALL-CAPS form survives anywhere (it reads as an acronym, not a name)', () => {
    expect(sopravvive(upper, false)).toBe(true)
  })

  it('the Capitalised form survives only where capitalisation is grammar', () => {
    expect(sopravvive(capitalised, true)).toBe(true)
    expect(sopravvive(capitalised, false)).toBe(false)
  })

  it('in a real message the Capitalised form is masked mid-sentence and kept after a full stop', () => {
    expect(normalizzaMessaggio(`${lower} ${capitalised}`).template).toBe(`${lower} ${SEGNAPOSTO.w}`)
    expect(normalizzaMessaggio(`${lower}. ${capitalised}`).template).toBe(`${lower}. ${capitalised}`)
  })
})

describe('inputs at the edges', () => {
  it('a missing message becomes an empty template instead of throwing inside the log sink', () => {
    expect(normalizzaMessaggio(null as unknown as string)).toEqual({ template: '', sostituzioni: 0, mascherate: 0, tagliato: false })
  })

  it('a stack line longer than MAX_STACK_HEAD is cut and marked with an ellipsis', () => {
    const longPath = `at ${Array.from({ length: 80 }, () => lower).join(' ')}`
    const head = primaRigaDiStack(`Error: boom\n    ${longPath}`)!
    expect(head.endsWith('…')).toBe(true)
    expect(head.length).toBe(MAX_STACK_HEAD + 1)
  })
})

// Review of 23 Sep 2026: the word class stopped at Latin-1, and names in other scripts passed as they were.
describe('names in any script are masked', () => {
  it.each([
    ['SLA engine failed for tenant Ярослав Петров', 'SLA engine failed for tenant <w>'],
    ['User 山田太郎 not found', 'User <w> not found'],
    ['Customer Ελληνική Εταιρεία rejected', 'Customer <w> rejected'],
    ['Contract renewal for Łukasz Żółkiewski expired', 'Contract <w> for <w> expired'],
  ])('%s', async (message, expected) => {
    const { normalizzaMessaggio } = await import('../serverLogScrub.js')
    const out = normalizzaMessaggio(message)
    expect(out.template).toBe(expected)
    expect(out.mascherate).toBeGreaterThan(0)
  })
})
