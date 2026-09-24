/**
 * CMDB HEALTH (owner's request, 24 Sep 2026): what is missing or does not add
 * up in the CMDB, counted live — no scanner, no stored findings. The Anomalies
 * stay for the risks of the graph (SPOF, cycles, isolated clusters); this is
 * the quality of the data itself.
 *
 * ## Nothing named in the code
 * Which types a check looks at comes from the tenant's metamodel and from the
 * CMDB chains the tenant drew (services/cmdbChains), never from a list of
 * type names:
 *  - «outside every chain», «incomplete chain», «relation not admitted»: the
 *    drawn chains — what a root reaches, the required links, the relations
 *    they admit (the API refuses the others, so these read zero unless
 *    something got in another way);
 *  - «an application»: the types whose only family is Application;
 *  - «a certificate»: the types whose service role is `certificate`;
 *  - «required»: the fields the type declares required;
 *  - «owner / support group»: only the types that declare that group (a
 *    business capability has no Support Group, 24 Sep 2026);
 *  - «outside every chain»: not the CIs flagged `isInfrastructure` (backup,
 *    monitoring, directory… serve the whole company, not one application).
 * Retired CIs — the statuses the tenant's lifecycle semantics calls retired —
 * are left out of every check: a decommissioned server without an owner is
 * not a defect of the CMDB. One exception: an expired certificate is looked
 * at whatever its status, since `expired` is itself a retired status.
 *
 * ## One literal query per check
 * Each query returns the population it looked at, how many are wrong and the
 * page asked for, in one round trip and with no interpolated Cypher: every
 * label, field and status arrives as a parameter, so check-cypher verifies
 * each of them with EXPLAIN like any literal query. «Outside every chain» and
 * «incomplete chain» come from a walk of the chains instead
 * (cmdbChains/evaluate.ts), done once per request.
 */
import type { Session } from 'neo4j-driver'
import { getSession, runQuery, toNumber } from '@opengraphity/neo4j'
import { loadMetamodel, type CITypeWithDefinitions } from '@opengraphity/schema-generator'
import { ENUM_SCOPE } from '../lib/enumScope.js'
import { serviceRolesForTenant } from '../lib/ciMetamodelForTenant.js'
import { resolveCILifecycleSemantics } from '../lib/ciLifecycle.js'
import { CHAIN_FAMILIES } from '../lib/chainCalculator.js'
import { toSnakeCase } from '../lib/mappers.js'
import { ValidationError } from '../lib/errors.js'
import { admittedRelationKeys, drawnTypeLabels, type CmdbChain } from './cmdbChains/model.js'
import { listChains } from './cmdbChains/store.js'
import { evaluateChains, type ChainCoverage, type ChainEvaluation, type MissingLink } from './cmdbChains/evaluate.js'

export const CMDB_HEALTH_CHECKS = [
  'chain_orphan', 'chain_incomplete', 'relation_not_admitted', 'missing_owner_group', 'missing_support_group', 'certificate_unrelated',
  'application_without_cis', 'certificate_expired_in_use', 'duplicate_name', 'required_field_empty',
] as const
export type CmdbHealthCheckKey = (typeof CMDB_HEALTH_CHECKS)[number]

/** The checks the drawn CMDB chains decide (services/cmdbChains): with no chain drawn, they say so. */
export const CHAIN_CHECKS: ReadonlySet<CmdbHealthCheckKey> = new Set(['chain_orphan', 'chain_incomplete', 'relation_not_admitted'])
/** The two a walk of the chains answers, not a single query. */
type WalkedCheck = 'chain_orphan' | 'chain_incomplete'
const isWalked = (check: CmdbHealthCheckKey): check is WalkedCheck => check === 'chain_orphan' || check === 'chain_incomplete'

/**
 * The expiry of a certificate: the field of the shipped certificate type
 * (seed-metamodel). A certificate type of the customer's without it cannot be
 * checked for expiry, and the summary names it instead of skipping it quietly.
 */
export const CERTIFICATE_EXPIRY_FIELD = 'expiresAt'

const [APPLICATION_FAMILY] = CHAIN_FAMILIES

/** Does the type declare this group among its system relations (the same rule the API enforces, lib/ciGroups.ts)? */
const declares = (t: CITypeWithDefinitions, relation: string): boolean => (t.systemRelations ?? []).some((r) => r.name === relation)

/** What a check needs to know about the tenant, read once per request. */
export interface HealthContext {
  tenantId:          string
  retired:           string[]
  applicationLabels: string[]
  certificateLabels: string[]
  /** Certificate label → the property holding its expiry. */
  expiryByLabel:     Record<string, string>
  /** Label → the properties its type declares required. */
  requiredByLabel:   Record<string, string[]>
  /** Certificate types that have no expiry field: not checked for expiry. */
  certificateTypesWithoutExpiry: string[]
  /** The types that declare the group (a business capability has no Support Group): only their CIs can miss it. */
  ownerGroupLabels:   string[]
  supportGroupLabels: string[]
  typeByLabel:       Map<string, CITypeWithDefinitions>
  types:             CITypeWithDefinitions[]
  /** The labels of the tenant's CI types: a relation is judged between these. */
  typeLabels:        string[]
  /** The drawn CMDB chains, and the relations they admit (`Source|RELATION|Target`). */
  chains:            CmdbChain[]
  admitted:          string[]
  /** The labels of the types some chain draws: the relations between these are the chains' to judge. */
  drawnLabels:       string[]
  /** The walk of the chains over the data, done once per request when a check needs it. */
  walk?:             Promise<ChainEvaluation>
}

export async function healthContext(tenantId: string, session: Session): Promise<HealthContext> {
  const [types, roles, lifecycle, chains] = await Promise.all([
    loadMetamodel(tenantId, ENUM_SCOPE), serviceRolesForTenant(tenantId), resolveCILifecycleSemantics(tenantId), listChains(session, tenantId),
  ])
  const withLabel = types.filter((t) => t.neo4jLabel)
  const families = (t: CITypeWithDefinitions) => new Set(t.chainFamilies ?? [])
  const certificates = withLabel.filter((t) => roles.get(t.neo4jLabel) === 'certificate')
  const expiryByLabel: Record<string, string> = {}
  const certificateTypesWithoutExpiry: string[] = []
  for (const t of certificates) {
    const expiry = t.fields.find((f) => f.name === CERTIFICATE_EXPIRY_FIELD)
    if (expiry) expiryByLabel[t.neo4jLabel] = toSnakeCase(expiry.name)
    else certificateTypesWithoutExpiry.push(t.name)
  }
  const requiredByLabel: Record<string, string[]> = {}
  for (const t of withLabel) {
    const required = t.fields.filter((f) => f.required).map((f) => toSnakeCase(f.name))
    if (required.length) requiredByLabel[t.neo4jLabel] = required
  }
  return {
    tenantId,
    retired: [...lifecycle.retired],
    applicationLabels: withLabel.filter((t) => families(t).size === 1 && families(t).has(APPLICATION_FAMILY)).map((t) => t.neo4jLabel),
    certificateLabels: certificates.map((t) => t.neo4jLabel),
    expiryByLabel,
    requiredByLabel,
    certificateTypesWithoutExpiry,
    ownerGroupLabels: withLabel.filter((t) => declares(t, 'ownerGroup')).map((t) => t.neo4jLabel),
    supportGroupLabels: withLabel.filter((t) => declares(t, 'supportGroup')).map((t) => t.neo4jLabel),
    typeByLabel: new Map(withLabel.map((t) => [t.neo4jLabel, t])),
    types,
    typeLabels: withLabel.map((t) => t.neo4jLabel),
    chains,
    admitted: [...admittedRelationKeys(chains, types)],
    drawnLabels: [...drawnTypeLabels(chains, types)],
  }
}

/** The walk of the chains, once per request. */
function walkOf(session: Session, ctx: HealthContext): Promise<ChainEvaluation> {
  ctx.walk ??= evaluateChains(session, ctx.tenantId, ctx.chains, ctx.types, ctx.retired)
  return ctx.walk
}

/*
 * The shared shape: every query filters the tenant's CIs in service, by the
 * optional type label and environment, orders by name and returns
 * `population`, `total` and `items` (the page `[$offset..$offset + $limit]`).
 */
const CHECK_QUERIES: Readonly<Record<Exclude<CmdbHealthCheckKey, WalkedCheck>, string>> = {
  /*
   * A relation between two CIs in service that no drawn chain admits (owner,
   * 24 Sep 2026): the API refuses them, so this reads zero unless something got
   * in another way — old data, an import, a direct write. Only between types
   * some chain draws: a dynamic group and its members are outside the chains.
   */
  relation_not_admitted: `
    MATCH (a:ConfigurationItem {tenant_id: $tenantId})-[r]->(b:ConfigurationItem {tenant_id: $tenantId})
    WHERE NOT coalesce(a.status, '') IN $retired AND NOT coalesce(b.status, '') IN $retired
      AND ($type IS NULL OR $type IN labels(a)) AND ($environment IS NULL OR a.environment = $environment)
    WITH a, r, b, [l IN labels(a) WHERE l IN $typeLabels][0] AS fromLabel, [l IN labels(b) WHERE l IN $typeLabels][0] AS toLabel
    WHERE fromLabel IN $drawnLabels AND toLabel IN $drawnLabels
    WITH a, type(r) AS relation, b, fromLabel + '|' + type(r) + '|' + toLabel AS key
    ORDER BY toLower(a.name), a.id, relation, toLower(b.name), b.id
    WITH count(*) AS population, collect(CASE WHEN NOT key IN $admitted THEN {a: a, relation: relation, b: b} END) AS hits
    RETURN population, size(hits) AS total,
      [h IN hits[$offset..($offset + $limit)] | {id: h.a.id, name: h.a.name, labels: labels(h.a), environment: h.a.environment, status: h.a.status,
        relation: h.relation, relatedId: h.b.id, relatedName: h.b.name, relatedLabels: labels(h.b)}] AS items`,

  missing_owner_group: `
    MATCH (ci:ConfigurationItem {tenant_id: $tenantId})
    WHERE NOT coalesce(ci.status, '') IN $retired AND any(l IN labels(ci) WHERE l IN $ownerGroupLabels)
      AND ($type IS NULL OR $type IN labels(ci)) AND ($environment IS NULL OR ci.environment = $environment)
    WITH ci ORDER BY toLower(ci.name), ci.id
    WITH count(ci) AS population, collect(CASE WHEN NOT EXISTS { MATCH (ci)-[:OWNED_BY]->(:Team {tenant_id: $tenantId}) } THEN {ci: ci} END) AS hits
    RETURN population, size(hits) AS total,
      [h IN hits[$offset..($offset + $limit)] | {id: h.ci.id, name: h.ci.name, labels: labels(h.ci), environment: h.ci.environment, status: h.ci.status}] AS items`,

  missing_support_group: `
    MATCH (ci:ConfigurationItem {tenant_id: $tenantId})
    WHERE NOT coalesce(ci.status, '') IN $retired AND any(l IN labels(ci) WHERE l IN $supportGroupLabels)
      AND ($type IS NULL OR $type IN labels(ci)) AND ($environment IS NULL OR ci.environment = $environment)
    WITH ci ORDER BY toLower(ci.name), ci.id
    WITH count(ci) AS population, collect(CASE WHEN NOT EXISTS { MATCH (ci)-[:SUPPORTED_BY]->(:Team {tenant_id: $tenantId}) } THEN {ci: ci} END) AS hits
    RETURN population, size(hits) AS total,
      [h IN hits[$offset..($offset + $limit)] | {id: h.ci.id, name: h.ci.name, labels: labels(h.ci), environment: h.ci.environment, status: h.ci.status}] AS items`,

  certificate_unrelated: `
    MATCH (ci:ConfigurationItem {tenant_id: $tenantId})
    WHERE NOT coalesce(ci.status, '') IN $retired AND any(l IN labels(ci) WHERE l IN $certificateLabels)
      AND ($type IS NULL OR $type IN labels(ci)) AND ($environment IS NULL OR ci.environment = $environment)
    WITH ci ORDER BY toLower(ci.name), ci.id
    WITH count(ci) AS population,
      collect(CASE WHEN NOT EXISTS { MATCH (ci)--(o:ConfigurationItem) WHERE o.tenant_id = $tenantId } THEN {ci: ci} END) AS hits
    RETURN population, size(hits) AS total,
      [h IN hits[$offset..($offset + $limit)] | {id: h.ci.id, name: h.ci.name, labels: labels(h.ci), environment: h.ci.environment, status: h.ci.status}] AS items`,

  application_without_cis: `
    MATCH (ci:ConfigurationItem {tenant_id: $tenantId})
    WHERE NOT coalesce(ci.status, '') IN $retired AND any(l IN labels(ci) WHERE l IN $applicationLabels)
      AND ($type IS NULL OR $type IN labels(ci)) AND ($environment IS NULL OR ci.environment = $environment)
    WITH ci ORDER BY toLower(ci.name), ci.id
    WITH count(ci) AS population,
      collect(CASE WHEN NOT EXISTS { MATCH (ci)-->(o:ConfigurationItem) WHERE o.tenant_id = $tenantId } THEN {ci: ci} END) AS hits
    RETURN population, size(hits) AS total,
      [h IN hits[$offset..($offset + $limit)] | {id: h.ci.id, name: h.ci.name, labels: labels(h.ci), environment: h.ci.environment, status: h.ci.status}] AS items`,

  // The certificate's own status does not take it out: an expired certificate
  // is often marked `expired`, a retired status — and that is exactly the one
  // to find when a CI in service still uses it. Only its users must be in service.
  certificate_expired_in_use: `
    MATCH (ci:ConfigurationItem {tenant_id: $tenantId})
    WHERE ($type IS NULL OR $type IN labels(ci)) AND ($environment IS NULL OR ci.environment = $environment)
    WITH ci, [l IN labels(ci) WHERE l IN keys($expiryByLabel)][0] AS lbl
    WHERE lbl IS NOT NULL
    WITH ci, toString(ci[$expiryByLabel[lbl]]) AS expiresAt,
      COUNT { MATCH (ci)--(o:ConfigurationItem) WHERE o.tenant_id = $tenantId AND NOT coalesce(o.status, '') IN $retired } AS inUseBy
    ORDER BY toLower(ci.name), ci.id
    WITH count(ci) AS population,
      collect(CASE WHEN expiresAt IS NOT NULL AND expiresAt < $now AND inUseBy > 0 THEN {ci: ci, expiresAt: expiresAt, inUseBy: inUseBy} END) AS hits
    RETURN population, size(hits) AS total,
      [h IN hits[$offset..($offset + $limit)] | {id: h.ci.id, name: h.ci.name, labels: labels(h.ci), environment: h.ci.environment, status: h.ci.status,
        expiresAt: h.expiresAt, inUseBy: h.inUseBy}] AS items`,

  duplicate_name: `
    MATCH (ci:ConfigurationItem {tenant_id: $tenantId})
    WHERE NOT coalesce(ci.status, '') IN $retired
      AND ($type IS NULL OR $type IN labels(ci)) AND ($environment IS NULL OR ci.environment = $environment)
    WITH [l IN labels(ci) WHERE l <> 'ConfigurationItem'] AS kind, toLower(trim(coalesce(ci.name, ''))) AS nameKey, collect(ci) AS same
    WITH sum(size(same)) AS population, collect(CASE WHEN size(same) > 1 THEN same END) AS groups
    UNWIND (CASE WHEN size(groups) = 0 THEN [null] ELSE groups END) AS same
    UNWIND (CASE WHEN same IS NULL THEN [null] ELSE same END) AS ci
    WITH population, ci, size(same) - 1 AS others ORDER BY toLower(ci.name), ci.id
    WITH population, collect(CASE WHEN ci IS NOT NULL THEN {ci: ci, others: others} END) AS hits
    RETURN population, size(hits) AS total,
      [h IN hits[$offset..($offset + $limit)] | {id: h.ci.id, name: h.ci.name, labels: labels(h.ci), environment: h.ci.environment, status: h.ci.status,
        sameName: h.others}] AS items`,

  required_field_empty: `
    MATCH (ci:ConfigurationItem {tenant_id: $tenantId})
    WHERE NOT coalesce(ci.status, '') IN $retired
      AND ($type IS NULL OR $type IN labels(ci)) AND ($environment IS NULL OR ci.environment = $environment)
    WITH ci, [l IN labels(ci) WHERE l IN keys($requiredByLabel)][0] AS lbl
    WHERE lbl IS NOT NULL
    WITH ci, lbl, [f IN $requiredByLabel[lbl] WHERE ci[f] IS NULL OR trim(toString(ci[f])) = ''] AS missing
    ORDER BY toLower(ci.name), ci.id
    WITH count(ci) AS population, collect(CASE WHEN size(missing) > 0 THEN {ci: ci, missing: missing} END) AS hits
    RETURN population, size(hits) AS total,
      [h IN hits[$offset..($offset + $limit)] | {id: h.ci.id, name: h.ci.name, labels: labels(h.ci), environment: h.ci.environment, status: h.ci.status,
        missing: h.missing}] AS items`,
}

export function assertHealthCheck(check: unknown): CmdbHealthCheckKey {
  if (typeof check === 'string' && (CMDB_HEALTH_CHECKS as readonly string[]).includes(check)) return check as CmdbHealthCheckKey
  throw new ValidationError(`Unknown CMDB health check "${String(check)}"`, { key: 'errors.cmdbHealth.unknownCheck', params: { check: String(check) } })
}

export interface HealthItem {
  id: string
  name: string
  type: string
  environment: string | null
  status: string | null
  expiresAt: string | null
  inUseBy: number | null
  sameName: number | null
  missingFields: string[]
  /** chain_incomplete: the required links the CI lacks. */
  missingLinks: MissingLink[]
  /** relation_not_admitted: the relation, and the CI at its other end. */
  relation: string | null
  relatedId: string | null
  relatedName: string | null
  relatedType: string | null
}

export interface HealthPage { population: number; total: number; items: HealthItem[] }

interface Row { population: unknown; total: unknown; items: Array<Record<string, unknown>> }

/** The CI type of a row: its label that is a type of the metamodel. */
function typeOf(labels: readonly string[], ctx: HealthContext): CITypeWithDefinitions | undefined {
  for (const l of labels) {
    const t = ctx.typeByLabel.get(l)
    if (t) return t
  }
  return undefined
}

function mapItem(raw: Record<string, unknown>, ctx: HealthContext, missingLinks: MissingLink[] = []): HealthItem {
  const type = typeOf((raw['labels'] as string[] | undefined) ?? [], ctx)
  // The missing properties back to the fields people read: their label, in the type's order.
  const missing = (raw['missing'] as string[] | undefined) ?? []
  const missingFields = type ? type.fields.filter((f) => missing.includes(toSnakeCase(f.name))).map((f) => f.label || f.name) : missing
  const related = raw['relatedLabels'] ? typeOf(raw['relatedLabels'] as string[], ctx) : undefined
  return {
    id: String(raw['id']),
    name: String(raw['name'] ?? ''),
    type: type?.name ?? '',
    environment: (raw['environment'] as string | null | undefined) ?? null,
    status: (raw['status'] as string | null | undefined) ?? null,
    expiresAt: (raw['expiresAt'] as string | null | undefined) ?? null,
    inUseBy: raw['inUseBy'] == null ? null : toNumber(raw['inUseBy']),
    sameName: raw['sameName'] == null ? null : toNumber(raw['sameName']),
    missingFields,
    missingLinks,
    relation: (raw['relation'] as string | null | undefined) ?? null,
    relatedId: (raw['relatedId'] as string | null | undefined) ?? null,
    relatedName: (raw['relatedName'] as string | null | undefined) ?? null,
    relatedType: related?.name ?? null,
  }
}

export interface HealthFilter { type?: string | null; environment?: string | null; limit?: number | null; offset?: number | null }

/** The label of a type name, or a refusal: an unknown type is not «no results». */
function labelOfType(type: string | null | undefined, ctx: HealthContext): string | null {
  if (!type) return null
  for (const t of ctx.typeByLabel.values()) if (t.name === type) return t.neo4jLabel
  throw new ValidationError(`Unknown CI type "${type}"`, { key: 'errors.cmdbHealth.unknownType', params: { type } })
}

/** The CIs in service of the drawn types — the ones a chain should reach — flagged infrastructure aside. */
const DRAWN_IN_SERVICE = `
  MATCH (ci:ConfigurationItem {tenant_id: $tenantId})
  WHERE NOT coalesce(ci.status, '') IN $retired AND any(l IN labels(ci) WHERE l IN $labels)
    AND coalesce(ci.is_infrastructure, false) = false
    AND ($type IS NULL OR $type IN labels(ci)) AND ($environment IS NULL OR ci.environment = $environment)
  RETURN ci.id AS id, ci.name AS name, labels(ci) AS labels, ci.environment AS environment, ci.status AS status
  ORDER BY toLower(ci.name), ci.id`

/** The CIs given by id, as a row of the list shows them. */
const BY_ID = `
  UNWIND $ids AS cid
  MATCH (ci:ConfigurationItem {tenant_id: $tenantId, id: cid})
  WHERE ($type IS NULL OR $type IN labels(ci)) AND ($environment IS NULL OR ci.environment = $environment)
  RETURN ci.id AS id, ci.name AS name, labels(ci) AS labels, ci.environment AS environment, ci.status AS status
  ORDER BY toLower(ci.name), ci.id`

/** The two checks the walk of the chains answers: the population, the hits in name order, the page asked for. */
async function runWalkedCheck(session: Session, ctx: HealthContext, check: WalkedCheck, type: string | null, environment: string | null, offset: number, limit: number): Promise<HealthPage> {
  const walk = await walkOf(session, ctx)
  const rows = check === 'chain_orphan'
    ? await runQuery<Record<string, unknown>>(session, DRAWN_IN_SERVICE, { tenantId: ctx.tenantId, retired: ctx.retired, labels: walk.drawnLabels, type, environment })
    : await runQuery<Record<string, unknown>>(session, BY_ID, { tenantId: ctx.tenantId, ids: [...walk.checkedForLinks], type, environment })
  const hits = check === 'chain_orphan'
    ? rows.filter((r) => !walk.reached.has(String(r['id'])))
    : rows.filter((r) => walk.incomplete.has(String(r['id'])))
  return {
    population: rows.length,
    total: hits.length,
    items: hits.slice(offset, offset + limit).map((r) => mapItem(r, ctx, walk.incomplete.get(String(r['id'])) ?? [])),
  }
}

export async function runHealthCheck(session: Session, ctx: HealthContext, check: CmdbHealthCheckKey, filter: HealthFilter = {}): Promise<HealthPage> {
  const limit = Math.min(Math.max(filter.limit ?? 50, 0), 10_000)
  const offset = Math.max(filter.offset ?? 0, 0)
  const type = labelOfType(filter.type, ctx)
  const environment = filter.environment || null
  if (isWalked(check)) return runWalkedCheck(session, ctx, check, type, environment, offset, limit)
  const rows = await runQuery<Row>(session, CHECK_QUERIES[check], {
    tenantId: ctx.tenantId, retired: ctx.retired, type, environment,
    applicationLabels: ctx.applicationLabels, certificateLabels: ctx.certificateLabels,
    ownerGroupLabels: ctx.ownerGroupLabels, supportGroupLabels: ctx.supportGroupLabels,
    expiryByLabel: ctx.expiryByLabel, requiredByLabel: ctx.requiredByLabel,
    typeLabels: ctx.typeLabels, admitted: ctx.admitted, drawnLabels: ctx.drawnLabels,
    now: new Date().toISOString(),
    offset, limit,
  })
  const row = rows[0]
  if (!row) throw new Error(`CMDB health check "${check}" returned no row for tenant ${ctx.tenantId}`)
  return { population: toNumber(row.population), total: toNumber(row.total), items: row.items.map((r) => mapItem(r, ctx)) }
}

export interface HealthSummary {
  checks: Array<{ key: CmdbHealthCheckKey; count: number; population: number; notCheckedTypes: string[]; needsChains: boolean }>
  retiredStatuses: string[]
  /** How many CMDB chains are drawn: none, and the chain checks say to draw one. */
  chainCount: number
  chainCoverage: ChainCoverage[]
}

/** Every check, counted: the cards of the page, and the coverage of each chain. */
export async function cmdbHealthSummary(tenantId: string): Promise<HealthSummary> {
  const session = getSession(undefined, 'READ')
  try {
    const ctx = await healthContext(tenantId, session)
    const checks: HealthSummary['checks'] = []
    for (const key of CMDB_HEALTH_CHECKS) {
      const page = await runHealthCheck(session, ctx, key, { limit: 0 })
      checks.push({
        key, count: page.total, population: page.population,
        notCheckedTypes: key === 'certificate_expired_in_use' ? ctx.certificateTypesWithoutExpiry : [],
        needsChains: CHAIN_CHECKS.has(key) && !ctx.chains.length,
      })
    }
    const walk = await walkOf(session, ctx)
    return { checks, retiredStatuses: ctx.retired, chainCount: ctx.chains.length, chainCoverage: walk.coverage }
  } finally {
    await session.close()
  }
}

/** The CIs one check finds, a page at a time. */
export async function cmdbHealthItems(tenantId: string, check: unknown, filter: HealthFilter): Promise<HealthPage> {
  const key = assertHealthCheck(check)
  const session = getSession(undefined, 'READ')
  try {
    const ctx = await healthContext(tenantId, session)
    return await runHealthCheck(session, ctx, key, filter)
  } finally {
    await session.close()
  }
}
