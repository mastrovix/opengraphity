/**
 * TABLES ARE THE APP'S TABLES (26 Sep 2026, the owner: «perché ci sono tabelle
 * fatte a mano?» → «sì vai»).
 *
 * A list is SortableFilterTable; a small table inside a page is SimpleTable.
 * Hand-made tables each had their own header, hover and link on the name, and
 * rows that looked alike behaved differently. A raw <table> is allowed only
 * where a row is a piece of a form (editors) or where the table renders text
 * that is not ours (Markdown from the assistant). This guard reads every file.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function tsx(dir = SRC, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'test') tsx(p, out); continue }
    if (e.name.endsWith('.tsx') && !e.name.includes('.test.')) out.push(p)
  }
  return out
}

/** Where a raw <table> is right, and why. */
const ALLOWED: Record<string, string> = {
  'components/SortableFilterTable.tsx': 'the table of the lists',
  'components/ui/SimpleTable.tsx': 'the small table',
  'pages/monitoring/ServiceComponentsTable.tsx': 'editor: each row edits a component (propagation, weight, critical)',
  'pages/settings/DomainMatricesPage.tsx': 'editor: a matrix of selects',
  'pages/settings/EventPolicySeverityFields.tsx': 'editor: a select per severity',
  'pages/settings/NotificationRulesPage.tsx': 'editor: each row edits a rule',
  'pages/settings/catalogForm/ItineraryPanel.tsx': 'editor: a select per step',
  'pages/settings/catalogForm/TableColumnsEditor.tsx': 'editor: the columns of a table field',
  'pages/settings/organization/TicketNumberingSection.tsx': 'editor: prefix and digits per ticket kind',
  'pages/settings/shared/FieldRulesPanel.tsx': 'editor: a rule per field',
  'pages/proposals/DailyWorkPage.tsx': 'Markdown written by the assistant',
  'pages/reports/ReportsPage.tsx': 'Markdown written by the assistant',
}

describe('hand-made tables', () => {
  it('a raw <table> only where a row is a form or the text is not ours', () => {
    const found = tsx().filter((f) => /<table\b/.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(SRC, f)).sort()
    expect(found).toEqual(Object.keys(ALLOWED).sort())
  })
})
