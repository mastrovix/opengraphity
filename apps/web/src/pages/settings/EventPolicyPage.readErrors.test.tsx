/**
 * EventPolicyPage: what the page does when the stored policy cannot be used
 * as it is — the paths its two other test files do not walk.
 *
 * The severity map (severity → impact/urgency) is stored as JSON, and it can
 * come back unusable: not an object at all, or with a severity whose levels
 * are missing. The page must then open anyway, say what is wrong, and start
 * the map EMPTY — never correct it in silence with values the customer's
 * vocabulary may not have (G-24). And a policy that cannot be read at all
 * must show the error with a retry, not an empty form that looks like
 * «nothing configured».
 */
import { describe, it, expect, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import { EventPolicyPage } from './EventPolicyPage'
import { GET_EVENT_POLICY, GET_DOMAIN_MATRICES } from '@/graphql/queries'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import { withVocabularyLabels } from '@/test/vocabularies'
import { baseCITypeMock } from '@/test/mocks/gql'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  Toaster: () => null,
}))

const MAP = { critical: { impact: 'high', urgency: 'high' }, warning: { impact: 'medium', urgency: 'medium' }, info: { impact: 'low', urgency: 'low' } }

const POLICY = {
  __typename: 'EventPolicy',
  version: 3, updatedAt: '2026-09-08T10:00:00Z',
  openIncidentFrom: 'critical', groupBy: 'ci', openDelaySeconds: 120, autoResolve: true,
  suppressUpstreamHops: 2, flapThreshold: 4, flapWindowMinutes: 15, flapStableMinutes: 10,
  stormThresholdPerMinute: 50, stormCooldownMinutes: 5, retentionDays: 30,
  matchShortHostname: false,
  ignoreLifecycleStatuses: ['decommissioned'],
  retiredStatuses: ['inactive', 'decommissioned'],
  maintenanceStatuses: ['maintenance'],
  highImpactDependents: 5,
  severityMap: JSON.stringify(MAP),
  productionEnvironments: ['production'],
  nonProductionSeverityMap: null as string | null,
}

const matricesMock: GqlMock = {
  request: { query: GET_DOMAIN_MATRICES },
  result: { data: { domainMatrices: [{
    __typename: 'DomainMatrix', kind: 'priority', inputs: ['impact', 'urgency'], output: 'priority',
    inputValues: [['low', 'medium', 'high'], ['low', 'medium', 'high']], outputValues: ['low', 'medium', 'high'],
    cells: [], missing: [], stale: [], invalid: [], isDefault: false, updatedAt: null,
  }] } },
  maxUsageCount: Number.POSITIVE_INFINITY,
}

const policyMock = (over: Partial<typeof POLICY> = {}): GqlMock => ({
  request: { query: GET_EVENT_POLICY },
  result: { data: { eventPolicy: { ...POLICY, ...over } } },
  maxUsageCount: Number.POSITIVE_INFINITY,
})

const show = (...mocks: GqlMock[]) =>
  renderWithProviders(withVocabularyLabels(<EventPolicyPage />), { mocks: [baseCITypeMock(), matricesMock, ...mocks] })

describe('EventPolicyPage — a stored severity map that cannot be used', () => {
  it.each([
    ['null', 'null'],
    ['a number', '42'],
    ['a string', '"high"'],
  ])('a map that is %s opens with the warning, and the map starts empty', async (_what, stored) => {
    show(policyMock({ severityMap: stored }))
    await screen.findByLabelText('Open incident from')
    expect(screen.getByRole('alert')).toHaveTextContent('Invalid severity map (severityMap: expected a JSON object): defaults restored, save to fix.')
    expect(screen.getByLabelText('Critical – Impact')).toHaveValue('')
    expect(screen.getByLabelText('Info – Urgency')).toHaveValue('')
  })

  it('a severity with an empty level is named in the warning, and the map starts empty', async () => {
    show(policyMock({ severityMap: JSON.stringify({ ...MAP, warning: { impact: '  ', urgency: 'medium' } }) }))
    await screen.findByLabelText('Open incident from')
    expect(screen.getByRole('alert')).toHaveTextContent(/^Invalid severity map \(severityMap\.warning: .+\): defaults restored, save to fix\.$/)
    // Nothing is kept from a map that was only partly readable.
    expect(screen.getByLabelText('Critical – Impact')).toHaveValue('')
  })

  it('a severity stored as null is named in the warning too', async () => {
    show(policyMock({ severityMap: JSON.stringify({ ...MAP, critical: null }) }))
    await screen.findByLabelText('Open incident from')
    expect(screen.getByRole('alert')).toHaveTextContent(/^Invalid severity map \(severityMap\.critical: .+\)/)
    expect(screen.getByLabelText('Warning – Impact')).toHaveValue('')
  })

  // Tour of 23 Sep 2026: the warning said «must be low | medium | high», a
  // list the page no longer has — the values are the customer's own, and the
  // API checks them against the Dictionary.
  it('the warning on a missing level says where the values come from, and promises no fixed list', async () => {
    show(policyMock({ severityMap: JSON.stringify({ ...MAP, info: { impact: 'low' } }) }))
    await screen.findByLabelText('Open incident from')
    const warning = screen.getByRole('alert')
    expect(warning).toHaveTextContent('severityMap.info: impact and urgency are required, each a value of its own vocabulary in the Dictionary')
    expect(warning).not.toHaveTextContent('low | medium | high')
  })
})

describe('EventPolicyPage — a lifecycle vocabulary the metamodel leaves empty', () => {
  // Tour of 23 Sep 2026: the page had an «empty vocabulary» message of its own
  // that could never show — an empty status list is this error.
  it('is reported as unavailable, and only the statuses already saved can be ticked', async () => {
    renderWithProviders(withVocabularyLabels(<EventPolicyPage />), { mocks: [baseCITypeMock([]), matricesMock, policyMock()] })
    const group = await screen.findByRole('group', { name: 'Lifecycle statuses to ignore' })
    expect(screen.getByRole('alert')).toHaveTextContent('Lifecycle statuses unavailable from the metamodel (base field "status" has no enumValues): only the ones already saved in the policy can be ticked.')
    // The statuses named by the three lists of the policy: decommissioned, inactive, maintenance.
    expect(within(group).getAllByRole('checkbox')).toHaveLength(3)
    expect(within(group).getByRole('checkbox', { name: 'Unknown: decommissioned' })).toBeChecked()
  })
})

describe('EventPolicyPage — a policy that cannot be read', () => {
  it('shows the error with a retry, and the retry reads the policy again', async () => {
    const failing: GqlMock = { request: { query: GET_EVENT_POLICY }, error: new Error('policy service down') }
    const { user } = show(failing, policyMock())
    expect(await screen.findByText('Failed to load data')).toBeInTheDocument()
    expect(screen.getByText(/policy service down/)).toBeInTheDocument()
    // No form that would look like «nothing configured».
    expect(screen.queryByLabelText('Open incident from')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByLabelText('Open incident from')).toHaveValue('critical')
    expect(screen.queryByText('Failed to load data')).toBeNull()
  })
})
