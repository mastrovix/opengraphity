import { GraphQLError } from 'graphql'
import { ForbiddenError } from '../../lib/errors.js'
import type { GraphQLContext } from '../../context.js'
import { getLogs, type LogEntry } from '../../lib/logBuffer.js'

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
  if (ctx.role !== 'admin') {
    throw new ForbiddenError('Forbidden: logs are only accessible to admins')
  }

  let entries = getLogs() // already newest-first

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

  return { entries: page, total }
}

export const logsResolvers = {
  Query: { logs },
}
