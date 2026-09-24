/**
 * Backup of the whole OpenGraphity state into one tar.gz (D-08, Ondata 4).
 *
 * Contract:
 *   - CONSISTENT graph export: nodes and relationships are streamed from ONE
 *     read transaction (no SKIP/LIMIT across sessions — that skipped or
 *     duplicated rows under concurrent writes). Identity via elementId().
 *   - the archive also carries manifest.json (counts per label/type, schema
 *     from SHOW CONSTRAINTS/INDEXES, app + Neo4j versions), the attachment
 *     directory (attachments.tar) and the Keycloak partial-export of every
 *     tenant realm (keycloak/<realm>.json);
 *   - Keycloak unreachable / auth failing = ERROR. `--skip-keycloak` skips it
 *     knowingly (the manifest records it). Same for `--skip-attachments`.
 *   - fail-loud publication: the archive is written as `.tar.gz.partial` and
 *     renamed to `.tar.gz` ONLY after the rows written match the counts read
 *     in the same transaction; a `.partial` is never a valid backup.
 *
 *   - ONE TENANT (review of 23 Sep 2026): `--tenant <slug>` exports that
 *     tenant's nodes, the relationships among them and those to the shipped
 *     `system` nodes (which ride along as endpoint nodes), its attachment
 *     directory and its realm, as `tenant_<slug>_<stamp>.tar.gz` — a name the
 *     nightly rotation never touches. Restored with `restore:neo4j --tenant`.
 *   - no dangling relationship: a relationship whose endpoint the node stream
 *     did not carry (committed while the backup ran) writes that endpoint too,
 *     so the restore never ends «INCOMPLETE» on a live backup.
 *
 * Usage: pnpm --filter @opengraphity/api backup:neo4j -- [--output-dir ./backups] [--tenant <slug>] [--skip-keycloak] [--skip-attachments]
 * Env:   NEO4J_*, ATTACHMENT_DIR, and (unless --skip-keycloak) KEYCLOAK_URL, KEYCLOAK_ADMIN_USER, KEYCLOAK_ADMIN_PASSWORD
 */
import { parseArgs, promisify }            from 'node:util'
import { createWriteStream }               from 'node:fs'
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { execFile }                        from 'node:child_process'
import { basename, join, resolve, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath }    from 'node:url'
import { readFileSync }                    from 'node:fs'
import type { WriteStream }                from 'node:fs'
import type { Result, Session }            from 'neo4j-driver'
import neo4j                               from 'neo4j-driver'
import pino                                from 'pino'
import { getDriver, MAINTENANCE_TX_CONFIG, toNative } from '@opengraphity/neo4j'
import { createKeycloakAdmin, keycloakConfigFromEnv, type KeycloakAdminConfig } from './lib/keycloakAdmin.js'
import {
  MANIFEST_FILE, NODES_FILE, RELS_FILE, ATTACHMENTS_TAR, KEYCLOAK_DIR, MANIFEST_FORMAT,
  ElementIdSet, type BackupManifest,
} from './lib/backupManifest.js'
import { runScript } from './lib/runScript.js'
import { config }    from '../lib/config.js'

const execFileAsync = promisify(execFile)

export interface BackupLogger {
  info(obj: object, msg: string): void
  warn(obj: object, msg: string): void
}

export interface BackupOptions {
  outputDir: string
  /** Directory copied into attachments.tar. Missing directory → recorded in the manifest, not an error. */
  attachmentDir?: string
  skipAttachments?: boolean
  skipKeycloak?: boolean
  /** Required unless skipKeycloak (the CLI reads it from env). */
  keycloak?: KeycloakAdminConfig
  /** Version written in the manifest (default: apps/api/package.json). */
  appVersion?: string
  /** One tenant instead of the whole installation. */
  tenant?: string
  log?: BackupLogger
}

export interface BackupResult {
  archivePath: string
  nodeCount:   number
  relCount:    number
  durationMs:  number
  manifest:    BackupManifest
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function readAppVersion(): string {
  const pkgPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: unknown }
  if (typeof pkg.version !== 'string') throw new Error(`${pkgPath}: no "version"`)
  return pkg.version
}

/** Writes with back-pressure (a 10k-row burst must not buffer the whole export in memory). */
async function writeLine(stream: WriteStream, line: string): Promise<void> {
  if (!stream.write(line + '\n')) {
    await new Promise<void>((res, rej) => {
      const onErr = (e: Error) => { stream.off('drain', onDrain); rej(e) }
      const onDrain = () => { stream.off('error', onErr); res() }
      stream.once('drain', onDrain)
      stream.once('error', onErr)
    })
  }
}

function endStream(stream: WriteStream): Promise<void> {
  return new Promise((res, rej) => { stream.end((err: Error | null | undefined) => err ? rej(err) : res()) })
}

function tally(map: Record<string, number>, keys: string[]): void {
  for (const k of keys) map[k] = (map[k] ?? 0) + 1
}

function stampNow(): string {
  return new Date().toISOString().replace(/[:.]/g, '').replace('T', '_').slice(0, 15)
}

async function dirExists(p: string): Promise<boolean> {
  try { return (await stat(p)).isDirectory() } catch { return false }
}

async function dirStats(dir: string): Promise<{ files: number; bytes: number }> {
  let files = 0, bytes = 0
  const walk = async (d: string): Promise<void> => {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      const p = join(d, entry.name)
      if (entry.isDirectory()) await walk(p)
      else if (entry.isFile()) { files++; bytes += (await stat(p)).size }
    }
  }
  await walk(dir)
  return { files, bytes }
}

// ── Graph export (single read transaction) ───────────────────────────────────

interface GraphExport {
  /** Nodes from the node stream; `endpointNodes` came from relationships (see ElementIdSet). */
  nodeCount: number; relCount: number; endpointNodes: number
  /** Counted before the streams and again after them, in the same transaction. */
  dbNodeCount: number; dbRelCount: number
  dbNodeCountAfter: number; dbRelCountAfter: number
  nodesByLabel: Record<string, number>; relsByType: Record<string, number>
}

/**
 * Whether what was written is the whole graph (tour of 23 Sep 2026, D60;
 * 24 Sep 2026).
 *
 * The check compared the lines written with a count taken at the start of the
 * same transaction, assuming a transaction sees a frozen graph. Neo4j gives
 * «read committed»: a write committed by someone else while the streams run
 * is visible to them. On a live installation — logs, audit, monitoring —
 * one node more was enough to refuse the nightly backup (18 Sep: 291,049
 * written, 291,048 counted).
 *
 * «Between the count before and the count after», the rule that followed,
 * does not hold either. A relationship deleted during the export before the
 * stream reached it, and another created after the stream passed its place,
 * leave the archive one short of BOTH counts, with nothing lost — the missing
 * one was deleted. That refused the nightly backup of 24 Sep 2026, the first
 * one with the demo tenant: 4,978,496 relationships written, 4,978,497
 * counted before and 4,978,499 after. The lines written can fall outside the
 * range by as many replacements (a deletion and a creation while the stream
 * runs) as there were, and read committed offers no way to count them.
 *
 * So the range gets a tolerance, LIVE_CHANGE_TOLERANCE: what the check still
 * refuses is a stream that lost a real part of the graph. A difference within
 * the tolerance is not silent: runBackup logs it and the manifest records
 * the three numbers (`graph_counts`).
 */
export const LIVE_CHANGE_TOLERANCE = { ratio: 0.001, min: 100 } as const

type GraphCounts = Pick<GraphExport, 'nodeCount' | 'relCount' | 'dbNodeCount' | 'dbRelCount' | 'dbNodeCountAfter' | 'dbRelCountAfter'>

/** How far `written` lies outside the two counts; 0 inside. */
function outsideCounts(written: number, before: number, after: number): number {
  const lo = Math.min(before, after)
  const hi = Math.max(before, after)
  return written < lo ? lo - written : written > hi ? written - hi : 0
}

/** The difference a live graph explains for a count this size. */
export function liveChangeTolerance(before: number, after: number): number {
  return Math.max(LIVE_CHANGE_TOLERANCE.min, Math.ceil(LIVE_CHANGE_TOLERANCE.ratio * Math.max(before, after)))
}

/** How far the nodes and the relationships written lie outside their two counts. */
export function graphCountDrift(g: GraphCounts): { nodes: number; rels: number } {
  return {
    nodes: outsideCounts(g.nodeCount, g.dbNodeCount, g.dbNodeCountAfter),
    rels:  outsideCounts(g.relCount, g.dbRelCount, g.dbRelCountAfter),
  }
}

export function graphCountProblems(g: GraphCounts): string[] {
  const problems: string[] = []
  const check = (what: string, written: number, before: number, after: number) => {
    const allowed = liveChangeTolerance(before, after)
    if (outsideCounts(written, before, after) > allowed) {
      const lo = Math.min(before, after)
      const hi = Math.max(before, after)
      problems.push(`${what}: ${String(written)} written, ${before === after ? String(before) : `between ${String(lo)} and ${String(hi)}`} counted in the same transaction (a live graph explains up to ${String(allowed)})`)
    }
  }
  check('nodes', g.nodeCount, g.dbNodeCount, g.dbNodeCountAfter)
  check('relationships', g.relCount, g.dbRelCount, g.dbRelCountAfter)
  return problems
}

const NODES_CYPHER = 'MATCH (n) RETURN elementId(n) AS id, labels(n) AS labels, properties(n) AS props'
const RELS_CYPHER  = `
  MATCH (a)-[r]->(b)
  RETURN elementId(a) AS startId, labels(a) AS startLabels, properties(a) AS startProps,
         type(r) AS relType, properties(r) AS relProps,
         elementId(b) AS endId, labels(b) AS endLabels, properties(b) AS endProps`
const COUNT_CYPHER = 'MATCH (n) WITH count(n) AS nodes MATCH ()-[r]->() RETURN nodes, count(r) AS rels'

/**
 * The same three statements for ONE tenant: its nodes (and its Tenant node,
 * which has no tenant_id), the relationships with at least one end in the
 * tenant and the other in the tenant or among the shipped `system` nodes.
 * A relationship to another tenant's node is not exported: it would carry
 * that tenant's data into this one's archive.
 */
// Written out in full (no composing): scripts/check-cypher.mjs verifies the
// tenant filter only on literals. In words: a node is the tenant's when its
// tenant_id is the tenant or it is the tenant's own Tenant node; a
// relationship is exported when one end is the tenant's and the other is the
// tenant's or a shipped `system` node.
const TENANT_CYPHER = {
  nodes: `MATCH (n) WHERE n.tenant_id = $tenant OR (n:Tenant AND n.id = $tenant)
  RETURN elementId(n) AS id, labels(n) AS labels, properties(n) AS props`,
  rels: `MATCH (a)-[r]->(b)
  WHERE (a.tenant_id = $tenant OR (a:Tenant AND a.id = $tenant) OR b.tenant_id = $tenant OR (b:Tenant AND b.id = $tenant))
    AND (a.tenant_id = $tenant OR (a:Tenant AND a.id = $tenant) OR a.tenant_id = 'system')
    AND (b.tenant_id = $tenant OR (b:Tenant AND b.id = $tenant) OR b.tenant_id = 'system')
  RETURN elementId(a) AS startId, labels(a) AS startLabels, properties(a) AS startProps,
         type(r) AS relType, properties(r) AS relProps,
         elementId(b) AS endId, labels(b) AS endLabels, properties(b) AS endProps`,
  count: `MATCH (n) WHERE n.tenant_id = $tenant OR (n:Tenant AND n.id = $tenant)
  WITH count(n) AS nodes
  MATCH (a)-[r]->(b)
  WHERE (a.tenant_id = $tenant OR (a:Tenant AND a.id = $tenant) OR b.tenant_id = $tenant OR (b:Tenant AND b.id = $tenant))
    AND (a.tenant_id = $tenant OR (a:Tenant AND a.id = $tenant) OR a.tenant_id = 'system')
    AND (b.tenant_id = $tenant OR (b:Tenant AND b.id = $tenant) OR b.tenant_id = 'system')
  RETURN nodes, count(r) AS rels`,
}

async function exportGraph(session: Session, stagingDir: string, log: BackupLogger, tenant: string | null): Promise<GraphExport> {
  const nodesStream = createWriteStream(join(stagingDir, NODES_FILE), { encoding: 'utf8' })
  const relsStream  = createWriteStream(join(stagingDir, RELS_FILE),  { encoding: 'utf8' })
  const out: GraphExport = { nodeCount: 0, relCount: 0, endpointNodes: 0, dbNodeCount: 0, dbRelCount: 0, dbNodeCountAfter: 0, dbRelCountAfter: 0, nodesByLabel: {}, relsByType: {} }
  const cypher = tenant ? TENANT_CYPHER : { nodes: NODES_CYPHER, rels: RELS_CYPHER, count: COUNT_CYPHER }
  const params = tenant ? { tenant } : {}
  // The nodes written so far, to write the endpoint of a relationship the node stream did not carry.
  const written = new ElementIdSet()
  const writeNode = async (id: string, labels: string[], props: unknown) => {
    await writeLine(nodesStream, JSON.stringify({ id, labels, props }))
    written.add(id)
    tally(out.nodesByLabel, labels)
  }

  // One explicit READ transaction for counts + both streams: every row comes
  // from the same transactional view, in whatever order the store yields it
  // (no pagination, so no ordering assumption at all). It reads the whole
  // graph — 98 s for 4.8 million nodes on 24 Sep 2026 — so it carries the
  // maintenance limit, not the server's 120 s (queryScope.ts in @opengraphity/neo4j).
  const tx = session.beginTransaction(MAINTENANCE_TX_CONFIG)
  const countGraph = async (): Promise<{ nodes: number; rels: number }> => {
    const counts = await tx.run(cypher.count, params)
    const c = counts.records[0]
    if (!c) throw new Error('count query returned no row')
    return { nodes: toNative(c.get('nodes')) as number, rels: toNative(c.get('rels')) as number }
  }
  try {
    const before = await countGraph()
    out.dbNodeCount = before.nodes
    out.dbRelCount  = before.rels
    log.info({ nodes: out.dbNodeCount, rels: out.dbRelCount, tenant }, 'Graph counts read')

    const nodesResult: Result = tx.run(cypher.nodes, params)
    for await (const r of nodesResult) {
      await writeNode(r.get('id') as string, r.get('labels') as string[], toNative(r.get('props')))
      out.nodeCount++
      if (out.nodeCount % 50_000 === 0) log.info({ nodes: out.nodeCount }, 'Nodes exported so far')
    }

    const relsResult: Result = tx.run(cypher.rels, params)
    for await (const r of relsResult) {
      const relType = r.get('relType') as string
      const row = {
        startId: r.get('startId') as string, startLabels: r.get('startLabels') as string[], startProps: toNative(r.get('startProps')),
        relType, relProps: toNative(r.get('relProps')),
        endId: r.get('endId') as string, endLabels: r.get('endLabels') as string[], endProps: toNative(r.get('endProps')),
      }
      // Read committed: a node committed after the node stream passed, or a
      // system node a tenant points to, is only here. Without it the restore
      // cannot rebuild the relationship (review of 23 Sep 2026).
      if (!written.has(row.startId)) { await writeNode(row.startId, row.startLabels, row.startProps); out.endpointNodes++ }
      if (!written.has(row.endId))   { await writeNode(row.endId, row.endLabels, row.endProps); out.endpointNodes++ }
      await writeLine(relsStream, JSON.stringify(row))
      out.relCount++
      tally(out.relsByType, [relType])
      if (out.relCount % 50_000 === 0) log.info({ rels: out.relCount }, 'Relationships exported so far')
    }
    if (out.endpointNodes > 0) log.info({ endpointNodes: out.endpointNodes, tenant }, 'Endpoint nodes written from relationships')
    const after = await countGraph()
    out.dbNodeCountAfter = after.nodes
    out.dbRelCountAfter  = after.rels
    if (after.nodes !== before.nodes || after.rels !== before.rels) {
      log.warn({ nodesBefore: before.nodes, nodesAfter: after.nodes, relsBefore: before.rels, relsAfter: after.rels },
        'The graph changed while the backup was running: the archive holds a state between the two counts')
    }
    await tx.commit()
  } catch (err) {
    await tx.rollback().catch(() => undefined)
    throw err
  } finally {
    await endStream(nodesStream)
    await endStream(relsStream)
  }
  return out
}

async function readSchema(session: Session): Promise<{ constraints: Record<string, unknown>[]; indexes: Record<string, unknown>[]; neo4jVersion: string | null }> {
  const rows = async (cypher: string) => (await session.run(cypher)).records.map((r) => toNative(r.toObject()) as Record<string, unknown>)
  const constraints = await rows('SHOW CONSTRAINTS')
  const indexes     = await rows('SHOW INDEXES')
  const components  = await rows('CALL dbms.components() YIELD name, versions RETURN name, versions')
  const kernel = components.find((c) => c['name'] === 'Neo4j Kernel')
  const versions = kernel?.['versions']
  const neo4jVersion = Array.isArray(versions) && typeof versions[0] === 'string' ? versions[0] : null
  return { constraints, indexes, neo4jVersion }
}

// ── Attachments ──────────────────────────────────────────────────────────────

async function exportAttachments(opts: BackupOptions, stagingDir: string, log: BackupLogger): Promise<BackupManifest['attachments']> {
  const none = { included: false, dir: opts.attachmentDir ?? null, file_count: 0, total_bytes: 0 }
  if (opts.skipAttachments) return { ...none, reason: 'skipped by option' }
  if (!opts.attachmentDir) return { ...none, reason: 'no attachment directory configured' }
  if (!(await dirExists(opts.attachmentDir))) {
    log.warn({ attachmentDir: opts.attachmentDir }, 'Attachment directory does not exist — not included')
    return { ...none, reason: 'directory not found' }
  }
  // A tenant's files live in ATTACHMENT_DIR/<tenant>; a tenant with none yet has no directory.
  const dir = opts.tenant ? join(opts.attachmentDir, opts.tenant) : opts.attachmentDir
  if (opts.tenant && !(await dirExists(dir))) return { ...none, dir, reason: 'the tenant has no attachment directory' }
  const { files, bytes } = await dirStats(dir)
  await execFileAsync('tar', ['-cf', join(stagingDir, ATTACHMENTS_TAR), '-C', dir, '.'])
  log.info({ files, bytes, dir }, 'Attachments archived')
  return { included: true, dir, file_count: files, total_bytes: bytes, reason: null }
}

// ── Keycloak realms ──────────────────────────────────────────────────────────

async function exportKeycloak(opts: BackupOptions, session: Session, stagingDir: string, log: BackupLogger): Promise<BackupManifest['keycloak']> {
  if (opts.skipKeycloak) return { included: false, realms: [], reason: 'skipped by option (--skip-keycloak)' }
  if (!opts.keycloak) throw new Error('Keycloak export requested but no Keycloak admin configuration given (pass --skip-keycloak to skip it knowingly)')

  const tenants = (await session.run('MATCH (t:Tenant) WHERE $tenant IS NULL OR t.id = $tenant RETURN t.id AS id ORDER BY t.id', { tenant: opts.tenant ?? null })).records
    .map((r) => r.get('id') as unknown)
  const realms: string[] = []
  for (const id of tenants) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) throw new Error(`Tenant with an invalid id for a realm name: ${JSON.stringify(id)}`)
    realms.push(id)
  }
  if (realms.length === 0) return { included: true, realms: [], reason: 'no Tenant nodes' }

  const kc = createKeycloakAdmin(opts.keycloak)
  const doFetch = opts.keycloak.fetch ?? fetch
  let token: string
  try {
    token = await kc.getAdminToken()
  } catch (err) {
    throw new Error(`Keycloak unreachable or admin auth failed at ${kc.baseUrl}: ${(err as Error).message} — fix it or rerun with --skip-keycloak`, { cause: err })
  }
  await mkdir(join(stagingDir, KEYCLOAK_DIR), { recursive: true })
  for (const realm of realms) {
    // partial-export is a POST in the Keycloak Admin API (the query flags select what to include)
    const res = await doFetch(`${kc.baseUrl}/admin/realms/${realm}/partial-export?exportClients=true&exportGroupsAndRoles=true`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) throw new Error(`Keycloak partial-export of realm "${realm}" → ${res.status}: ${await res.text().catch(() => '')}`)
    const body = await res.json() as { realm?: unknown }
    if (body.realm !== realm) throw new Error(`Keycloak partial-export of realm "${realm}" returned realm ${JSON.stringify(body.realm)}`)
    await writeFile(join(stagingDir, KEYCLOAK_DIR, `${realm}.json`), JSON.stringify(body, null, 2), 'utf8')
    log.info({ realm }, 'Keycloak realm exported')
  }
  return { included: true, realms, reason: null }
}

// ── Tenant ───────────────────────────────────────────────────────────────────

/** A slug ends up in file names and a realm URL: the same shape the realms use. */
export function assertTenantSlug(slug: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(slug)) throw new Error(`Invalid tenant slug ${JSON.stringify(slug)}`)
  return slug
}

async function assertTenantExists(session: Session, tenant: string): Promise<void> {
  const res = await session.run('MATCH (t:Tenant {id: $tenant}) RETURN count(t) AS n', { tenant })
  if (Number(toNative(res.records[0]?.get('n')) ?? 0) === 0) throw new Error(`Tenant "${tenant}" does not exist: nothing to export`)
}

// ── Main ─────────────────────────────────────────────────────────────────────

export async function runBackup(opts: BackupOptions): Promise<BackupResult> {
  const start = Date.now()
  const log: BackupLogger = opts.log ?? pino({ level: 'info' })
  const outputDir = resolve(opts.outputDir)
  await mkdir(outputDir, { recursive: true })

  const tenant     = opts.tenant ? assertTenantSlug(opts.tenant) : null
  const stamp      = stampNow()
  // The staging directory is `backup_…` either way (the restore looks for it);
  // a tenant archive is named so that the nightly rotation never counts it.
  const name       = tenant ? `backup_${stamp}_tenant_${tenant}` : `backup_${stamp}`
  const fileBase   = tenant ? `tenant_${tenant}_${stamp}` : name
  const stagingDir = join(outputDir, name)
  const partial    = join(outputDir, `${fileBase}.tar.gz.partial`)
  const archive    = join(outputDir, `${fileBase}.tar.gz`)
  await mkdir(stagingDir, { recursive: false })   // a second backup in the same second must not share the staging dir
  log.info({ stagingDir }, 'Starting backup')

  const session = getDriver().session({ defaultAccessMode: neo4j.session.READ })
  try {
    if (tenant) await assertTenantExists(session, tenant)
    const graph  = await exportGraph(session, stagingDir, log, tenant)
    const schema = await readSchema(session)
    const attachments = await exportAttachments(opts, stagingDir, log)
    const keycloak    = await exportKeycloak(opts, session, stagingDir, log)

    const manifest: BackupManifest = {
      format:         MANIFEST_FORMAT,
      created_at:     new Date().toISOString(),
      app_version:    opts.appVersion ?? readAppVersion(),
      neo4j_version:  schema.neo4jVersion,
      node_count:     graph.nodeCount + graph.endpointNodes,
      rel_count:      graph.relCount,
      nodes_by_label: graph.nodesByLabel,
      rels_by_type:   graph.relsByType,
      constraints:    schema.constraints,
      indexes:        schema.indexes,
      attachments,
      keycloak,
      scope:          { tenant },
      endpoint_nodes_added: graph.endpointNodes,
      graph_counts: {
        nodes: { written: graph.nodeCount, before: graph.dbNodeCount, after: graph.dbNodeCountAfter },
        rels:  { written: graph.relCount, before: graph.dbRelCount, after: graph.dbRelCountAfter },
      },
    }
    await writeFile(join(stagingDir, MANIFEST_FILE), JSON.stringify(manifest, null, 2), 'utf8')

    // Archive as .partial first, then verify, then publish by rename.
    await execFileAsync('tar', ['-czf', partial, '-C', outputDir, name])

    const problems = graphCountProblems(graph)
    if (problems.length) {
      throw new Error(`Backup NOT published (left as ${basename(partial)}): ${problems.join('; ')}`)
    }
    const drift = graphCountDrift(graph)
    if (drift.nodes > 0 || drift.rels > 0) {
      log.warn({ ...manifest.graph_counts, outside: drift },
        'What was written lies outside the two counts by less than a live graph explains (data replaced while the backup ran): published')
    }
    await rename(partial, archive)

    const durationMs = Date.now() - start
    log.info({ archive, tenant, nodeCount: graph.nodeCount + graph.endpointNodes, relCount: graph.relCount, attachments: attachments.included, keycloakRealms: keycloak.realms.length, durationMs }, 'Backup published')
    return { archivePath: archive, nodeCount: graph.nodeCount + graph.endpointNodes, relCount: graph.relCount, durationMs, manifest }
  } finally {
    await session.close()
    await rm(stagingDir, { recursive: true, force: true })
  }
}

// ── CLI entrypoint ───────────────────────────────────────────────────────────
// Guarded: this module is also imported by the maintenance worker, which must
// NOT trigger a backup as an import side-effect.

const isDirectRun = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href

if (isDirectRun) {
  const { values } = parseArgs({
    options: {
      'output-dir':       { type: 'string', short: 'o', default: './backups' },
      tenant:             { type: 'string' },
      'skip-keycloak':    { type: 'boolean', default: false },
      'skip-attachments': { type: 'boolean', default: false },
    },
  })
  runScript('backup-neo4j', async () => {
    const skipKeycloak = values['skip-keycloak'] === true
    await runBackup({
      outputDir:       resolve(values['output-dir'] ?? './backups'),
      attachmentDir:   config.attachmentDir,
      skipAttachments: values['skip-attachments'] === true,
      skipKeycloak,
      tenant:          values['tenant'],
      keycloak:        skipKeycloak ? undefined : keycloakConfigFromEnv(),
    })
  })
}
