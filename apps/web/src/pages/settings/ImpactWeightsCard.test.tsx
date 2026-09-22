/**
 * The weights of the change impact analysis were once written in the API
 * code; now the admin sets them here. What breaks for a user if this card
 * regresses:
 * - an out-of-range or non-integer value reaching the API (the server would
 *   reject it, or worse the score would be computed with it);
 * - the "factory weights" notice missing, so the admin believes a choice was
 *   already made;
 * - Save enabled with nothing changed, or saving strings instead of numbers.
 * The ranges come from @opengraphity/types, the same source the API uses.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { ImpactWeightsCard, impactDraftValid, IMPACT_LIMITS } from './ImpactWeightsCard'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const WEIGHTS = {
  productionCI: 20, blastRadiusCI: 5, blastRadiusCap: 30, openIncident: 10, failedChange: 15, ongoingChange: 5,
  recentChangesDays: 30, recentIncidentsDays: 14,
}
const asDraft = (over: Record<string, string> = {}) =>
  ({ ...Object.fromEntries(Object.entries(WEIGHTS).map(([k, v]) => [k, String(v)])), ...over }) as Parameters<typeof impactDraftValid>[0]

beforeEach(() => {
  apolloFinto.reset()
  vi.mocked(toast.success).mockClear()
  vi.mocked(toast.error).mockClear()
})

describe('impactDraftValid', () => {
  it('accepts integers inside the shared ranges', () => {
    expect(impactDraftValid(asDraft())).toBe(true)
    expect(impactDraftValid(asDraft({ productionCI: String(IMPACT_LIMITS.productionCI.max), recentChangesDays: String(IMPACT_LIMITS.recentChangesDays.min) }))).toBe(true)
  })

  it.each([
    ['an empty field', { openIncident: '' }],
    ['a decimal', { openIncident: '2.5' }],
    ['a weight above the ceiling', { productionCI: String(IMPACT_LIMITS.productionCI.max + 1) }],
    ['a negative weight', { failedChange: '-1' }],
    ['a zero-day window', { recentIncidentsDays: '0' }],
    ['text', { blastRadiusCap: 'abc' }],
  ])('refuses %s', (_label, over) => {
    expect(impactDraftValid(asDraft(over))).toBe(false)
  })
})

describe('ImpactWeightsCard', () => {
  it('shows the saved values and says when they are the factory ones', () => {
    apolloFinto.risposte['GetImpactAnalysisWeights'] = { impactAnalysisWeights: { ...WEIGHTS, isDefault: true } }
    renderWithProviders(<ImpactWeightsCard />)
    expect(screen.getByLabelText('CI in the highest-risk environment')).toHaveValue(20)
    expect(screen.getByLabelText('Recently closed incidents')).toHaveValue(14)
    expect(screen.getByText('Not chosen yet: the factory weights apply.')).toBeInTheDocument()
    // Nothing changed yet: nothing to save.
    expect(screen.getByRole('button', { name: /Save/ })).toBeDisabled()
  })

  it('an out-of-range value is flagged and cannot be saved', async () => {
    apolloFinto.risposte['GetImpactAnalysisWeights'] = { impactAnalysisWeights: { ...WEIGHTS, isDefault: false } }
    const { user } = renderWithProviders(<ImpactWeightsCard />)
    expect(screen.queryByText(/factory weights apply/)).not.toBeInTheDocument()
    const days = screen.getByLabelText('Recent changes')
    await user.clear(days)
    await user.type(days, '400')
    expect(screen.getByRole('alert')).toHaveTextContent('windows from 1 to 365 days')
    expect(screen.getByRole('button', { name: /Save/ })).toBeDisabled()
  })

  it('saves every value as a number and confirms', async () => {
    apolloFinto.risposte['GetImpactAnalysisWeights'] = { impactAnalysisWeights: { ...WEIGHTS, isDefault: false } }
    const { user } = renderWithProviders(<ImpactWeightsCard />)
    const open = screen.getByLabelText('Open incident')
    await user.clear(open)
    await user.type(open, '25')
    await user.click(screen.getByRole('button', { name: /Save/ }))
    await waitFor(() => expect(apolloFinto.chiamata('UpdateImpactAnalysisWeights')).toBeDefined())
    expect(apolloFinto.chiamata('UpdateImpactAnalysisWeights')).toEqual({ input: { ...WEIGHTS, openIncident: 25 } })
    expect(toast.success).toHaveBeenCalledWith('Impact weights saved')
    // The draft is dropped after saving: the form reads the server again, and Save is off.
    await waitFor(() => expect(screen.getByRole('button', { name: /Save/ })).toBeDisabled())
  })

  it('a refused save shows the error and keeps the draft, so the admin can correct it', async () => {
    apolloFinto.risposte['GetImpactAnalysisWeights'] = { impactAnalysisWeights: { ...WEIGHTS, isDefault: false } }
    apolloFinto.esiti['UpdateImpactAnalysisWeights'] = { error: new Error('forbidden') }
    const { user } = renderWithProviders(<ImpactWeightsCard />)
    const open = screen.getByLabelText('Open incident')
    await user.clear(open)
    await user.type(open, '26')
    await user.click(screen.getByRole('button', { name: /Save/ }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('forbidden'))
    expect(toast.success).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Open incident')).toHaveValue(26)
  })

  it('shows the load error instead of an empty form', () => {
    apolloFinto.erroriQuery['GetImpactAnalysisWeights'] = new Error('weights down')
    renderWithProviders(<ImpactWeightsCard />)
    expect(screen.getByText('weights down')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Save/ })).not.toBeInTheDocument()
  })
})
