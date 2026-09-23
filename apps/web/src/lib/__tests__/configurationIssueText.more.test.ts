/**
 * THE SENTENCES OF THE CONFIGURATION DIAGNOSTICS, in the reader's language.
 *
 * The API sends a kind and its parameters, never a sentence. The client
 * composes it, and some parameters need care:
 *  - a degraded schema without a reason says the reason is not available, in
 *    the reader's language — not an Italian fallback written in the API;
 *  - «(and N more)» appears only when N > 0: «and 0 more» is a wrong sentence;
 *  - `count` arrives as text and must choose the plural as a number;
 *  - the configuration gaps are listed in the reader's language;
 *  - a kind this client does not know yet (a newer API) shows its key and
 *    parameters, never an empty line under «1 thing to fix».
 * These use the real English resources.
 */
import { describe, it, expect } from 'vitest'
import i18n from '@/i18n/i18n'
import { issueText, gapText, type IssueData } from '../configurationIssueText'

const t = i18n.getFixedT('en')
const exists = (key: string, params?: Record<string, string | number>) => i18n.exists(key, { ...params, lng: 'en' })

const issue = (kind: string, params: Record<string, string> = {}, extra: Partial<IssueData> = {}): IssueData => ({
  kind, severity: 'warning', where: null, params: Object.entries(params).map(([name, value]) => ({ name, value })), ...extra,
})

describe('issueText', () => {
  it('a degraded schema without a reason says the reason is not available; with one, it gives it', () => {
    expect(issueText(t, exists, issue('schema_degraded'))).toBe(
      'Part of the CI metamodel cannot be served by the API, so those types appear nowhere at all: reason not available',
    )
    expect(issueText(t, exists, issue('schema_degraded', { reason: 'neo4j timeout' }))).toMatch(/: neo4j timeout$/)
  })

  it('«and N more» only when there are more; count chooses the plural as a number', () => {
    const one = issueText(t, exists, issue('teams_without_sourcing', { count: '1', teams: 'Network' }))
    expect(one).toMatch(/^1 team does not say/)
    expect(one).toContain(': Network. ')
    expect(one).not.toContain('more')
    const many = issueText(t, exists, issue('teams_without_sourcing', { count: '5', teams: 'Network, DBA, Ops', others: '2' }))
    expect(many).toMatch(/^5 teams do not say/)
    expect(many).toContain('Network, DBA, Ops (and 2 more).')
    expect(issueText(t, exists, issue('tickets_without_sla', { count: '3', tickets: 'INC1, INC2, INC3', others: '0' }))).not.toContain('more')
  })

  it('the configuration gaps are listed in the reader\'s language', () => {
    const text = issueText(t, exists, issue('provisioning_gap', {}, { gaps: [{ kind: 'no_roles', params: [] }, { kind: 'no_teams', params: [] }] }))
    expect(text).toContain(`(${gapText(t, exists, { kind: 'no_roles', params: [] })}; ${gapText(t, exists, { kind: 'no_teams', params: [] })})`)
    expect(text).not.toContain('configurationIssues.gap')
  })

  it('a kind this client does not know shows its key and parameters, or just the key', () => {
    expect(issueText(t, exists, issue('brand_new_check', { node: 'x1', count: '2' }))).toBe('configurationIssues.issue.brand_new_check (node=x1, count=2)')
    expect(issueText(t, exists, issue('brand_new_check'))).toBe('configurationIssues.issue.brand_new_check')
  })
})
