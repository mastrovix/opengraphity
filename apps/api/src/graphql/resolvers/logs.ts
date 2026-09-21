import { GraphQLError } from 'graphql'
import type { GraphQLContext } from '../../context.js'
import { getLogs, type LogEntry } from '../../lib/logBuffer.js'
import { righePersistite, fondi, MAX_RIGHE } from '../../lib/persistedLogs.js'
import { requirePermission } from '../../lib/permissions.js'

type LogsArgs = {
  limit?:         number
  offset?:        number
  filters?:       string
  sortField?:     string
  sortDirection?: string
}

interface FilterRule {
  field:    string
  operator: string
  value:    string
}

interface FilterGroup {
  rules: FilterRule[]
}

function matchesFilter(entry: LogEntry, rule: FilterRule): boolean {
  const raw = (entry as unknown as Record<string, string | null>)[rule.field] ?? ''
  const val = (raw ?? '').toLowerCase()
  const cmp = rule.value.toLowerCase()

  switch (rule.operator) {
    case 'eq':       return val === cmp
    case 'neq':      return val !== cmp
    case 'contains': return val.includes(cmp)
    case 'starts':   return val.startsWith(cmp)
    case 'ends':     return val.endsWith(cmp)
    case 'gte':      return raw != null && raw >= rule.value
    case 'lte':      return raw != null && raw <= rule.value + 'T23:59:59.999Z'
    default:         return true
  }
}

async function logs(
  _: unknown,
  { limit = 50, offset = 0, filters, sortField, sortDirection }: LogsArgs,
  ctx: GraphQLContext,
) {
  requirePermission(ctx, 'admin.audit')

  /*
   * LE DUE METÀ (20 set 2026).
   *
   * Prima qui c'era solo l'anello in memoria, e la pagina mostrava soltanto
   * i log del SERVER di questo processo dall'ultimo riavvio. Gli errori dei
   * browser degli utenti — che sono persistiti da sempre, 1.095 righe su
   * `c-one` — non li leggeva nessuno: zero `MATCH (:LogEntry)` in tutto
   * l'albero. Adesso la pagina mostra le due metà in una linea del tempo
   * sola.
   *
   * I log del SERVER persistiti (`:ServerLogEntry`, ondata 3) NON entrano
   * qui, ed è una scelta: quell'archivio non ha un tenant per costruzione e
   * riguarda la piattaforma intera. Si legge da `/platform/server-logs`, con
   * l'identità di piattaforma.
   */
  const { righe: persistite, totale: totalePersistite } = await righePersistite(ctx.tenantId)
  const inMemoria = getLogs(ctx.tenantId)
  let entries = fondi(inMemoria, persistite) // newest-first
  /* La finestra taglia quando l'archivio è più grande di quanto se ne legga. */
  const truncated = totalePersistite > persistite.length

  // Apply advanced filters. Malformed filters must error — silently ignoring
  // them would show the admin ALL logs while they believe the list is filtered.
  if (filters) {
    let group: FilterGroup
    try { group = JSON.parse(filters) as FilterGroup }
    catch (e) {
      throw new GraphQLError(`Invalid log filters JSON: ${e instanceof Error ? e.message : String(e)}`)
    }
    if (group.rules?.length) {
      entries = entries.filter((e) =>
        group.rules.every((r) => matchesFilter(e, r)),
      )
    }
  }

  // Sort
  if (sortField) {
    const dir = sortDirection === 'desc' ? -1 : 1
    entries = [...entries].sort((a, b) => {
      const av = (a as unknown as Record<string, string | null>)[sortField] ?? ''
      const bv = (b as unknown as Record<string, string | null>)[sortField] ?? ''
      return av < bv ? -dir : av > bv ? dir : 0
    })
  }

  const total = entries.length
  const page  = entries.slice(offset, offset + limit)

  /*
   * `total` è quanto c'è DENTRO la finestra, non quanto c'è in archivio: i
   * filtri girano in memoria su ciò che è stato letto. `truncated` dice che
   * esiste dell'altro più indietro, così una lista che sembra completa non lo
   * lascia credere.
   */
  return { entries: page, total, truncated, windowSize: MAX_RIGHE }
}

export const logsResolvers = {
  Query: { logs },
}
