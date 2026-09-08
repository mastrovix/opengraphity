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
 * Usage: pnpm --filter @opengraphity/api backup:neo4j -- [--output-dir ./backups] [--skip-keycloak] [--skip-attachments]
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
import { getDriver, toNative }             from '@opengraphity/neo4j'
import { createKeycloakAdmin, keycloakConfigFromEnv, type KeycloakAdminConfig } from './lib/keycloakAdmin.js'
import {
  MANIFEST_FILE, NODES_FILE, RELS_FILE, ATTACHMENTS_TAR, KEYCLOAK_DIR, MANIFEST_FORMAT,
  type BackupManifest,
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
  nodeCount: number; relCount: number
  dbNodeCount: number; dbRelCount: number
  nodesByLabel: Record<string, number>; relsByType: Record<string, number>
}

const NODES_CYPHER = 'MATCH (n) RETURN elementId(n) AS id, labels(n) AS labels, properties(n) AS props'
const RELS_CYPHER  = `
  MATCH (a)-[r]->(b)
  RETURN elementId(a) AS startId, labels(a) AS startLabels, properties(a) AS startProps,
         type(r) AS relType, properties(r) AS relProps,
         elementId(b) AS endId, labels(b) AS endLabels, properties(b) AS endProps`

async function exportGraph(session: Session, stagingDir: string, log: BackupLogger): Promise<GraphExport> {
  const nodesStream = createWriteStream(join(stagingDir, NODES_FILE), { encoding: 'utf8' })
  const relsStream  = createWriteStream(join(stagingDir, RELS_FILE),  { encoding: 'utf8' })
  const out: GraphExport = { nodeCount: 0, relCount: 0, dbNodeCount: 0, dbRelCount: 0, nodesByLabel: {}, relsByType: {} }

  // One explicit READ transaction for counts + both streams: every row comes
  // from the same transactional view, in whatever order the store yields it
  // (no pagination, so no ordering assumption at all).
  const tx = session.beginTransaction()
  try {
    const counts = await tx.run('MATCH (n) WITH count(n) AS nodes MATCH ()-[r]->() RETURN nodes, count(r) AS rels')
    const c = counts.records[0]
    if (!c) throw new Error('count query returned no row')
    out.dbNodeCount = toNative(c.get('nodes')) as number
    out.dbRelCount  = toNative(c.get('rels'))  as number
    log.info({ nodes: out.dbNodeCount, rels: out.dbRelCount }, 'Graph counts read')

    const nodesResult: Result = tx.run(NODES_CYPHER)
    for await (const r of nodesResult) {
      const labels = r.get('labels') as string[]
      await writeLine(nodesStream, JSON.stringify({ id: r.get('id'), labels, props: toNative(r.get('props')) }))
      out.nodeCount++
      tally(out.nodesByLabel, labels)
      if (out.nodeCount % 50_000 === 0) log.info({ nodes: out.nodeCount }, 'Nodes exported so far')
    }

    const relsResult: Result = tx.run(RELS_CYPHER)
    for await (const r of relsResult) {
      const relType = r.get('relType') as string
      await writeLine(relsStream, JSON.stringify({
        startId: r.get('startId'), startLabels: r.get('startLabels'), startProps: toNative(r.get('startProps')),
        relType, relProps: toNative(r.get('relProps')),
        endId: r.get('endId'), endLabels: r.get('endLabels'), endProps: toNative(r.get('endProps')),
      }))
      out.relCount++
      tally(out.relsByType, [relType])
      if (out.relCount % 50_000 === 0) log.info({ rels: out.relCount }, 'Relationships exported so far')
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
  const { files, bytes } = await dirStats(opts.attachmentDir)
  await execFileAsync('tar', ['-cf', join(stagingDir, ATTACHMENTS_TAR), '-C', opts.attachmentDir, '.'])
  log.info({ files, bytes }, 'Attachments archived')
  return { included: true, dir: opts.attachmentDir, file_count: files, total_bytes: bytes, reason: null }
}

// ── Keycloak realms ──────────────────────────────────────────────────────────

async function exportKeycloak(opts: BackupOptions, session: Session, stagingDir: string, log: BackupLogger): Promise<BackupManifest['keycloak']> {
  if (opts.skipKeycloak) return { included: false, realms: [], reason: 'skipped by option (--skip-keycloak)' }
  if (!opts.keycloak) throw new Error('Keycloak export requested but no Keycloak admin configuration given (pass --skip-keycloak to skip it knowingly)')

  const tenants = (await session.run('MATCH (t:Tenant) RETURN t.id AS id ORDER BY t.id')).records
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
    throw new Error(`Keycloak unreachable or admin auth failed at ${kc.baseUrl}: ${(err as Error).message} — fix it or rerun with --skip-keycloak`)
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

// ── Main ─────────────────────────────────────────────────────────────────────

export async function runBackup(opts: BackupOptions): Promise<BackupResult> {
  const start = Date.now()
  const log: BackupLogger = opts.log ?? pino({ level: 'info' })
  const outputDir = resolve(opts.outputDir)
  await mkdir(outputDir, { recursive: true })

  const stamp      = stampNow()
  const name       = `backup_${stamp}`
  const stagingDir = join(outputDir, name)
  const partial    = join(outputDir, `${name}.tar.gz.partial`)
  const archive    = join(outputDir, `${name}.tar.gz`)
  await mkdir(stagingDir, { recursive: false })   // a second backup in the same second must not share the staging dir
  log.info({ stagingDir }, 'Starting backup')

  const session = getDriver().session({ defaultAccessMode: neo4j.session.READ })
  try {
    const graph  = await exportGraph(session, stagingDir, log)
    const schema = await readSchema(session)
    const attachments = await exportAttachments(opts, stagingDir, log)
    const keycloak    = await exportKeycloak(opts, session, stagingDir, log)

    const manifest: BackupManifest = {
      format:         MANIFEST_FORMAT,
      created_at:     new Date().toISOString(),
      app_version:    opts.appVersion ?? readAppVersion(),
      neo4j_version:  schema.neo4jVersion,
      node_count:     graph.nodeCount,
      rel_count:      graph.relCount,
      nodes_by_label: graph.nodesByLabel,
      rels_by_type:   graph.relsByType,
      constraints:    schema.constraints,
      indexes:        schema.indexes,
      attachments,
      keycloak,
    }
    await writeFile(join(stagingDir, MANIFEST_FILE), JSON.stringify(manifest, null, 2), 'utf8')

    // Archive as .partial first, then verify, then publish by rename.
    await execFileAsync('tar', ['-czf', partial, '-C', outputDir, name])

    const problems: string[] = []
    if (graph.nodeCount !== graph.dbNodeCount) problems.push(`nodes: ${graph.nodeCount} written, ${graph.dbNodeCount} counted in the same transaction`)
    if (graph.relCount  !== graph.dbRelCount)  problems.push(`relationships: ${graph.relCount} written, ${graph.dbRelCount} counted in the same transaction`)
    if (problems.length) {
      throw new Error(`Backup NOT published (left as ${basename(partial)}): ${problems.join('; ')}`)
    }
    await rename(partial, archive)

    const durationMs = Date.now() - start
    log.info({ archive, nodeCount: graph.nodeCount, relCount: graph.relCount, attachments: attachments.included, keycloakRealms: keycloak.realms.length, durationMs }, 'Backup published')
    return { archivePath: archive, nodeCount: graph.nodeCount, relCount: graph.relCount, durationMs, manifest }
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
      keycloak:        skipKeycloak ? undefined : keycloakConfigFromEnv(),
    })
  })
}
