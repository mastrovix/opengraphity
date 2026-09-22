/**
 * The risk bands of THIS tenant, in the browser.
 *
 * Why these behaviours matter: the change priority follows the tenant's
 * thresholds; if the risk badge used anything else, the badge and the
 * priority would tell the CAB two different stories. So the provider must
 * answer with the tenant's own bands once they are loaded, and must answer
 * `null` (show the bare score, which is true) while loading, on error, and
 * when no provider is mounted, never guess a band. An error must also be
 * logged, not swallowed.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { RiskBandProvider, useRiskBands } from './RiskBandContext'
import { GET_RISK_BAND_THRESHOLDS } from '@/graphql/queries'
import { renderWithProviders, type GqlMock } from '@/test/utils'

function Probe({ score }: { score: number }) {
  const { bandOf, loading, error } = useRiskBands()
  return (
    <div>
      <span data-testid="band">{bandOf(score) ?? 'none'}</span>
      <span data-testid="loading">{String(loading)}</span>
      <span data-testid="error">{error ?? 'none'}</span>
    </div>
  )
}

const thresholdsMock = (thresholds: { band: string; upTo: number }[]): GqlMock => ({
  request: { query: GET_RISK_BAND_THRESHOLDS },
  result: { data: { riskBandThresholds: {
    __typename: 'RiskBandThresholds', vocabulary: 'change_risk', isDefault: false,
    thresholds: thresholds.map((t) => ({ __typename: 'RiskBandThreshold', ...t })),
  } } },
})

afterEach(() => { vi.restoreAllMocks() })

describe('RiskBandProvider', () => {
  it('uses the tenant thresholds once loaded, and no band while loading', async () => {
    // Four bands with tenant-specific thresholds: the fixed 30/60 split would say "medium" for 45.
    renderWithProviders(
      <RiskBandProvider><Probe score={45} /></RiskBandProvider>,
      { mocks: [thresholdsMock([{ band: 'low', upTo: 20 }, { band: 'medium', upTo: 40 }, { band: 'high', upTo: 70 }, { band: 'critical', upTo: 100 }])] },
    )
    expect(screen.getByTestId('loading')).toHaveTextContent('true')
    expect(screen.getByTestId('band')).toHaveTextContent('none')
    expect(await screen.findByText('high')).toBeInTheDocument()
    expect(screen.getByTestId('loading')).toHaveTextContent('false')
    expect(screen.getByTestId('error')).toHaveTextContent('none')
  })

  it('a score above every threshold has no band rather than the last one', async () => {
    renderWithProviders(
      <RiskBandProvider><Probe score={95} /></RiskBandProvider>,
      { mocks: [thresholdsMock([{ band: 'low', upTo: 30 }, { band: 'high', upTo: 90 }])] },
    )
    await screen.findByText('false')
    expect(screen.getByTestId('band')).toHaveTextContent('none')
  })

  it('on error gives no band, exposes the message and logs it', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    renderWithProviders(
      <RiskBandProvider><Probe score={45} /></RiskBandProvider>,
      { mocks: [{ request: { query: GET_RISK_BAND_THRESHOLDS }, error: new Error('bands unavailable') }] },
    )
    expect(await screen.findByText('bands unavailable')).toBeInTheDocument()
    expect(screen.getByTestId('band')).toHaveTextContent('none')
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('bands unavailable'))
  })

  it('a tenant without thresholds gives no band', async () => {
    renderWithProviders(
      <RiskBandProvider><Probe score={10} /></RiskBandProvider>,
      { mocks: [{ request: { query: GET_RISK_BAND_THRESHOLDS }, result: { data: { riskBandThresholds: null } } }] },
    )
    await screen.findByText('false')
    expect(screen.getByTestId('band')).toHaveTextContent('none')
  })
})

describe('useRiskBands without a provider', () => {
  it('answers "no band" instead of guessing', () => {
    render(<Probe score={50} />)
    expect(screen.getByTestId('band')).toHaveTextContent('none')
    expect(screen.getByTestId('loading')).toHaveTextContent('false')
  })
})
