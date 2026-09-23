/**
 * HOW THE DEMO TENANT REACHES NEO4J: IN BATCHES, AND MARKED (23 Sep 2026).
 *
 * Two million nodes cannot go one mutation at a time, so the generator writes
 * the nodes the app would have written with `UNWIND` batches: the same
 * labels, the same properties, the same relationships. Two things are its
 * own and nothing else:
 *
 *  - the MARK: every node carries `demo_run_id`, the id of the generation
 *    run, so a single command removes a demo tenant's data without touching
 *    what the tenant was born with or what people added afterwards. No label
 *    is added: a CI has exactly `:ConfigurationItem:<Type>`, because the app
 *    reads the type from the second label.
 *  - NUMBERS as the app sends them: a JavaScript number reaches Neo4j as a
 *    FLOAT, and that is what the app stores for durations, scores, minutes
 *    and weights (checked on live data). Only where the app itself writes
 *    `toInteger(...)` — the zero-length history rows, the dashboard widgets —
 *    the generator sends an integer, with `int()`.
 */
import neo4j from 'neo4j-driver'
import type { Session } from 'neo4j-driver'

/**
 * The mark every generated node carries. The queries that read it write it
 * as a literal (`n.demo_run_id`): `check-cypher` verifies a query only when it
 * can read it whole, and a property name built by interpolation makes it
 * unreadable. The two must stay the same word — a test pins this constant.
 */
export const DEMO_RUN_PROPERTY = 'demo_run_id'

/** Labels and relationship types go into the query text: only plain identifiers. */
const IDENTIFIER = /^[A-Z][A-Za-z0-9_]*$/
function assertIdentifier(name: string): string {
  if (!IDENTIFIER.test(name)) throw new Error(`writer: "${name}" is not a plain identifier`)
  return name
}

/** A value the app writes with `toInteger(...)`: sent as a Neo4j integer. */
export function int(n: number): ReturnType<typeof neo4j.int> {
  if (!Number.isInteger(n)) throw new Error(`writer.int: ${String(n)} is not a whole number`)
  return neo4j.int(n)
}

/** Drops `undefined` (null is kept: Neo4j does not store it either way), recursively. */
export function toNeo4jValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(toNeo4jValue)
  if (v && typeof v === 'object' && !(v instanceof Date) && !neo4j.isInt(v)) {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = toNeo4jValue(x)
    return out
  }
  return v
}

/**
 * THE LABELS THE GENERATOR FINDS AGAIN BY ID, AND WHY THEY NEED AN INDEX.
 *
 * The app creates a workflow history row, an audit entry or an assessment
 * response INSIDE the statement that hangs it off its ticket, so it never
 * looks one up by id and the shipped schema has no index for it. The
 * generator does look them up: it writes a million rows in batches and then
 * attaches the edges ("this audit entry is BY that person"). Without an index
 * every batch is a label scan over everything written so far, which is
 * quadratic — seen live on `ChangeAuditEntry`, where one batch took 28
 * seconds and the run slowed to a crawl at 1.000 changes out of 15.000.
 *
 * So the generator asks for the indexes it needs before writing. They are
 * cheap, they are created only if missing, and they are left behind: an index
 * on `id` is useful to anything that ever reads one of these by id.
 */
export const LOOKUP_BY_ID_LABELS: readonly string[] = [
  'AnswerOption', 'AssessmentQuestion', 'AssessmentResponse', 'AssessmentTask', 'Change', 'ChangeApproval',
  'ChangeAuditEntry', 'ChangeTask', 'Comment', 'ConfigurationItem', 'DeployPlan', 'DeployPlanTask', 'FormTableRow',
  'Incident', 'Problem', 'ReviewTask', 'SLAStatus', 'ServiceRequest', 'Team', 'TicketTeamSegment', 'User',
  'ValidationTest', 'WorkflowInstance', 'WorkflowStep', 'WorkflowStepExecution',
]

/** Creates the missing `(:Label {id})` indexes. Idempotent, and quick when they are all there. */
export async function ensureIdIndexes(session: Session, labels: readonly string[] = LOOKUP_BY_ID_LABELS): Promise<number> {
  const existing = new Set((await session.executeRead((tx) => tx.run(
    `SHOW INDEXES YIELD labelsOrTypes, properties WHERE properties = ['id'] RETURN labelsOrTypes AS l`,
  ))).records.flatMap((r) => (r.get('l') as string[] | null) ?? []))
  let created = 0
  for (const label of labels) {
    if (existing.has(label)) continue
    const l = assertIdentifier(label)
    // No name: Neo4j names it. A name built by interpolation would put the
    // whole statement outside what `check-cypher` can verify.
    await session.executeWrite((tx) => tx.run(`CREATE INDEX IF NOT EXISTS FOR (n:${l}) ON (n.id)`))
    created++
  }
  return created
}

export interface WriteStats {
  nodes: number
  relationships: number
}

export class DemoWriter {
  readonly stats: WriteStats = { nodes: 0, relationships: 0 }

  constructor(
    private readonly session: Session,
    readonly tenantId: string,
    readonly runId: string,
    private readonly batchSize = 2000,
    private readonly onProgress: (what: string, done: number, total: number) => void = () => undefined,
  ) {}

  private async inBatches<T>(what: string, rows: readonly T[], write: (batch: T[]) => Promise<void>): Promise<void> {
    for (let i = 0; i < rows.length; i += this.batchSize) {
      await write(rows.slice(i, i + this.batchSize))
      this.onProgress(what, Math.min(i + this.batchSize, rows.length), rows.length)
    }
  }

  /** CREATE one node per row, with the tenant and the run mark added. */
  async nodes(labels: readonly string[], rows: ReadonlyArray<Record<string, unknown>>): Promise<void> {
    const labelText = labels.map(assertIdentifier).join(':')
    await this.inBatches(labelText, rows, async (batch) => {
      const props = batch.map((r) => toNeo4jValue({ ...r, tenant_id: this.tenantId, [DEMO_RUN_PROPERTY]: this.runId }))
      await this.session.executeWrite((tx) => tx.run(`UNWIND $rows AS row CREATE (n:${labelText}) SET n = row`, { rows: props }))
      this.stats.nodes += batch.length
    })
  }

  /**
   * CREATE one relationship per row between two nodes found by id (and
   * tenant). `props` may be empty: most of the app's edges carry none.
   */
  async relationships(
    fromLabel: string, type: string, toLabel: string,
    rows: ReadonlyArray<{ from: string; to: string; props?: Record<string, unknown> }>,
  ): Promise<void> {
    const f = assertIdentifier(fromLabel), t = assertIdentifier(type), l = assertIdentifier(toLabel)
    await this.inBatches(`${f}-${t}->${l}`, rows, async (batch) => {
      const data = batch.map((r) => ({ from: r.from, to: r.to, props: toNeo4jValue(r.props ?? {}) }))
      const result = await this.session.executeWrite((tx) => tx.run(`
        UNWIND $rows AS row
        MATCH (a:${f} {id: row.from, tenant_id: $tenantId})
        MATCH (b:${l} {id: row.to, tenant_id: $tenantId})
        CREATE (a)-[r:${t}]->(b)
        SET r = row.props
        RETURN count(r) AS n
      `, { rows: data, tenantId: this.tenantId }))
      const n = Number(result.records[0]?.get('n') ?? 0)
      // Every edge must land: a missing end means the plan and the graph disagree.
      if (n !== batch.length) throw new Error(`writer: ${String(batch.length - n)} of ${String(batch.length)} ${f}-${t}->${l} edges found no end`)
      this.stats.relationships += batch.length
    })
  }

  /**
   * CREATE nodes hanging off an existing node in one statement, like the
   * workflow history under its instance: (parent)-[:TYPE]->(child).
   */
  async children(
    parentLabel: string, type: string, childLabels: readonly string[],
    rows: ReadonlyArray<{ parent: string; props: Record<string, unknown>; relProps?: Record<string, unknown> }>,
  ): Promise<void> {
    const p = assertIdentifier(parentLabel), t = assertIdentifier(type), c = childLabels.map(assertIdentifier).join(':')
    await this.inBatches(`${p}-${t}->${c}`, rows, async (batch) => {
      const data = batch.map((r) => ({
        parent: r.parent,
        props: toNeo4jValue({ ...r.props, tenant_id: this.tenantId, [DEMO_RUN_PROPERTY]: this.runId }),
        relProps: toNeo4jValue(r.relProps ?? {}),
      }))
      const result = await this.session.executeWrite((tx) => tx.run(`
        UNWIND $rows AS row
        MATCH (p:${p} {id: row.parent, tenant_id: $tenantId})
        CREATE (p)-[r:${t}]->(n:${c})
        SET n = row.props, r = row.relProps
        RETURN count(n) AS n
      `, { rows: data, tenantId: this.tenantId }))
      const n = Number(result.records[0]?.get('n') ?? 0)
      if (n !== batch.length) throw new Error(`writer: ${String(batch.length - n)} of ${String(batch.length)} ${c} under ${p} found no parent`)
      this.stats.nodes += batch.length
      this.stats.relationships += batch.length
    })
  }

  /**
   * (ci type)-[:HAS_QUESTION {weight, sort_order}]->(question), as a "core"
   * question gets it: the types are shared (`tenant_id: 'system'`) or the
   * tenant's own, so they are matched by id only.
   */
  async questionLinks(rows: ReadonlyArray<{ questionId: string; weight: number; sortOrder: number }>, ciTypeIds: readonly string[]): Promise<void> {
    const result = await this.session.executeWrite((tx) => tx.run(`
      UNWIND $rows AS row
      MATCH (q:AssessmentQuestion {id: row.questionId, tenant_id: $tenantId})
      UNWIND $ciTypeIds AS ctId
      // The same check the app's own mutation makes (questionAdmin.ts): the CI
      // type must be this tenant's or one shipped with the product.
      MATCH (ct:CITypeDefinition {id: ctId})
      WHERE ct.scope = 'base' OR ct.tenant_id IN [$tenantId, 'system']
      MERGE (ct)-[rel:HAS_QUESTION]->(q)
        ON CREATE SET rel.weight = row.weight, rel.sort_order = row.sortOrder
      RETURN count(rel) AS n
    `, { rows: rows.map((r) => toNeo4jValue(r)), ciTypeIds, tenantId: this.tenantId }))
    const n = Number(result.records[0]?.get('n') ?? 0)
    if (n !== rows.length * ciTypeIds.length) throw new Error(`writer: ${String(n)} question links written, ${String(rows.length * ciTypeIds.length)} expected`)
    this.stats.relationships += n
  }
}
