/**
 * EVERY COLUMN SORTS (26 Sep 2026, the owner: «le colonne dovrebbero essere
 * sempre tutte ordinabili»).
 *
 * In SortableFilterTable and SimpleTable a column sorts unless it says
 * `sortable: false`, and only a column that holds nothing but buttons (edit,
 * delete, restore, open the map) may say it. This guard reads every file and
 * counts the `sortable: false` per file against this list. The server side —
 * every column of a server-sorted list known to its resolver — is
 * apps/api/src/graphql/__tests__/sortWhitelists.test.ts.
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

/** The columns of buttons, per file: the only ones that do not sort. */
const BUTTON_COLUMNS: Record<string, number> = {
  'pages/admin/AutoTriggersPage.tsx': 1,         // edit, toggle, delete
  'pages/admin/BusinessRulesPage.tsx': 1,        // edit, move, delete
  'pages/admin/KBAdminPage.tsx': 2,              // edit/delete an article; restore a version
  'pages/admin/SLAPoliciesPage.tsx': 1,          // edit, delete
  'pages/admin/ServiceCatalogAdminPage.tsx': 1,  // edit, activate/deactivate
  'pages/analysis/WhatIfPage.tsx': 1,            // open the path graph
  'pages/monitoring/CIHealthPage.tsx': 1,        // see on the map
  'pages/monitoring/MonitoringSourcesPage.tsx': 1, // edit, test, delete
  'pages/roles/RolesPage.tsx': 1,                // edit, duplicate, delete
  'pages/settings/catalogForm/FieldLibraryPanel.tsx': 1, // edit, delete
  'pages/settings/citype/CIRelationEditor.tsx': 1, // delete a relation
  'pages/teams/TeamDetailPage.tsx': 1,           // remove a member
}

describe('sortable columns', () => {
  it('a column does not sort only if it holds nothing but buttons', () => {
    const found: Record<string, number> = {}
    for (const f of tsx()) {
      const n = (fs.readFileSync(f, 'utf8').match(/sortable:\s*false/g) ?? []).length
      if (n > 0) found[path.relative(SRC, f)] = n
    }
    expect(found).toEqual(BUTTON_COLUMNS)
  })
})
