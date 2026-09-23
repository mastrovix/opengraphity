/**
 * The tenant's vocabularies in the browser: one query, read by every badge,
 * dropdown and matrix of the app.
 *
 * What breaks for a user if these contracts regress:
 * - precedence: the tenant's own vocabulary must win over the shipped one with
 *   the same name, or a customer who re-labelled «high» still reads the
 *   product's label everywhere;
 * - `null` is "we do not know", never "empty": while the query is running or
 *   has failed, a badge must not decide that every value is out of the
 *   vocabulary and paint the whole table red;
 * - the language is part of the query: without it, switching language from
 *   the profile would keep the labels of the previous one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { apolloFinto } from '@/test/apolloFinto'
import { DomainVocabularyProvider, useDomainVocabularies, withOwnLabel, type DomainVocabularies } from './DomainVocabularyContext'

// The fake Apollo always answers "loaded"; this flag lets a test hold the query in flight.
const inFlight = vi.hoisted(() => ({ loading: false }))
vi.mock('@apollo/client/react', async () => {
  const m = (await import('@/test/apolloFinto')).moduloApollo()
  return {
    ...m,
    useQuery: (...args: Parameters<typeof m.useQuery>) => {
      const r = m.useQuery(...args)
      return inFlight.loading ? { ...r, data: undefined, loading: true } : r
    },
  }
})

const row = (over: Record<string, unknown>) => ({
  name: 'impact', label: 'Impact', values: ['high', 'low'], isShipped: false,
  valueLabels: [{ value: 'high', label: 'High', labels: [] }, { value: 'low', label: 'Low', labels: [] }],
  valueColors: [{ value: 'high', color: 'red' }],
  ...over,
})

let seen: DomainVocabularies | null = null
function Probe() {
  seen = useDomainVocabularies()
  return <span>{seen.loading ? 'loading' : 'ready'}</span>
}

const mount = () => render(<DomainVocabularyProvider><Probe /></DomainVocabularyProvider>)

beforeEach(() => { apolloFinto.reset(); inFlight.loading = false; seen = null })

describe('DomainVocabularyProvider', () => {
  it('the tenant vocabulary wins over the shipped one with the same name; a shipped-only one is still read', () => {
    apolloFinto.risposte['GetEnumTypes'] = { enumTypes: [
      row({ isShipped: true, label: 'Impact (shipped)', values: ['a'], valueLabels: [{ value: 'a', label: 'A', labels: [] }], valueColors: [] }),
      row({}),
      row({ name: 'urgency', label: '', isShipped: true, values: ['now'], valueLabels: [], valueColors: [] }),
    ] }
    mount()
    const v = seen!
    expect(v.valuesOf('impact')).toEqual(['high', 'low'])
    expect(v.labelOf('impact', 'high')).toBe('High')
    expect(v.colorOf('impact', 'high')).toBe('red')
    expect(v.entriesOf('impact')?.map((e) => e.value)).toEqual(['high', 'low'])
    expect(v.vocabularyLabelOf('impact')).toBe('Impact')
    expect(v.valuesOf('urgency')).toEqual(['now'])
    // An empty vocabulary label is "unknown", so callers fall back to the name.
    expect(v.vocabularyLabelOf('urgency')).toBeNull()
    expect(v.error).toBeNull()
  })

  it('a value outside the vocabulary, or a colour nobody assigned, is null — never an invented label', () => {
    apolloFinto.risposte['GetEnumTypes'] = { enumTypes: [row({})] }
    mount()
    expect(seen!.labelOf('impact', 'medium')).toBeNull()
    expect(seen!.colorOf('impact', 'low')).toBeNull()
    expect(seen!.valuesOf('nope')).toBeNull()
    expect(seen!.entriesOf('nope')).toBeNull()
  })

  it('asks for the labels in the viewer language', () => {
    apolloFinto.risposte['GetEnumTypes'] = { enumTypes: [] }
    mount()
    expect(apolloFinto.chiamata('GetEnumTypes')).toEqual({ language: 'en' })
  })

  it('while the query runs everything is unknown (null), not empty', () => {
    apolloFinto.risposte['GetEnumTypes'] = { enumTypes: [row({})] }
    inFlight.loading = true
    mount()
    expect(screen.getByText('loading')).toBeInTheDocument()
    expect(seen!.valuesOf('impact')).toBeNull()
    expect(seen!.labelOf('impact', 'high')).toBeNull()
  })

  it('a failed query exposes its message and answers null, so badges stay neutral instead of red', () => {
    apolloFinto.erroriQuery['GetEnumTypes'] = new Error('network down')
    mount()
    expect(seen!.error).toBe('network down')
    expect(seen!.valuesOf('impact')).toBeNull()
  })

  it('a null list from the server is treated as no vocabularies at all', () => {
    apolloFinto.risposte['GetEnumTypes'] = { enumTypes: null }
    mount()
    expect(seen!.valuesOf('impact')).toBeNull()
    expect(seen!.loading).toBe(false)
  })
})

describe('useDomainVocabularies without a provider', () => {
  it('answers null for everything (a badge rendered on its own in a test or a portal)', () => {
    render(<Probe />)
    const v = seen!
    expect([v.valuesOf('x'), v.labelOf('x', 'y'), v.colorOf('x', 'y'), v.entriesOf('x'), v.vocabularyLabelOf('x')]).toEqual([null, null, null, null, null])
    expect(v.error).toBeNull()
    expect(screen.getByText('ready')).toBeInTheDocument()
  })
})

/**
 * D29 (tour of 23 Sep 2026): a value nobody labelled came with the API's
 * fallback label — every word capitalised — and «Pick up at the IT desk» was
 * shown «Pick Up At The IT Desk». The fallback is recognised (it is not among
 * the labels actually written) and replaced by the one shared rule.
 */
describe('the label of a value nobody labelled (D29)', () => {
  it('a sentence stays as the customer wrote it', () => {
    expect(withOwnLabel({ value: 'Pick up at the IT desk', label: 'Pick Up At The IT Desk', labels: [] }).label).toBe('Pick up at the IT desk')
  })

  it('a machine key becomes a sentence', () => {
    expect(withOwnLabel({ value: 'in_progress', label: 'In Progress', labels: [] }).label).toBe('In progress')
  })

  it('a label written in the Dictionary is kept, in any case', () => {
    const written = { value: 'in_progress', label: 'In Progress', labels: [{ language: 'en', label: 'In Progress' }] }
    expect(withOwnLabel(written)).toBe(written)
  })

  it('a label written only in ANOTHER language is not this one: the fallback is replaced', () => {
    const row = { value: 'on_hold', label: 'On Hold', labels: [{ language: 'it', label: 'In attesa' }] }
    expect(withOwnLabel(row).label).toBe('On hold')
  })

  it('through the provider: labelOf and entriesOf both read the corrected label', () => {
    apolloFinto.risposte['GetEnumTypes'] = { enumTypes: [row({
      name: 'delivery', values: ['Pick up at the IT desk', 'courier'],
      valueLabels: [
        { value: 'Pick up at the IT desk', label: 'Pick Up At The IT Desk', labels: [] },
        { value: 'courier', label: 'By courier', labels: [{ language: 'en', label: 'By courier' }] },
      ],
    })] }
    mount()
    expect(seen!.labelOf('delivery', 'Pick up at the IT desk')).toBe('Pick up at the IT desk')
    expect(seen!.labelOf('delivery', 'courier')).toBe('By courier')
    expect(seen!.entriesOf('delivery')?.map((e) => e.label)).toEqual(['Pick up at the IT desk', 'By courier'])
  })
})
