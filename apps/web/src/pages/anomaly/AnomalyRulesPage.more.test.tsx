/**
 * ANOMALY RULES: the rule shapes and the edits the first test file does not walk.
 *
 * Why these matter to whoever configures the scans:
 *  - a draft the API would refuse must be caught HERE, with the reason, and
 *    the Save button must stay off: otherwise the save fails with a server
 *    error and the administrator does not know which box is wrong;
 *  - a rule saved earlier that can no longer run (a CI type deleted since)
 *    must SAY so, both on the card header and inside the card;
 *  - a saved value that is no longer among the options (G-ANO-5) must stay
 *    visible and removable, or the rule cannot be repaired from the UI;
 *  - «Cancel» throws the draft away, and a failed save keeps it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { withVocabularyLabels } from '@/test/vocabularies'
import { apolloFinto } from '@/test/apolloFinto'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

const { AnomalyRulesPage, ruleDraftProblem } = await import('./AnomalyRulesPage')

type Spec = Parameters<typeof ruleDraftProblem>[1]
const NO_SPEC: Spec = { ciTypes: false, relations: false, allRelationsWhenEmpty: false, incidentSeverities: false, forbidden: false, thresholdMin: null, thresholdMax: null }
const SETTINGS = { enabled: true, severity: 'high', ciTypes: [], relations: [], threshold: null, incidentSeverities: [], forbidden: [] }

const rule = (ruleKey: string, spec: Partial<Spec>, over: Record<string, unknown> = {}) => ({
  ruleKey, ...SETTINGS, spec: { ...NO_SPEC, ...spec }, isDefault: true, updatedAt: null, openCount: 0, problem: null, ...over,
})

const OPTIONS = {
  ciTypes: [
    { name: 'server', label: 'Server', neo4jLabel: 'Server' },
    { name: 'application', label: 'Application', neo4jLabel: 'Application' },
  ],
  relations: ['DEPENDS_ON', 'HOSTED_ON'],
  incidentSeverities: ['critical', 'high'],
  severities: ['low', 'medium', 'high', 'critical'],
}

const serve = (...rules: unknown[]) => {
  apolloFinto.risposte['GetAnomalyRules'] = { anomalyRules: rules, anomalyRuleOptions: OPTIONS }
}

/** Cards are collapsed: open the one with this title. */
async function openCard(user: ReturnType<typeof renderWithProviders>['user'], title: string) {
  await user.click(screen.getByText(title))
}

const saveButton = () => screen.getByRole('button', { name: 'Save' })

describe('AnomalyRulesPage: the severity outside production (G32, 24 Sep 2026)', () => {
  it('a rule that weighs the environment offers it, and saves the choice; «same severity» saves none', async () => {
    serve(rule('spof', { relations: true, thresholdMin: 1, thresholdMax: 1000, environment: true }, { threshold: 5, relations: ['DEPENDS_ON'], severity: 'critical', nonProductionSeverity: 'medium' }))
    apolloFinto.esiti['UpdateAnomalyRule'] = { data: { updateAnomalyRule: rule('spof', { environment: true }) } }
    const { user } = renderWithProviders(<AnomalyRulesPage />)
    await openCard(user, 'Single Point of Failure')
    const outside = screen.getByLabelText('Outside production')
    expect(outside).toHaveValue('medium')
    await user.selectOptions(outside, '')
    await user.click(saveButton())
    await waitFor(() => expect(apolloFinto.chiamata('UpdateAnomalyRule')).toMatchObject({ ruleKey: 'spof', settings: { severity: 'critical', nonProductionSeverity: null } }))
  })

  it('a rule that does not weigh it shows nothing of the kind', async () => {
    serve(rule('orphan_ci', {}))
    const { user } = renderWithProviders(<AnomalyRulesPage />)
    await openCard(user, 'Orphan CI')
    expect(screen.queryByLabelText('Outside production')).toBeNull()
  })
})

beforeEach(() => {
  apolloFinto.reset()
  toast.success.mockReset()
  toast.error.mockReset()
})

describe('ruleDraftProblem — the API rules the first file does not cover', () => {
  const thresholdSpec: Spec = { ...NO_SPEC, thresholdMin: 2, thresholdMax: 10 }

  it.each([
    ['missing', null],
    ['not an integer', 2.5],
    ['above the maximum', 11],
  ])('a threshold %s is refused', (_label, threshold) => {
    expect(ruleDraftProblem({ ...SETTINGS, threshold }, thresholdSpec)).toBe('pages.anomalyRules.problemThreshold')
  })

  it('a rule without a threshold range ignores the threshold', () => {
    expect(ruleDraftProblem({ ...SETTINGS, threshold: null }, NO_SPEC)).toBeNull()
  })

  it('a rule counting incident severities needs at least one', () => {
    expect(ruleDraftProblem(SETTINGS, { ...NO_SPEC, incidentSeverities: true })).toBe('pages.anomalyRules.problemSeverities')
    expect(ruleDraftProblem({ ...SETTINGS, incidentSeverities: ['critical'] }, { ...NO_SPEC, incidentSeverities: true })).toBeNull()
  })

  it('the same forbidden relation twice is refused; distinct ones pass', () => {
    const f = { fromType: 'server', relation: 'DEPENDS_ON', toType: 'application' }
    const spec = { ...NO_SPEC, forbidden: true }
    expect(ruleDraftProblem({ ...SETTINGS, forbidden: [f, { ...f }] }, spec)).toBe('pages.anomalyRules.problemForbiddenDuplicate')
    expect(ruleDraftProblem({ ...SETTINGS, forbidden: [f, { ...f, toType: 'server' }] }, spec)).toBeNull()
  })
})

describe('AnomalyRulesPage — a rule that cannot run', () => {
  it('is flagged on the header and explained inside, with the server parameters', async () => {
    serve(rule('missing_owner', {}, {
      enabled: false, openCount: 3,
      problem: { key: 'no.such.key', message: 'CI type {{type}} no longer exists', params: [{ key: 'type', value: 'firewall' }] },
    }))
    const { user } = renderWithProviders(<AnomalyRulesPage />)
    expect(screen.getByLabelText('This rule cannot run')).toBeInTheDocument()
    expect(screen.getByText('Off')).toBeInTheDocument()
    expect(screen.getByText('3 open')).toBeInTheDocument()
    await openCard(user, 'CI Without Owner')
    // The server message is the fallback, with its parameters filled in.
    expect(screen.getByRole('alert')).toHaveTextContent('The saved rule cannot run: CI type firewall no longer exists')
  })

  it('a failed load says why', () => {
    serve(rule('brand_new_rule', {}))
    apolloFinto.erroriQuery['GetAnomalyRules'] = new Error('scan service down')
    renderWithProviders(<AnomalyRulesPage />)
    expect(screen.getByRole('alert')).toHaveTextContent('scan service down')
  })

  it('an unknown rule key still renders a card, titled with the key', () => {
    serve(rule('brand_new_rule', {}))
    renderWithProviders(<AnomalyRulesPage />)
    expect(screen.getByText('brand_new_rule')).toBeInTheDocument()
  })
})

describe('AnomalyRulesPage — forbidden relations', () => {
  const forbiddenRule = (over: Record<string, unknown> = {}) => rule('unauthorized_relation', { forbidden: true }, {
    forbidden: [{ fromType: 'server', relation: 'DEPENDS_ON', toType: 'application' }], ...over,
  })

  it('a new row must be completed before saving, and the reason is shown', async () => {
    serve(forbiddenRule())
    const { user } = renderWithProviders(<AnomalyRulesPage />)
    await openCard(user, 'Unauthorised Relation')
    await user.click(screen.getByRole('button', { name: 'Add forbidden relation' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Complete every forbidden relation: from, relation and to.')
    expect(saveButton()).toBeDisabled()

    const from = screen.getAllByRole('combobox', { name: 'From CI type' })[1]!
    const relation = screen.getAllByRole('combobox', { name: 'Relation' })[1]!
    const to = screen.getAllByRole('combobox', { name: 'To CI type' })[1]!
    await user.selectOptions(from, 'application')
    await user.selectOptions(relation, 'HOSTED_ON')
    await user.selectOptions(to, 'server')
    expect(saveButton()).toBeEnabled()

    await user.click(saveButton())
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Rule saved: it applies from the next scan'))
    expect(apolloFinto.chiamata('UpdateAnomalyRule')).toEqual({
      ruleKey: 'unauthorized_relation',
      settings: {
        ...SETTINGS,
        forbidden: [
          { fromType: 'server', relation: 'DEPENDS_ON', toType: 'application' },
          { fromType: 'application', relation: 'HOSTED_ON', toType: 'server' },
        ],
      },
    })
    // Saved: the draft is gone, Save is off again.
    await waitFor(() => expect(saveButton()).toBeDisabled())
  })

  it('removing the last row is refused with its reason; Cancel restores the saved rule', async () => {
    serve(forbiddenRule())
    const { user } = renderWithProviders(<AnomalyRulesPage />)
    await openCard(user, 'Unauthorised Relation')
    await user.click(screen.getByRole('button', { name: 'Remove forbidden relation' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Declare at least one forbidden relation.')
    expect(screen.queryByRole('combobox', { name: 'From CI type' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('combobox', { name: 'From CI type' })).toHaveValue('server')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    // The factory note is back once there is no draft.
    expect(screen.getByText('Factory settings')).toBeInTheDocument()
  })
})

describe('AnomalyRulesPage — severities, types and thresholds', () => {
  it('incident severities are named by the customer Dictionary; a value no longer there can be removed', async () => {
    serve(rule('risk_concentration', { incidentSeverities: true, thresholdMin: 1, thresholdMax: 50 }, {
      threshold: 3, incidentSeverities: ['critical', 'p0'], isDefault: false, updatedAt: '2026-09-10T08:00:00Z',
    }))
    const { user } = renderWithProviders(withVocabularyLabels(<AnomalyRulesPage />, { severity: { critical: 'Blocking' } }))
    await openCard(user, 'Risk Concentration')
    expect(screen.getByText(/^Saved /)).toBeInTheDocument()
    const group = screen.getByRole('group', { name: 'Incident severities that count as critical' })
    expect(within(group).getByRole('button', { name: 'Blocking' })).toHaveAttribute('aria-pressed', 'true')
    // No Dictionary label: the raw value.
    expect(within(group).getByRole('button', { name: 'high' })).toHaveAttribute('aria-pressed', 'false')
    const orphan = within(group).getByRole('button', { name: 'p0 (no longer exists)' })
    expect(orphan).toHaveAttribute('title', expect.stringContaining('«p0» is saved in this rule'))
    await user.click(orphan)
    expect(within(group).queryByRole('button', { name: 'p0 (no longer exists)' })).not.toBeInTheDocument()
    await user.click(within(group).getByRole('button', { name: 'Blocking' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Choose at least one incident severity.')
    expect(saveButton()).toBeDisabled()
  })

  it('the threshold must stay inside its range, and the message names the range', async () => {
    serve(rule('spof', { relations: true, thresholdMin: 1, thresholdMax: 1000 }, { threshold: 5, relations: ['DEPENDS_ON'] }))
    const { user } = renderWithProviders(<AnomalyRulesPage />)
    await openCard(user, 'Single Point of Failure')
    const threshold = screen.getByLabelText('Minimum direct dependents')
    await user.clear(threshold)
    expect(screen.getByRole('alert')).toHaveTextContent('The threshold must be an integer between 1 and 1000.')
    await user.type(threshold, '12')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(saveButton()).toBeEnabled()
  })

  it('the isolated-cluster rule asks for its starting types, and counts the chosen ones', async () => {
    serve(rule('isolated_cluster', { ciTypes: true }, { ciTypes: ['server'] }))
    const { user } = renderWithProviders(<AnomalyRulesPage />)
    await openCard(user, 'Isolated Cluster')
    expect(screen.getByText('Start from these CI types')).toBeInTheDocument()
    expect(screen.getByText('Only 1 CI type.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Application' }))
    expect(screen.getByText('Only these 2 CI types.')).toBeInTheDocument()
  })

  it('switch and severity go into the saved settings; a refused save keeps the draft', async () => {
    serve(rule('orphan_ci', {}))
    apolloFinto.esiti['UpdateAnomalyRule'] = { error: new Error('forbidden') }
    const { user } = renderWithProviders(<AnomalyRulesPage />)
    await openCard(user, 'Orphan CI')
    await user.click(screen.getByRole('switch', { name: 'Rule active' }))
    await user.selectOptions(screen.getByLabelText('Severity of the anomaly'), 'low')
    await user.click(saveButton())
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('forbidden'))
    expect(apolloFinto.chiamata('UpdateAnomalyRule')).toEqual({ ruleKey: 'orphan_ci', settings: { ...SETTINGS, enabled: false, severity: 'low' } })
    // The draft survives the failure: nothing typed is lost.
    expect(screen.getByLabelText('Severity of the anomaly')).toHaveValue('low')
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
  })
})
