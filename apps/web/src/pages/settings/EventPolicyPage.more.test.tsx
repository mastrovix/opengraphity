/**
 * EventPolicyPage: two paths the main test file does not walk. A stored
 * severity map that is not even JSON (hand-edited, truncated by an old
 * migration) must still open the page with a readable warning instead of
 * crashing it; and "Group by" must reach the server, since it decides whether
 * a CI with ten alarms gets one incident or ten.
 */
import { describe, it, expect, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { EventPolicyPage } from './EventPolicyPage'
import { GET_EVENT_POLICY, GET_DOMAIN_MATRICES } from '@/graphql/queries'
import { UPDATE_EVENT_POLICY } from '@/graphql/mutations'
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
  // Severity outside production (alarm policy, 23 Sep 2026): off, production only.
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

describe('EventPolicyPage — stored map that is not JSON', () => {
  it('opens with the parser message in the warning and an empty map', async () => {
    renderWithProviders(withVocabularyLabels(<EventPolicyPage />), { mocks: [baseCITypeMock(), matricesMock, policyMock({ severityMap: '{not json' })] })
    await screen.findByLabelText('Open incident from')
    // The JSON parser's own message is shown: it is what tells an admin where the text is broken.
    expect(screen.getByRole('alert')).toHaveTextContent(/^Invalid severity map \(.+\): defaults restored, save to fix\.$/)
    expect(screen.getByLabelText('Critical – Impact')).toHaveValue('')
  })
})

describe('EventPolicyPage — group by', () => {
  it('saves the chosen grouping', async () => {
    const seen: Array<Record<string, unknown>> = []
    const update: GqlMock = {
      request: { query: UPDATE_EVENT_POLICY, variables: (v) => { seen.push((v as { input: Record<string, unknown> }).input); return true } },
      result: (vars) => {
        const { expectedVersion: _v, ...input } = (vars as { input: Record<string, unknown> }).input
        return { data: { updateEventPolicy: { ...POLICY, ...input, version: 4 } } }
      },
    }
    const { user } = renderWithProviders(withVocabularyLabels(<EventPolicyPage />), { mocks: [baseCITypeMock(), matricesMock, policyMock(), update] })
    const groupBy = await screen.findByLabelText('Group by')
    expect(groupBy).toHaveValue('ci')
    await user.selectOptions(groupBy, 'fingerprint')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(seen).toHaveLength(1))
    expect(seen[0]).toMatchObject({ groupBy: 'fingerprint' })
  })
})
