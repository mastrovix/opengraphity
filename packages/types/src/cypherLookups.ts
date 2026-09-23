/**
 * INDEXED LOOKUPS BY ID (browser tour of 23 Sep 2026, D25).
 *
 * A node pattern without a label — `MATCH (x {id: $id, tenant_id: $tenantId})`
 * or `MATCH (x) WHERE x.id = $id` — cannot use an index: Neo4j reads every
 * node of the database. On the demo tenant (4.85 M nodes) that cost 2.6 s per
 * call: the change calendar ran one per release window and hit the 60 s
 * gateway timeout, every assessment answer took 3 s, a CI detail 4 s.
 *
 * A dynamic label (`MATCH (x:$(label))`) does not help on Neo4j 5.26: it is
 * still planned as a scan of all nodes. What does use the indexes is one
 * lookup per label, joined with UNION inside a subquery: every branch is an
 * index seek on the label's `id`.
 *
 * CIs need none of this: every CI carries `:ConfigurationItem` (index
 * `ci_id_unique`), so a CI lookup names that label directly. This helper is
 * for the places that receive an id without knowing the ticket type.
 *
 * It lives here, in the package without dependencies, because the engines
 * need it too: the SLA engine and the notification recipients looked tickets
 * up without a label on every event.
 *
 * The guardian `apps/api/src/lib/__tests__/cypherIndexedLookups.test.ts`
 * rejects the unlabelled forms in the API and in every package.
 */
import { ENTITY_NEO4J_LABELS, TICKET_ENTITY_TYPES } from './entityLabels.js'

/** Node labels: identifiers only (Incident, ConfigurationItem, AssessmentTask). */
const LABEL_RE = /^[A-Z][A-Za-z0-9_]*$/

/** The Neo4j labels of the four ticket types (the KB article is not a ticket). */
export const TICKET_NODE_LABELS: readonly string[] = TICKET_ENTITY_TYPES.map((t) => {
  const label = ENTITY_NEO4J_LABELS[t]
  if (!label) throw new Error(`No Neo4j label for ticket type "${t}"`)
  return label
})

/** Every entity the product moves through a workflow: the tickets and the KB article. */
export const WORKFLOW_ENTITY_NODE_LABELS: readonly string[] = Object.values(ENTITY_NEO4J_LABELS)

const VARIABLE_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/** A named label set, so that callers pass literals the Cypher guardian can evaluate. */
export type LabelSet = 'tickets' | 'entities'

export interface MatchByIdOptions {
  /**
   * Labels to look in: an explicit list, `'tickets'` (the four ticket labels,
   * the default) or `'entities'` (tickets and KB articles, i.e. everything
   * that has a workflow).
   */
  labels?: readonly string[] | LabelSet
  /**
   * Cypher expression of the id: a parameter (`$entityId`) or a property of
   * an imported variable (`wi.entity_id`). Written by the code, never by a
   * user: it is interpolated.
   */
  id?: string
  /**
   * Cypher expression of the tenant. Default `$tenantId`. `null` leaves the
   * tenant out, for callers that only hold globally unique ids (task ids
   * collected from a tenant-scoped query).
   */
  tenant?: string | null
  /** Outer variables the expressions read: they become the subquery's scope. */
  imports?: readonly string[]
  /** `OPTIONAL CALL`: the outer row survives when nothing matches, like `OPTIONAL MATCH`. */
  optional?: boolean
}

/**
 * A `CALL` subquery that binds `variable` to the node with the given id and
 * tenant among `labels`, one index seek per label.
 *
 *   matchById('e', { id: '$entityId' })
 *   → CALL () { MATCH (e:Incident {id: $entityId, tenant_id: $tenantId}) RETURN e UNION … }
 */
export function matchById(variable: string, opts: MatchByIdOptions = {}): string {
  const labels = resolveLabels(opts.labels ?? 'tickets')
  const imports = opts.imports ?? []
  if (!VARIABLE_RE.test(variable)) throw new Error(`matchById: invalid variable name "${variable}"`)
  if (labels.length === 0) throw new Error('matchById: at least one label is required')
  for (const label of labels) {
    if (!LABEL_RE.test(label)) throw new Error(`matchById: invalid label "${label}"`)
  }
  for (const name of imports) {
    if (!VARIABLE_RE.test(name)) throw new Error(`matchById: invalid imported variable "${name}"`)
  }
  const id = opts.id ?? '$id'
  const tenant = opts.tenant === undefined ? '$tenantId' : opts.tenant
  const properties = tenant === null ? `{id: ${id}}` : `{id: ${id}, tenant_id: ${tenant}}`
  const branches = labels.map((label) =>
    `MATCH (${variable}:${label} ${properties}) RETURN ${variable}`)
  return `${opts.optional ? 'OPTIONAL ' : ''}CALL (${imports.join(', ')}) { ${branches.join(' UNION ')} }`
}

function resolveLabels(labels: readonly string[] | LabelSet): readonly string[] {
  if (labels === 'tickets') return TICKET_NODE_LABELS
  if (labels === 'entities') return WORKFLOW_ENTITY_NODE_LABELS
  return labels
}
