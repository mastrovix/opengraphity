/**
 * Restore Neo4j from a backup archive (.tar.gz).
 * Usage: pnpm tsx apps/api/src/scripts/restore-neo4j.ts --input ./backups/backup_20240101_000000.tar.gz [--dry-run]
 */
import { parseArgs }               from 'node:util'
import { createInterface }         from 'node:readline'
import { createReadStream }        from 'node:fs'
import { promisify }               from 'node:util'
import { exec }                    from 'node:child_process'
import { mkdtemp, rm }             from 'node:fs/promises'
import { tmpdir }                  from 'node:os'
import { join, resolve, basename } from 'node:path'
import pino                        from 'pino'
import { getSession }              from '@opengraphity/neo4j'

const execAsync = promisify(exec)
const log       = pino({ level: 'info' })

// ── Types ─────────────────────────────────────────────────────────────────────

interface NodeRow {
  labels: string[]
  props:  Record<string, unknown>
}

interface RelRow {
  startId:     number
  startLabels: string[]
  startProps:  Record<string, unknown>
  relType:     string
  relProps:    Record<string, unknown>
  endId:       number
  endLabels:   string[]
  endProps:    Record<string, unknown>
}

// ── JSONL reader ──────────────────────────────────────────────────────────────

async function* readJsonl<T>(filePath: string): AsyncGenerator<T> {
  const rl = createInterface({
    input:     createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })
  for await (const line of rl) {
    if (line.trim()) {
      yield JSON.parse(line) as T
    }
  }
}

// ── Restore nodes ─────────────────────────────────────────────────────────────

async function restoreNodes(nodesFile: string, dryRun: boolean): Promise<number> {
  let count = 0
  for await (const row of readJsonl<NodeRow>(nodesFile)) {
    count++
    if (dryRun) continue

    const labelsStr = row.labels.map(l => `:\`${l}\``).join('')
    const hasId     = 'id' in row.props

    const session = getSession(undefined, 'WRITE')
    try {
      if (hasId) {
        await session.executeWrite(tx =>
          tx.run(
            `MERGE (n${labelsStr} {id: $id}) SET n += $props`,
            { id: row.props['id'], props: row.props },
          ),
        )
      } else {
        await session.executeWrite(tx =>
          tx.run(
            `CREATE (n${labelsStr}) SET n = $props`,
            { props: row.props },
          ),
        )
      }
    } finally {
      await session.close()
    }
  }
  return count
}

// ── Restore relations ─────────────────────────────────────────────────────────

async function restoreRelations(relsFile: string, dryRun: boolean): Promise<number> {
  let count = 0
  for await (const row of readJsonl<RelRow>(relsFile)) {
    count++
    if (dryRun) continue

    const startLabel = row.startLabels[0] ?? 'Node'
    const endLabel   = row.endLabels[0]   ?? 'Node'

    const startHasId = 'id' in row.startProps
    const endHasId   = 'id' in row.endProps

    if (!startHasId || !endHasId) {
      log.warn({ relType: row.relType, startId: row.startId }, 'Skipping relation — nodes missing stable id')
      continue
    }

    const session = getSession(undefined, 'WRITE')
    try {
      await session.executeWrite(tx =>
        tx.run(
          `MATCH (a:\`${startLabel}\` {id: $startId})
           MATCH (b:\`${endLabel}\` {id: $endId})
           MERGE (a)-[r:\`${row.relType}\`]->(b)
           SET r += $relProps`,
          {
            startId:  row.startProps['id'],
            endId:    row.endProps['id'],
            relProps: row.relProps,
          },
        ),
      )
    } finally {
      await session.close()
    }

    if (count % 1000 === 0) {
      log.info({ count }, 'Relations restored so far')
    }
  }
  return count
}

// ── CLI ───────────────────────────────────────────────────────────────────────

const { values } = parseArgs({
  options: {
    input:     { type: 'string', short: 'i' },
    'dry-run': { type: 'boolean', default: false },
  },
})

const inputPath = values['input']
const dryRun    = values['dry-run'] ?? false

if (!inputPath) {
  log.fatal('--input is required')
  process.exit(1)
}

const archivePath = resolve(inputPath)

async function main(): Promise<void> {
  log.info({ archivePath, dryRun }, 'Starting restore')

  const tmpDir = await mkdtemp(join(tmpdir(), 'neo4j-restore-'))

  try {
    // Extract archive
    await execAsync(`tar -xzf "${archivePath}" -C "${tmpDir}"`)
    log.info({ tmpDir }, 'Archive extracted')

    const archiveName   = basename(archivePath, '.tar.gz')
    const stamp         = archiveName.replace('backup_', '')
    const nodesFile     = join(tmpDir, `backup_nodes_${stamp}.jsonl`)
    const relsFile      = join(tmpDir, `backup_rels_${stamp}.jsonl`)

    if (dryRun) {
      log.info('DRY RUN — counting records (no writes)')
    }

    const nodeCount = await restoreNodes(nodesFile, dryRun)
    log.info({ nodeCount, dryRun }, 'Nodes restore complete')

    const relCount = await restoreRelations(relsFile, dryRun)
    log.info({ relCount, dryRun }, 'Relations restore complete')

    log.info({ nodeCount, relCount, dryRun }, 'Restore finished')

  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
}

main().catch((err: unknown) => {
  log.fatal({ err }, 'Restore failed')
  process.exit(1)
})
