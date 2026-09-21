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

const spofSpec: AnomalyRuleSpec = { ciTypes: true, relations: true, incidentSeverities: false, forbidden: false, thresholdMin: 1, thresholdMax: 1000 }
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
