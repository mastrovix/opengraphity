/**
 * Contratto API ↔ web sull'ordinamento delle liste (revisione totale · B-9).
 *
 * Una colonna dichiarata `sortable: true` in una pagina che ordina sul
 * SERVER (cioè che passa `onSort` alla tabella) manda la sua chiave come
 * `sortField`. Se quella chiave non è nella whitelist del resolver, il
 * resolver ricade sull'ordinamento predefinito senza dire niente: la tabella
 * mostra la freccia, l'utente crede di aver ordinato e l'ordine non cambia.
 * Era il caso di `number` su incident, problem e richieste, e di `type` nella
 * CMDB.
 *
 * Il guardiano legge le colonne dai sorgenti del web (letterali, quindi
 * leggibili senza compilare React) e le confronta con le mappe esportate dai
 * resolver. Le colonne dei campi personalizzati del cliente
 * (`useCustomFieldColumns`) non sono letterali e restano fuori: quelle non
 * sono ordinabili.
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

const here = dirname(fileURLToPath(import.meta.url))
const webPages = join(here, '../../../../web/src/pages')

/**
 * Le chiavi delle colonne `sortable: true` di un file di pagina. Ogni colonna
 * comincia con `key: '…'`: la fetta fino alla chiave successiva è la sua
 * definizione, e dentro si cerca `sortable: true`.
 */
function sortableKeys(relativePath: string): string[] {
  const source = readFileSync(join(webPages, relativePath), 'utf8')
  const marks = [...source.matchAll(/key:\s*'([^']+)'/g)]
  const keys: string[] = []
  marks.forEach((m, i) => {
    const from = m.index
    const to = i + 1 < marks.length ? marks[i + 1]!.index : source.length
    if (/sortable:\s*true/.test(source.slice(from, to))) keys.push(m[1]!)
  })
  return keys
}

/** Pagine che ordinano sul server (passano `onSort`) e la whitelist del loro resolver. */
const PAGES: [string, Record<string, string>][] = [
  ['incidents/IncidentListPage.tsx', INCIDENT_SORT_WHITELIST],
  ['problems/ProblemListPage.tsx',   PROBLEM_SORT_WHITELIST],
  ['requests/RequestListPage.tsx',   REQUEST_SORT_WHITELIST],
  ['teams/TeamsPage.tsx',            TEAM_SORT_WHITELIST],
  ['users/UsersPage.tsx',            USER_SORT_WHITELIST],
  ['cmdb/CMDBPage.tsx',              ALL_CIS_SORT_WHITELIST],
  ['ci/CIListPage.tsx',              CI_SORT_WHITELIST],
  ['changes/ChangeListPage.tsx',     CHANGE_SORT_WHITELIST],
]

describe('ordinamento: ogni colonna ordinabile del web esiste nella whitelist del resolver', () => {
  it.each(PAGES)('%s', (page, whitelist) => {
    const keys = sortableKeys(page)
    expect(keys.length, `nessuna colonna ordinabile trovata in ${page}: il guardiano non sta leggendo nulla`).toBeGreaterThan(0)
    for (const key of keys) {
      expect(whitelist, `${page}: la colonna «${key}» è ordinabile nel web ma il resolver non la conosce`).toHaveProperty(key)
    }
  })

  it('le pagine che ordinano sul server passano onSort alla tabella', () => {
    for (const [page] of PAGES) {
      const source = readFileSync(join(webPages, page), 'utf8')
      expect(source, `${page}: colonne ordinabili senza onSort`).toContain('onSort={')
    }
  })
})
