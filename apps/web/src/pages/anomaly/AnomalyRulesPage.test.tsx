/**
 * Verifica «Cosa resta cablato», ondata 5: le regole di anomalia si configurano
 * dalla loro pagina. Le scelte possibili arrivano dal server (tipo del cliente
 * compreso), la bozza incompleta non si salva, e quello che si salva è la forma
 * che l'API valida.
 */
import { describe, it, expect } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import { GET_ANOMALY_RULES, UPDATE_ANOMALY_RULE } from '@/graphql/queries'
import { AnomalyRulesPage, ruleDraftProblem, type AnomalyRuleSpec } from './AnomalyRulesPage'

const spofSpec: AnomalyRuleSpec = { ciTypes: true, relations: true, allRelationsWhenEmpty: false, incidentSeverities: false, forbidden: false, thresholdMin: 1, thresholdMax: 1000 }
const base = { enabled: true, severity: 'critical', ciTypes: [], relations: ['DEPENDS_ON'], threshold: 5, incidentSeverities: [], forbidden: [] }

describe('ruleDraftProblem', () => {
  it('le stesse regole dell\'API', () => {
    expect(ruleDraftProblem(base, spofSpec)).toBeNull()
    expect(ruleDraftProblem({ ...base, threshold: 0 }, spofSpec)).toBe('pages.anomalyRules.problemThreshold')
    expect(ruleDraftProblem({ ...base, relations: [] }, spofSpec)).toBe('pages.anomalyRules.problemRelations')
    const forbiddenSpec = { ...spofSpec, ciTypes: false, relations: false, thresholdMin: null, thresholdMax: null, forbidden: true }
    expect(ruleDraftProblem({ ...base, forbidden: [] }, forbiddenSpec)).toBe('pages.anomalyRules.problemForbiddenEmpty')
    expect(ruleDraftProblem({ ...base, forbidden: [{ fromType: 'server', relation: '', toType: 'application' }] }, forbiddenSpec)).toBe('pages.anomalyRules.problemForbiddenIncomplete')
  })
})

describe('AnomalyRulesPage', () => {
  const rule = {
    __typename: 'AnomalyRuleConfig', ruleKey: 'spof', ...base,
    forbidden: [], spec: { __typename: 'AnomalyRuleSpec', ...spofSpec },
    isDefault: true, updatedAt: null, openCount: 2, problem: null,
  }
  const options = {
    __typename: 'AnomalyRuleOptions',
    ciTypes: [
      { __typename: 'AnomalyCIType', name: 'server', label: 'Server', neo4jLabel: 'Server' },
      { __typename: 'AnomalyCIType', name: 'firewall', label: 'Firewall', neo4jLabel: 'Firewall' },
    ],
    relations: ['CONNECTS_TO', 'DEPENDS_ON'], incidentSeverities: ['critical'], severities: ['low', 'medium', 'high', 'critical'],
  }

  it('un tipo del cliente si sceglie e si salva con la regola', async () => {
    const settings = { ...base, ciTypes: ['firewall'] }
    const mocks: GqlMock[] = [
      { request: { query: GET_ANOMALY_RULES }, result: { data: { anomalyRules: [rule], anomalyRuleOptions: options } }, maxUsageCount: Number.POSITIVE_INFINITY },
      { request: { query: UPDATE_ANOMALY_RULE, variables: { ruleKey: 'spof', settings } }, result: { data: { updateAnomalyRule: { ...rule, ciTypes: ['firewall'], isDefault: false } } } },
    ]
    // Il nome di un tipo si legge dal metamodello (20 set 2026): «firewall»
    // è del cliente, quindi il metamodello di prova deve conoscerlo.
    const { user } = renderWithProviders(<AnomalyRulesPage />, { mocks, ciTypes: [['firewall', 'Firewall']] })
    await user.click(await screen.findByText('Single Point of Failure'))
    expect(screen.getByText('None selected: every CI type, including those created later.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Firewall' }))
    expect(screen.getByRole('button', { name: 'Firewall' })).toHaveAttribute('aria-pressed', 'true')
    const save = screen.getByRole('button', { name: 'Save' })
    expect(save).toBeEnabled()
    // Senza relazioni la bozza non si salva.
    await user.click(screen.getByRole('button', { name: 'DEPENDS_ON' }))
    expect(save).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'DEPENDS_ON' }))
    await user.click(save)
    // La mutation con quelle variabili ha risposto: la bozza si chiude e il Salva torna spento.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled())
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument()
  })
})

/**
 * «ISOLATED CLUSTER»: NO RELATION CHOSEN MEANS EVERY RELATION (D49, tour of
 * 23 Sep 2026). The API accepts an empty list for this rule only and resolves
 * it to every relation between CIs when the scan runs; the page must not block
 * the save, and says what the empty choice means instead of faking a selection.
 */
describe('AnomalyRulesPage — isolated cluster with no relation chosen', () => {
  const isolatedSpec: AnomalyRuleSpec = { ciTypes: true, relations: true, allRelationsWhenEmpty: true, incidentSeverities: false, forbidden: false, thresholdMin: 1, thresholdMax: 50 }
  const isolated = {
    __typename: 'AnomalyRuleConfig', ruleKey: 'isolated_cluster', enabled: true, severity: 'medium',
    ciTypes: ['server'], relations: [] as string[], threshold: 5, incidentSeverities: [], forbidden: [],
    spec: { __typename: 'AnomalyRuleSpec', ...isolatedSpec }, isDefault: true, updatedAt: null, openCount: 0, problem: null,
  }
  const options = {
    __typename: 'AnomalyRuleOptions',
    ciTypes: [{ __typename: 'AnomalyCIType', name: 'server', label: 'Server', neo4jLabel: 'Server' }],
    relations: ['CONNECTS_TO', 'DEPENDS_ON'], incidentSeverities: ['critical'], severities: ['low', 'medium', 'high', 'critical'],
  }
  const rulesMock = (rules: unknown[]): GqlMock => ({ request: { query: GET_ANOMALY_RULES }, result: { data: { anomalyRules: rules, anomalyRuleOptions: options } }, maxUsageCount: Number.POSITIVE_INFINITY })

  it('ruleDraftProblem: an empty list is a valid choice where the server says so (isolated_cluster)', () => {
    const none = { ...base, relations: [], threshold: 5 }
    expect(ruleDraftProblem(none, isolatedSpec)).toBeNull()
    expect(ruleDraftProblem(none, spofSpec)).toBe('pages.anomalyRules.problemRelations')
    expect(ruleDraftProblem(none, { ...spofSpec, thresholdMin: 2, thresholdMax: 10 })).toBe('pages.anomalyRules.problemRelations')
  })

  it('the empty choice reads «All relations between CIs», no chip pressed, and it saves', async () => {
    const settings = { enabled: true, severity: 'medium', ciTypes: ['server'], relations: [], threshold: 8, incidentSeverities: [], forbidden: [] }
    const mocks: GqlMock[] = [
      rulesMock([isolated]),
      { request: { query: UPDATE_ANOMALY_RULE, variables: { ruleKey: 'isolated_cluster', settings } }, result: { data: { updateAnomalyRule: { ...isolated, threshold: 8, isDefault: false } } } },
    ]
    const { user } = renderWithProviders(<AnomalyRulesPage />, { mocks })
    await user.click(await screen.findByText('Isolated Cluster'))
    expect(screen.getByText('All relations between CIs')).toBeInTheDocument()
    expect(screen.queryByText('At least one.')).not.toBeInTheDocument()
    for (const name of ['CONNECTS_TO', 'DEPENDS_ON']) expect(screen.getByRole('button', { name })).toHaveAttribute('aria-pressed', 'false')
    const threshold = screen.getByLabelText('Largest isolated cluster')
    await user.clear(threshold)
    await user.type(threshold, '8')
    const save = screen.getByRole('button', { name: 'Save' })
    expect(save).toBeEnabled()
    await user.click(save)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('choosing relations narrows it; taking them all off goes back to every relation, still savable', async () => {
    const { user } = renderWithProviders(<AnomalyRulesPage />, { mocks: [rulesMock([isolated])] })
    await user.click(await screen.findByText('Isolated Cluster'))
    await user.click(screen.getByRole('button', { name: 'DEPENDS_ON' }))
    expect(screen.getByText('Only 1 relation.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'CONNECTS_TO' }))
    expect(screen.getByText('Only these 2 relations.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'DEPENDS_ON' }))
    await user.click(screen.getByRole('button', { name: 'CONNECTS_TO' }))
    expect(screen.getByText('All relations between CIs')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
  })

  it('a rule that needs relations still says so, and does not save without one', async () => {
    const spof = { ...isolated, ruleKey: 'spof', severity: 'critical', relations: ['DEPENDS_ON'], spec: { __typename: 'AnomalyRuleSpec', ...spofSpec } }
    const { user } = renderWithProviders(<AnomalyRulesPage />, { mocks: [rulesMock([spof])] })
    await user.click(await screen.findByText('Single Point of Failure'))
    expect(screen.getByText('At least one.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'DEPENDS_ON' }))
    expect(screen.queryByText('All relations between CIs')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(screen.getByRole('alert')).toHaveTextContent('Choose at least one relation to follow.')
  })
})
