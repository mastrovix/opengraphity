/**
 * The organization's AI switches and clustering thresholds. What breaks for a
 * user if these regress: a threshold outside the API's range reaching the
 * server (rejected there, after the user thought it saved), a failed save that
 * looks successful, a load error with no way to retry, or no warning that the
 * platform has no AI model at all (so every switch here is moot).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import { GET_AI_SETTINGS } from '@/graphql/queries'
import { SET_AI_SETTINGS } from '@/graphql/mutations'
import { AISection } from './AISection'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }))
beforeEach(() => { vi.mocked(toast.success).mockClear(); vi.mocked(toast.error).mockClear() })

const FEATURES = { __typename: 'AIFeatureSwitches', triage: true, assistant: true, reportAnalysis: true, postIncident: true, kbArticles: true, embeddings: true }
const settings = (over: Record<string, unknown> = {}) => ({
  __typename: 'AISettings', features: FEATURES, clusterMinSimilarity: 0.72, clusterMinSize: 3, platformConfigured: true, isDefault: false, ...over,
})
const settingsMock = (over: Record<string, unknown> = {}): GqlMock => ({
  request: { query: GET_AI_SETTINGS }, result: { data: { aiSettings: settings(over) } }, maxUsageCount: Number.POSITIVE_INFINITY,
})

describe('AISection', () => {
  it('warns when the platform has no AI model configured', async () => {
    renderWithProviders(<AISection />, { mocks: [settingsMock({ platformConfigured: false })] })
    expect(await screen.findByText(/The platform has no AI model configured/)).toBeInTheDocument()
  })

  it('out-of-range thresholds are named and block saving', async () => {
    const { user } = renderWithProviders(<AISection />, { mocks: [settingsMock()] })
    const similarity = await screen.findByLabelText('Minimum similarity (0.50–0.99)')
    const size = screen.getByLabelText('Minimum incidents per group')
    const save = screen.getByRole('button', { name: 'Save' })

    await user.clear(similarity)
    await user.type(similarity, '0.3')
    expect(screen.getByText('The minimum similarity must be between 0.50 and 0.99.')).toBeInTheDocument()
    expect(save).toBeDisabled()

    await user.clear(similarity)
    await user.type(similarity, '0.8')
    // A fractional group size is not a whole number of incidents.
    await user.clear(size)
    await user.type(size, '2.5')
    expect(screen.getByText('The minimum group must be a whole number between 2 and 20.')).toBeInTheDocument()
    expect(save).toBeDisabled()

    await user.clear(size)
    await user.type(size, '4')
    expect(screen.queryByText(/must be/)).not.toBeInTheDocument()
    expect(save).toBeEnabled()
  })

  it('a changed threshold is saved with the numbers, and success is confirmed', async () => {
    const sent = vi.fn(() => ({ data: { setAISettings: settings({ clusterMinSize: 5 }) } }))
    const { user } = renderWithProviders(<AISection />, { mocks: [
      settingsMock(),
      { request: { query: SET_AI_SETTINGS, variables: { input: { features: { triage: true, assistant: true, reportAnalysis: true, postIncident: true, kbArticles: true, embeddings: true }, clusterMinSimilarity: 0.72, clusterMinSize: 5 } } }, result: sent },
    ] })
    const size = await screen.findByLabelText('Minimum incidents per group')
    await user.clear(size)
    await user.type(size, '5')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    // The mock only matches numeric variables: a string "5" would not reach it.
    await waitFor(() => expect(sent).toHaveBeenCalled())
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('AI settings saved'))
  })

  it('a failed save is reported, not silently swallowed', async () => {
    const { user } = renderWithProviders(<AISection />, { mocks: [
      settingsMock(),
      { request: { query: SET_AI_SETTINGS, variables: () => true }, error: new Error('save refused') },
    ] })
    await user.click(await screen.findByRole('switch', { name: 'Similarity (embeddings)' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('save refused'))
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('a load error offers Retry, which reloads the settings', async () => {
    const { user } = renderWithProviders(<AISection />, { mocks: [
      { request: { query: GET_AI_SETTINGS }, error: new Error('settings unavailable') },
      settingsMock(),
    ] })
    expect(await screen.findByText('settings unavailable')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Retry/ }))
    expect(await screen.findByRole('switch', { name: 'Similarity (embeddings)' })).toBeInTheDocument()
  })
})
