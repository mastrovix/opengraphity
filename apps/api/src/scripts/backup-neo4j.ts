/**
 * Backup Neo4j database to JSONL files, then tar.gz.
 * Usage: pnpm tsx apps/api/src/scripts/backup-neo4j.ts [--output-dir ./backups]
 */
import { parseArgs }                  from 'node:util'
import { createWriteStream, mkdirSync } from 'node:fs'
import { resolve }                    from 'node:path'
import { promisify }                  from 'node:util'
import { exec }                       from 'node:child_process'
import { unlink }                     from 'node:fs/promises'
import pino                           from 'pino'
import { getSession }                 from '@opengraphity/neo4j'
import neo4j                          from 'neo4j-driver'

const execAsync = promisify(exec)
const log       = pino({ level: 'info' })

export interface BackupResult {
  archivePath:  string
  nodeCount:    number
  relCount:     number
  durationMs:   number
}

// ── Core backup logic (shared with maintenance worker) ────────────────────────

export async function runBackup(outputDir: string): Promise<BackupResult> {
  const start = Date.now()
  mkdirSync(outputDir, { recursive: true })

  const stamp     = new Date().toISOString().replace(/[:.]/g, '').replace('T', '_').slice(0, 15)
  const nodesFile = resolve(outputDir, `backup_nodes_${stamp}.jsonl`)
  const relsFile  = resolve(outputDir, `backup_rels_${stamp}.jsonl`)
  const archive   = resolve(outputDir, `backup_${stamp}.tar.gz`)

  log.info({ nodesFile, relsFile }, 'Starting backup')

  // ── Nodes ──────────────────────────────────────────────────────────────────
  const nodesStream = createWriteStream(nodesFile, { encoding: 'utf8' })
  let nodeCount = 0
  const NODE_BATCH = 10_000
  let skip = 0

  while (true) {
    const session = getSession(undefined, 'READ')
    let batchSize = 0
    try {
      const result = await session.executeRead(tx =>
        tx.run(
          'MATCH (n) RETURN labels(n) AS labels, properties(n) AS props SKIP $skip LIMIT $limit',
          { skip: neo4j.int(skip), limit: neo4j.int(NODE_BATCH) },
        ),
      )
      batchSize = result.records.length
      for (const r of result.records) {
        const row = { labels: r.get('labels') as string[], props: r.get('props') as Record<string, unknown> }
        nodesStream.write(JSON.stringify(row) + '\n')
      }
    } finally {
      await session.close()
    }
    nodeCount += batchSize
    skip      += batchSize
    log.info({ nodeCount, skip }, 'Node batch written')
    if (batchSize < NODE_BATCH) break
  }

  await new Promise<void>((res, rej) => { nodesStream.end((err: Error | null | undefined) => err ? rej(err) : res()) })
  log.info({ nodeCount }, 'Nodes backup complete')

  // ── Relations ──────────────────────────────────────────────────────────────
  const relsStream = createWriteStream(relsFile, { encoding: 'utf8' })
  let relCount = 0
  const REL_BATCH = 5_000
  skip = 0

  while (true) {
    const session = getSession(undefined, 'READ')
    let batchSize = 0
    try {
      const result = await session.executeRead(tx =>
        tx.run(
          `MATCH (a)-[r]->(b)
           RETURN id(a) AS startId, labels(a) AS startLabels, properties(a) AS startProps,
                  type(r) AS relType, properties(r) AS relProps,
                  id(b) AS endId, labels(b) AS endLabels, properties(b) AS endProps
           SKIP $skip LIMIT $limit`,
          { skip: neo4j.int(skip), limit: neo4j.int(REL_BATCH) },
        ),
      )
      batchSize = result.records.length
      for (const r of result.records) {
        const row = {
          startId:     toNum(r.get('startId')),
          startLabels: r.get('startLabels') as string[],
          startProps:  r.get('startProps')  as Record<string, unknown>,
          relType:     r.get('relType')     as string,
          relProps:    r.get('relProps')    as Record<string, unknown>,
          endId:       toNum(r.get('endId')),
          endLabels:   r.get('endLabels')   as string[],
          endProps:    r.get('endProps')    as Record<string, unknown>,
        }
        relsStream.write(JSON.stringify(row) + '\n')
      }
    } finally {
      await session.close()
    }
    relCount += batchSize
    skip     += batchSize
    log.info({ relCount, skip }, 'Relation batch written')
    if (batchSize < REL_BATCH) break
  }

  await new Promise<void>((res, rej) => { relsStream.end((err: Error | null | undefined) => err ? rej(err) : res()) })
  log.info({ relCount }, 'Relations backup complete')

  // ── Archive ────────────────────────────────────────────────────────────────
  const { stderr } = await execAsync(
    `tar -czf "${archive}" -C "${outputDir}" "${nodesFile.split('/').at(-1)}" "${relsFile.split('/').at(-1)}"`,
  )
  if (stderr) log.warn({ stderr }, 'tar stderr')

  await unlink(nodesFile)
  await unlink(relsFile)

  const durationMs = Date.now() - start
  log.info({ archive, nodeCount, relCount, durationMs }, 'Backup archived')

  return { archivePath: archive, nodeCount, relCount, durationMs }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toNum(v: unknown): number {
  if (typeof v === 'number') return v
  if (v && typeof (v as { toNumber(): number }).toNumber === 'function') {
    return (v as { toNumber(): number }).toNumber()
  }
  return Number(v ?? 0)
}

// ── CLI entrypoint ────────────────────────────────────────────────────────────

const { values } = parseArgs({
  options: {
    'output-dir': { type: 'string', short: 'o', default: './backups' },
  },
})

const outputDir = resolve(values['output-dir'] ?? './backups')

runBackup(outputDir).catch((err: unknown) => {
  log.fatal({ err }, 'Backup failed')
  process.exit(1)
})
