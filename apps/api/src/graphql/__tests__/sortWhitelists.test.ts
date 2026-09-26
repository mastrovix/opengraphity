/**
 * Contratto API ↔ web sull'ordinamento delle liste (revisione totale · B-9).
 *
 * 26 Sep 2026, the owner: «le colonne dovrebbero essere sempre tutte
 * ordinabili». Every column of a table sorts, unless it holds only buttons
 * (`sortable: false`). A page that sorts on the SERVER (it passes `onSort`)
 * sends the column's key as `sortField`: the key must be in the resolver's
 * list, or the resolver refuses it. The customer's fields (`cf:<name>`) sort
 * through `customFieldOrderBy` and are not literal columns.
 *
 * The guard reads the column arrays of the web pages by their variable name —
 * a page can hold three tables — and compares them with the resolvers' maps.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { INCIDENT_SORT_WHITELIST } from '../resolvers/incident.js'
import { PROBLEM_SORT_WHITELIST } from '../resolvers/problem.js'
import { REQUEST_SORT_WHITELIST } from '../resolvers/service_request.js'
import { TEAM_SORT_WHITELIST } from '../resolvers/team.js'
import { USER_SORT_WHITELIST } from '../resolvers/index.js'
import { CI_SORT_WHITELIST, ALL_CIS_SORT_WHITELIST } from '../resolvers/buildCIQuery.js'
import { CHANGE_SORT_WHITELIST } from '../resolvers/change/queries.js'
import { AUDIT_SORT_WHITELIST } from '../resolvers/auditLog.js'
import { ANOMALY_SORT_WHITELIST } from '../resolvers/anomaly.js'
import { INBOUND_WEBHOOK_SORT_WHITELIST, OUTBOUND_WEBHOOK_SORT_WHITELIST, API_KEY_SORT_WHITELIST } from '../resolvers/integrations.js'
import { AUTO_TRIGGER_SORT_WHITELIST, BUSINESS_RULE_SORT_WHITELIST, SLA_POLICY_SORT_WHITELIST } from '../resolvers/automation.js'
import { KB_ARTICLE_SORT_WHITELIST } from '../resolvers/knowledgeBase.js'

const here = dirname(fileURLToPath(import.meta.url))
const webPages = join(here, '../../../../web/src/pages')

/** The text between `start` (an opening bracket) and its match, strings and comments skipped. */
function balanced(source: string, start: number): string {
  let depth = 0
  let quote: string | null = null
  for (let i = start; i < source.length; i++) {
    const c = source[i]!
    if (quote) { if (c === quote && source[i - 1] !== '\\') quote = null; continue }
    // Comments are skipped: an apostrophe in one («l'etichetta») is not a string.
    if (c === '/' && source[i + 1] === '/') { i = source.indexOf('\n', i); continue }
    if (c === '/' && source[i + 1] === '*') { i = source.indexOf('*/', i) + 1; continue }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue }
    if (c === '[' || c === '{' || c === '(') depth++
    else if (c === ']' || c === '}' || c === ')') { depth--; if (depth === 0) return source.slice(start, i + 1) }
  }
  throw new Error('unbalanced')
}

/** The keys of the sortable columns of the array `name` in a page: every column but the ones marked `sortable: false`. */
export function sortableColumnKeys(relativePath: string, name: string): string[] {
  const source = readFileSync(join(webPages, relativePath), 'utf8')
  const at = source.search(new RegExp(`\\b${name}\\b[^=]*=\\s*\\[`))
  if (at < 0) throw new Error(`${relativePath}: no column array «${name}»`)
  const array = balanced(source, source.indexOf('[', source.indexOf('=', at)))
  const keys: string[] = []
  // the top-level objects of the array
  for (let i = 1; i < array.length; i++) {
    if (array[i] !== '{') continue
    const obj = balanced(array, i)
    const key = /^\{\s*key:\s*'([^']+)'/.exec(obj)?.[1] ?? /\bkey:\s*'([^']+)'/.exec(obj)?.[1]
    if (key && !/sortable:\s*false/.test(obj)) keys.push(key)
    i += obj.length - 1
  }
  return keys
}

/** Pages that sort on the server, their column array and the resolver's list. */
const PAGES: [string, string, Record<string, string>][] = [
  ['incidents/IncidentListPage.tsx', 'baseColumns',    INCIDENT_SORT_WHITELIST],
  ['problems/ProblemListPage.tsx',   'baseColumns',    PROBLEM_SORT_WHITELIST],
  ['requests/RequestListPage.tsx',   'baseColumns',    REQUEST_SORT_WHITELIST],
  ['changes/ChangeListPage.tsx',     'baseColumns',    CHANGE_SORT_WHITELIST],
  ['teams/TeamsPage.tsx',            'COLUMNS',        TEAM_SORT_WHITELIST],
  ['users/UsersPage.tsx',            'COLUMNS',        USER_SORT_WHITELIST],
  ['cmdb/CMDBPage.tsx',              'columns',        ALL_CIS_SORT_WHITELIST],
  ['ci/CIListPage.tsx',              'COLUMNS',        CI_SORT_WHITELIST],
  ['admin/AuditLogPage.tsx',         'columns',        AUDIT_SORT_WHITELIST],
  ['anomaly/AnomalyPage.tsx',        'columns',        ANOMALY_SORT_WHITELIST],
  ['admin/IntegrationsPage.tsx',     'inboundColumns', INBOUND_WEBHOOK_SORT_WHITELIST],
  ['admin/IntegrationsPage.tsx',     'outboundColumns', OUTBOUND_WEBHOOK_SORT_WHITELIST],
  ['admin/IntegrationsPage.tsx',     'apiKeyColumns',  API_KEY_SORT_WHITELIST],
  ['admin/AutoTriggersPage.tsx',     'triggerColumns', AUTO_TRIGGER_SORT_WHITELIST],
  ['admin/BusinessRulesPage.tsx',    'ruleColumns',    BUSINESS_RULE_SORT_WHITELIST],
  ['admin/SLAPoliciesPage.tsx',      'policyColumns',  SLA_POLICY_SORT_WHITELIST],
  ['admin/KBAdminPage.tsx',          'articleColumns', KB_ARTICLE_SORT_WHITELIST],
]

describe('ordinamento: ogni colonna del web esiste nella whitelist del resolver', () => {
  it.each(PAGES)('%s %s', (page, array, whitelist) => {
    const keys = sortableColumnKeys(page, array)
    expect(keys.length, `nessuna colonna trovata in ${page} (${array}): il guardiano non sta leggendo nulla`).toBeGreaterThan(0)
    for (const key of keys) {
      expect(whitelist, `${page}: la colonna «${key}» si ordina nel web ma il resolver non la conosce`).toHaveProperty(key)
    }
  })

  it('le pagine che ordinano sul server passano onSort alla tabella', () => {
    for (const [page] of PAGES) {
      const source = readFileSync(join(webPages, page), 'utf8')
      expect(source, `${page}: colonne ordinabili senza onSort`).toContain('onSort={')
    }
  })
})
