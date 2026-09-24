/**
 * ONE TENANT NEVER SEES ANOTHER'S DATA — on a real Neo4j (wave 7 · C2).
 *
 * The unit tests mock the database in hundreds of files: they check that a
 * query CARRIES `tenant_id`, not that the query Neo4j runs returns only the
 * tenant's rows. Here the two tenants of `tenants.ts` exist for real, with the
 * same shapes and different ids, and the tenant's own GraphQL schema is
 * executed with the context of tenant A's administrator:
 *
 *  - every read of the schema (every root query with no required argument)
 *    runs, with its nested fields two levels down — the field resolvers too;
 *  - every read by id runs with ids of tenant B, of the type it returns;
 *
 * and no answer may contain an id of tenant B. Ids both tenants share (the
 * factory data may use fixed ids) cannot tell a leak and are left out, and
 * counted. A query that fails is not a leak; the failures are listed, and a
 * failure the server reports as internal fails the suite — an error without a
 * code too, which Apollo reports as INTERNAL_SERVER_ERROR: on a real database
 * it is a defect the mocks hid. The first run found three (a non-null field
 * returned as null, `itilTypes`, `teams`, `reportTemplates`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  getNamedType, graphql, isAbstractType, isInterfaceType, isLeafType, isNonNullType, isObjectType, isUnionType,
  type GraphQLArgument, type GraphQLField, type GraphQLNamedType, type GraphQLSchema,
} from 'graphql'
import { closeDriver, getSession, runQuery } from '@opengraphity/neo4j'
import { closeConnection as closeEventConnection } from '@opengraphity/events'
import { getSchemaForTenant } from '../graphql/schemaCache.js'
import { rolePermissions } from '../lib/roles.js'
import { stopMetamodelBus } from '../lib/metamodelBus.js'
import { stopInAppBus } from '../lib/inAppBus.js'
import { closeAllQueues } from '../lib/bullmq.js'
import type { GraphQLContext } from '../context.js'
import { assertThrowawayDatabase, TENANT_A, TENANT_B } from './tenants.js'

/** How deep a query goes below the root: the list, its items, their linked objects. */
const DEPTH = 3
/** The page size asked where a read takes one: enough rows to meet the other tenant's, if a query leaks. */
const PAGE = 25

/**
 * Reads that fail here for the environment, not for the product: the suite
 * starts Neo4j and Redis only. Each with its reason; any other failure counts.
 */
const NEEDS_WHAT_THE_SUITE_DOES_NOT_START: Record<string, string> = {
  loginSettings: 'reads the tenant realm from Keycloak (KEYCLOAK_ADMIN_PASSWORD), which the suite does not start',
}

/** The codes Apollo reports as a failure of the product: a thrown Error has none, and becomes INTERNAL_SERVER_ERROR. */
const INTERNAL = new Set(['INTERNAL_SERVER_ERROR', 'NONE'])

interface Outcome {
  root: string
  field: string
  leaked: string[]
  ownIds: number
  errors: Array<{ code: string; message: string; path: string }>
}

let schema: GraphQLSchema
let ctx: GraphQLContext
let foreignIds: Set<string>
let ownIds: Set<string>
let sharedIds = 0

async function idsOf(tenantId: string): Promise<Set<string>> {
  const session = getSession(undefined, 'READ')
  try {
    const rows = await runQuery<{ id: string }>(session,
      'MATCH (n) WHERE n.tenant_id = $tenantId AND n.id IS NOT NULL RETURN DISTINCT toString(n.id) AS id', { tenantId })
    return new Set(rows.map((r) => r.id))
  } finally {
    await session.close()
  }
}

/** A value for an optional argument that makes a read return rows: a page size, nothing else. */
function optionalArg(a: GraphQLArgument): string | null {
  const t = getNamedType(a.type).name
  if (t === 'Int' && /^(limit|first|pageSize|size|take)$/.test(a.name)) return `${a.name}: ${String(PAGE)}`
  return null
}

function argsText(args: string[]): string {
  return args.length > 0 ? `(${args.join(', ')})` : ''
}

function hasRequiredArgs(f: GraphQLField<unknown, unknown>): boolean {
  return f.args.some((a) => isNonNullType(a.type) && a.defaultValue === undefined)
}

/** The selection of a type: its id (and tenantId), and its linked objects down to `depth`. */
function selection(type: GraphQLNamedType, depth: number): string {
  if (isLeafType(type)) return ''
  if (isUnionType(type)) {
    const parts = type.getTypes().map((t) => `... on ${t.name} ${selection(t, depth)}`)
    return `{ __typename ${parts.join(' ')} }`
  }
  if (!isObjectType(type) && !isInterfaceType(type)) return ''
  const parts = ['__typename']
  for (const f of Object.values(type.getFields())) {
    if (hasRequiredArgs(f)) continue
    const named = getNamedType(f.type)
    if (isLeafType(named)) {
      if (f.name === 'id' || f.name === 'tenantId') parts.push(f.name)
      continue
    }
    if (depth <= 1) continue
    const sub = selection(named, depth - 1)
    if (sub) parts.push(`${f.name}${argsText(f.args.map(optionalArg).filter((x): x is string => x !== null))} ${sub}`)
  }
  if (isAbstractType(type) && isInterfaceType(type)) {
    // The concrete types behind an interface: their own linked objects too.
    for (const t of schema.getPossibleTypes(type)) parts.push(`... on ${t.name} ${selection(t, depth)}`)
  }
  return `{ ${parts.join(' ')} }`
}

/** Every string in an answer: ids hide at any depth. */
function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const v of value) strings(v, out)
  else if (value !== null && typeof value === 'object') for (const v of Object.values(value)) strings(v, out)
  return out
}

async function run(field: GraphQLField<unknown, unknown>, args: string[]): Promise<Outcome> {
  const sub = selection(getNamedType(field.type), DEPTH)
  const source = `query Integration { ${field.name}${argsText(args)} ${sub} }`
  const result = await graphql({ schema, source, contextValue: ctx })
  const seen = strings(result.data ?? null)
  return {
    root: field.name,
    field: `${field.name}${argsText(args)}`,
    leaked: [...new Set(seen.filter((s) => foreignIds.has(s)))],
    ownIds: seen.filter((s) => ownIds.has(s)).length,
    errors: (result.errors ?? []).map((e) => ({
      code: String(e.extensions?.['code'] ?? 'NONE'),
      message: e.message,
      path: (e.path ?? []).map((p) => (typeof p === 'number' ? '[]' : p)).join('.'),
    })),
  }
}

beforeAll(async () => {
  await assertThrowawayDatabase()
  const [a, b] = await Promise.all([idsOf(TENANT_A.id), idsOf(TENANT_B.id)])
  sharedIds = [...b].filter((id) => a.has(id)).length
  foreignIds = new Set([...b].filter((id) => !a.has(id)))
  ownIds = a
  const session = getSession(undefined, 'READ')
  try {
    const admin = await runQuery<{ id: string; email: string }>(session,
      `MATCH (u:User {tenant_id: $tenantId, role: 'admin'}) RETURN u.id AS id, u.email AS email ORDER BY u.created_at LIMIT 1`,
      { tenantId: TENANT_A.id })
    if (!admin[0]) throw new Error(`${TENANT_A.id} has no administrator: run the preparation first`)
    ctx = {
      tenantId: TENANT_A.id, userId: admin[0].id, userEmail: admin[0].email,
      role: 'admin', permissions: await rolePermissions(TENANT_A.id, 'admin'),
    }
  } finally {
    await session.close()
  }
  schema = await getSchemaForTenant(TENANT_A.id)
})

afterAll(async () => {
  await closeEventConnection()
  await stopInAppBus()
  await stopMetamodelBus()
  await closeAllQueues()
  await closeDriver()
})

/** Names an argument uses for a label that its capitalized prefix does not spell. */
const ARG_LABELS: Record<string, string[]> = {
  ci: ['ConfigurationItem'], type: ['CITypeDefinition'], template: ['ReportTemplate'],
  conversation: ['ReportConversation'], map: ['ServiceMap'], source: ['SyncSource'],
  article: ['KBArticle'], request: ['ServiceRequest'], ticket: ['Incident', 'Problem', 'Change', 'ServiceRequest'],
  entity: ['Incident', 'Problem', 'Change', 'ServiceRequest', 'ConfigurationItem'],
}

/**
 * The labels whose ids a read by id takes: the type it returns (the concrete
 * types behind an interface or a union), then what its argument names
 * (`changeId` → Change).
 */
function candidateLabels(f: GraphQLField<unknown, unknown>, argName: string): string[] {
  const named = getNamedType(f.type)
  const byType = isAbstractType(named) ? schema.getPossibleTypes(named).map((t) => t.name) : [named.name]
  const prefix = /^(.+)Id$/.exec(argName)?.[1]
  const byArg = prefix ? (ARG_LABELS[prefix] ?? [prefix.charAt(0).toUpperCase() + prefix.slice(1)]) : []
  return [...new Set([...byType, ...byArg])]
}

function report(outcomes: Outcome[]): void {
  const failed = outcomes.filter((o) => o.errors.length > 0)
  console.log(`[integration] ${String(outcomes.length)} queries, ${String(outcomes.filter((o) => o.ownIds > 0).length)} returned ids of ${TENANT_A.id}, ${String(failed.length)} answered with an error`)
  for (const o of failed) {
    const distinct = [...new Set(o.errors.map((e) => `${e.code} at ${e.path}: ${e.message.slice(0, 160)}`))]
    console.log(`  ${o.field}: ${distinct.join(' | ')}`)
  }
}

/** The reads that failed as the product, the ones the environment explains left out. */
function internalFailures(outcomes: Outcome[]): string[] {
  return outcomes
    .filter((o) => !(o.root in NEEDS_WHAT_THE_SUITE_DOES_NOT_START))
    .filter((o) => o.errors.some((e) => INTERNAL.has(e.code)))
    .map((o) => `${o.field}: ${[...new Set(o.errors.filter((e) => INTERNAL.has(e.code)).map((e) => `${e.path} ${e.message}`))].join(' | ')}`)
}

describe(`${TENANT_A.id} never sees ${TENANT_B.id}`, () => {
  it('the two tenants exist and have their own ids', () => {
    expect(ownIds.size).toBeGreaterThan(1000)
    expect(foreignIds.size).toBeGreaterThan(1000)
    console.log(`[integration] ${String(ownIds.size)} ids in ${TENANT_A.id}, ${String(foreignIds.size)} in ${TENANT_B.id}, ${String(sharedIds)} shared (left out)`)
  })

  it('every read of the schema: no id of the other tenant, no internal error', async () => {
    const reads = Object.values(schema.getQueryType()!.getFields()).filter((f) => !hasRequiredArgs(f))
    const outcomes: Outcome[] = []
    for (const f of reads) outcomes.push(await run(f, f.args.map(optionalArg).filter((x): x is string => x !== null)))
    report(outcomes)
    expect(outcomes.filter((o) => o.leaked.length > 0).map((o) => `${o.field}: ${o.leaked.slice(0, 3).join(', ')}`)).toEqual([])
    expect(internalFailures(outcomes)).toEqual([])
    // The suite proves something only if the reads meet the tenant's own data.
    expect(outcomes.filter((o) => o.ownIds > 0).length).toBeGreaterThan(20)
  })

  it(`every read by id, asked with ids of ${TENANT_B.id}: nothing comes back`, async () => {
    const byId = Object.values(schema.getQueryType()!.getFields()).filter((f) => {
      const required = f.args.filter((a) => isNonNullType(a.type) && a.defaultValue === undefined)
      return required.length === 1 && getNamedType(required[0]!.type).name === 'ID'
    })
    const outcomes: Outcome[] = []
    const untried: string[] = []
    const session = getSession(undefined, 'READ')
    try {
      for (const f of byId) {
        const idArg = f.args.find((a) => isNonNullType(a.type) && a.defaultValue === undefined)!
        const labels = candidateLabels(f, idArg.name).filter((l) => /^[A-Za-z][A-Za-z0-9_]*$/.test(l))
        const ids = labels.length === 0 ? [] : await runQuery<{ id: string }>(session,
          `MATCH (n) WHERE n.tenant_id = $tenantId AND n.id IS NOT NULL AND any(l IN labels(n) WHERE l IN $labels)
           RETURN toString(n.id) AS id LIMIT 2`, { tenantId: TENANT_B.id, labels })
        const foreign = ids.map((r) => r.id).filter((id) => foreignIds.has(id))
        if (foreign.length === 0) { untried.push(f.name); continue }
        for (const id of foreign) outcomes.push(await run(f, [`${idArg.name}: ${JSON.stringify(id)}`]))
      }
    } finally {
      await session.close()
    }
    report(outcomes)
    console.log(`[integration] reads by id without a node of ${TENANT_B.id} of their type (not tried): ${untried.join(', ') || 'none'}`)
    expect(outcomes.filter((o) => o.leaked.length > 0).map((o) => `${o.field}: ${o.leaked.slice(0, 3).join(', ')}`)).toEqual([])
    expect(internalFailures(outcomes)).toEqual([])
    expect(outcomes.length).toBeGreaterThan(10)
  })
})
