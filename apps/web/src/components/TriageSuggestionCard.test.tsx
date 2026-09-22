/**
 * The AI triage card while an incident is being opened. Its contract with the
 * user is: nothing happens until they ask, nothing is applied until they click
 * Apply, and a feature the organisation turned off says so instead of showing
 * a dead button. If it regresses, the operator either gets a suggestion they
 * cannot apply, applies values different from what the card showed, or sees
 * no explanation of why triage is missing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { TriageSuggestionCard } from './TriageSuggestionCard'

const state = vi.hoisted(() => ({
  enabled: true as boolean | null,
  lazy: { data: undefined as unknown, loading: false, error: undefined as Error | undefined },
  run: vi.fn(),
}))

vi.mock('@/hooks/useAIFeature', () => ({ useAIFeature: () => state.enabled }))
vi.mock('@/hooks/useMe', () => ({ useMe: () => ({ can: () => false }) }))
vi.mock('@apollo/client/react', () => ({ useLazyQuery: () => [state.run, state.lazy] }))

const SUGGESTION = {
  severity: 'high', category: 'network', teamName: 'NOC', confidence: 'high',
  motivation: 'Same symptoms as last week.', riskFactors: ['core switch', 'peak hours'],
  similarUsed: [
    { id: '1', number: 'INC001', title: 'Switch down', severity: 'high', score: 0.9 },
    { id: '2', number: null, title: 'Packet loss', severity: 'medium', score: 0.8 },
    { id: '3', number: 'INC003', title: 'Third', severity: 'low', score: 0.7 },
  ],
}

function renderCard(props: Partial<React.ComponentProps<typeof TriageSuggestionCard>> = {}) {
  const onApply = vi.fn()
  render(
    <MemoryRouter>
      <TriageSuggestionCard title="VPN down" description="" ciIds={['ci-1']} onApply={onApply} {...props} />
    </MemoryRouter>,
  )
  return onApply
}

beforeEach(() => {
  state.enabled = true
  state.lazy = { data: undefined, loading: false, error: undefined }
  state.run.mockReset()
})

describe('TriageSuggestionCard', () => {
  it('says the feature is off instead of showing the button', () => {
    state.enabled = false
    renderCard()
    expect(screen.getByTestId('ai-disabled-triage')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Suggest triage/ })).toBeNull()
  })

  it('renders nothing while it is not yet known whether the feature is on', () => {
    state.enabled = null
    const { container } = render(<TriageSuggestionCard title="x" description="" ciIds={[]} onApply={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('cannot run without a title, and explains why', () => {
    renderCard({ title: '   ' })
    const btn = screen.getByRole('button', { name: /Suggest triage/ })
    expect(btn).toBeDisabled()
    expect(btn).toHaveAttribute('title', 'Write a title first')
  })

  it('runs only on request, sending an empty description as null', async () => {
    const user = userEvent.setup()
    renderCard()
    expect(state.run).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: /Suggest triage/ }))
    expect(state.run).toHaveBeenCalledWith({ variables: { title: 'VPN down', description: null, ciIds: ['ci-1'] } })
  })

  it('shows the analysing state and disables the button while loading', () => {
    state.lazy = { data: undefined, loading: true, error: undefined }
    renderCard()
    expect(screen.getByRole('button', { name: /Analysing/ })).toBeDisabled()
  })

  it('shows the error message of a failed request', () => {
    state.lazy = { data: undefined, loading: false, error: new Error('model unavailable') }
    renderCard()
    expect(screen.getByText('AI triage error: model unavailable')).toBeInTheDocument()
  })

  it('shows the suggestion and applies exactly the values it showed', async () => {
    const user = userEvent.setup()
    state.lazy = { data: { triageSuggestion: SUGGESTION }, loading: false, error: undefined }
    const onApply = renderCard()
    expect(screen.getByText('high confidence')).toBeInTheDocument()
    expect(screen.getByText('network')).toBeInTheDocument()
    expect(screen.getByText('NOC')).toBeInTheDocument()
    expect(screen.getByText('Same symptoms as last week.')).toBeInTheDocument()
    expect(screen.getByText('core switch')).toBeInTheDocument()
    // Only two examples are quoted; an incident without a number is named by its title.
    expect(screen.getByText(/Based on 3 similar incidents, among them INC001, Packet loss\./)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Apply the suggestion' }))
    expect(onApply).toHaveBeenCalledWith({ severity: 'high', category: 'network', teamName: 'NOC' })
  })

  it('omits team, risk factors and examples when the model gave none', () => {
    state.lazy = {
      data: { triageSuggestion: { ...SUGGESTION, confidence: 'low', teamName: null, riskFactors: [], similarUsed: [] } },
      loading: false, error: undefined,
    }
    renderCard()
    expect(screen.getByText('low confidence')).toBeInTheDocument()
    expect(screen.queryByText('NOC')).toBeNull()
    expect(screen.queryByRole('list')).toBeNull()
    expect(screen.queryByText(/Based on/)).toBeNull()
  })

  it('shows an unknown confidence raw rather than hiding the suggestion', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    state.lazy = { data: { triageSuggestion: { ...SUGGESTION, confidence: 'certain' } }, loading: false, error: undefined }
    renderCard()
    expect(screen.getByText('certain')).toBeInTheDocument()
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('unknown value: "certain"'))
    spy.mockRestore()
  })
})
