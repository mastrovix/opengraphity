/**
 * The shared ITSM badges show values that users read in every list. What
 * must not regress: step names are shown with spaces rather than raw
 * snake_case, and a CI without an environment shows a dash — not the word
 * "null" that `String(v)` used to print — while a known environment shows
 * the tenant's Dictionary label rather than the raw key.
 */
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TypeBadge, PriorityBadge, StepBadge, EnvBadge } from './Badges'
import { withVocabularyLabels } from '@/test/vocabularies'

describe('ITSM badges', () => {
  it('type and priority show their value as given', () => {
    render(<><TypeBadge type="normal" /><PriorityBadge priority="P1" /></>)
    expect(screen.getByText('normal')).toBeInTheDocument()
    expect(screen.getByText('P1')).toBeInTheDocument()
  })

  it('a step name is shown with every underscore turned into a space', () => {
    render(<StepBadge step="waiting_for_customer_reply" />)
    expect(screen.getByText('waiting for customer reply')).toBeInTheDocument()
  })
})

describe('EnvBadge', () => {
  it('shows the Dictionary label of the environment', () => {
    render(withVocabularyLabels(<EnvBadge environment="production" />))
    expect(screen.getByText('Production')).toBeInTheDocument()
  })

  it('an environment the Dictionary does not label is shown raw, never hidden', () => {
    render(withVocabularyLabels(<EnvBadge environment="lab-7" />))
    expect(screen.getByText('lab-7')).toBeInTheDocument()
  })

  it.each([null, undefined, ''])('no environment (%s) shows a dash, never "null"', (environment) => {
    const { container } = render(withVocabularyLabels(<EnvBadge environment={environment} />))
    expect(container).toHaveTextContent(/^—$/)
  })
})
