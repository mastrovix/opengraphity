/**
 * I ruoli dei passi mancanti si leggono con le etichette del designer
 * (revisione del 14 set 2026 · F17): l'API manda i valori interni
 * (`resolved, escalated`), e l'amministratore li cerca nel designer dove si
 * chiamano «Risolto», «Escalato».
 */
import { describe, expect, it } from 'vitest'
import type { TFunction } from 'i18next'
import it_ from '../../i18n/locales/it.json'
import { issueText } from '../configurationIssueText'

function lookup(key: string): unknown {
  return key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], it_)
}
const t = ((key: string, params: Record<string, string | number> = {}) => {
  const raw = lookup(key)
  if (typeof raw !== 'string') return key
  return raw.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => String(params[name] ?? ''))
}) as unknown as TFunction
const exists = (key: string) => typeof lookup(key) === 'string'

describe('issueText — ruoli dei passi', () => {
  it('le categorie mancanti con le etichette del designer', () => {
    const text = issueText(t, exists, {
      kind: 'workflow_step_categories_missing', severity: 'error', where: '/workflow',
      params: [{ name: 'workflow', value: 'Incident' }, { name: 'entityType', value: 'incident' }, { name: 'missing', value: 'resolved, escalated' }],
    })
    expect(text).toContain(`${String(lookup('workflow.categoryOption.resolved'))}, ${String(lookup('workflow.categoryOption.escalated'))}`)
    expect(text).not.toContain('resolved, escalated')
  })

  it('gli scopi mancanti con le etichette del designer', () => {
    const text = issueText(t, exists, {
      kind: 'workflow_optional_step_purposes_missing', severity: 'warning', where: '/workflow',
      params: [{ name: 'workflow', value: 'Change' }, { name: 'entityType', value: 'change' }, { name: 'missing', value: 'implementation' }],
    })
    expect(text).toContain(String(lookup('workflow.purposeOption.implementation')))
  })
})
