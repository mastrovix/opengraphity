import { GraphQLError } from 'graphql'
import type { GraphQLContext } from '../../context.js'
import { getLogs, type LogEntry } from '../../lib/logBuffer.js'
import { righePersistite, fondi, MAX_RIGHE } from '../../lib/persistedLogs.js'
import { requirePermission } from '../../lib/permissions.js'
import { ValidationError } from '../../lib/errors.js'

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
  value:    string | string[] | null
  value2?:  string | null
  /** The connector with the NEXT rule, as the web's FilterBuilder writes it. */
  logic?:   'AND' | 'OR'
}

interface FilterGroup {
  rules: FilterRule[]
}

/** The fields of a log line the page filters on. */
const LOG_FILTER_FIELDS = new Set(['message', 'level', 'module', 'timestamp'])

/**
 * One rule on one log line, with the operators of the web's FilterBuilder and
 * their meaning in the Cypher filters (lib/filterBuilder.ts) — review of
 * 23 Sep 2026: this knew `eq`/`neq`/`starts`… and let everything else through,
 * so «Level equals error» showed every level, and `in` (a list) crashed.
 */
export function matchesLogRule(entry: LogEntry, rule: FilterRule, now: Date = new Date()): boolean {
  const raw = (entry as unknown as Record<string, unknown>)[rule.field]
  const text = raw == null ? '' : String(raw)
  const val = text.toLowerCase()
  const one = typeof rule.value === 'string' ? rule.value : ''
  const cmp = one.toLowerCase()
  const list = Array.isArray(rule.value) ? rule.value.map((v) => String(v).toLowerCase()) : []
  const at = Date.parse(text)
  const day = 24 * 3600 * 1000
  switch (rule.operator) {
    case 'contains':     return val.includes(cmp)
    case 'starts_with':  return val.startsWith(cmp)
    case 'ends_with':    return val.endsWith(cmp)
    case 'equals':       return val === cmp
    case 'not_equals':   return val !== cmp
    case 'in':           return list.includes(val)
    case 'not_in':       return !list.includes(val)
    case 'is_empty':     return text.trim() === ''
    case 'is_not_empty': return text.trim() !== ''
    case 'after':        return Number.isFinite(at) && at > Date.parse(one)
    case 'before':       return Number.isFinite(at) && at < Date.parse(one)
    case 'between':      return Number.isFinite(at) && at >= Date.parse(one) && at <= Date.parse(rule.value2 ?? '')
    case 'today':        return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === now.toISOString().slice(0, 10)
    case 'last_7_days':  return Number.isFinite(at) && at > now.getTime() - 7 * day
    case 'last_30_days': return Number.isFinite(at) && at > now.getTime() - 30 * day
    default:
      throw new ValidationError(`Unknown log filter operator ${JSON.stringify(rule.operator)}`,
        { key: 'errors.logs.filterOperator', params: { operator: String(rule.operator) } })
  }
}

/**
 * The whole group, as the Cypher filters read it: `OR` keeps a rule in the
 * same group as the next one, `AND` closes the group; groups are AND-ed.
 */
export function matchesLogFilter(entry: LogEntry, rules: readonly FilterRule[], now: Date = new Date()): boolean {
  let group: boolean[] = []
  for (let i = 0; i < rules.length; i++) {
    group.push(matchesLogRule(entry, rules[i]!, now))
    if (i === rules.length - 1 || (rules[i]!.logic ?? 'AND') === 'AND') {
      if (!group.some(Boolean)) return false
      group = []
    }
  }
  return true
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
      // A field the page does not have is a corrupt filter too: said, not ignored.
      const unknown = group.rules.find((r) => !LOG_FILTER_FIELDS.has(r.field))
      if (unknown) {
        throw new ValidationError(`Unknown log filter field ${JSON.stringify(unknown.field)}`,
          { key: 'errors.logs.filterField', params: { field: String(unknown.field) } })
      }
      const now = new Date()
      entries = entries.filter((e) => matchesLogFilter(e, group.rules, now))
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
