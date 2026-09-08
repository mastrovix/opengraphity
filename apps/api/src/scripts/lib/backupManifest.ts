/**
 * Backup archive format (D-08) — types and pure helpers shared by
 * backup-neo4j.ts, restore-neo4j.ts and verify-backup.ts. No Neo4j import:
 * unit-testable with fixture files.
 *
 * Archive layout (tar.gz, one top-level directory):
 *   backup_<stamp>/
 *     manifest.json          counts, schema, versions, what is included
 *     nodes.jsonl            {id: elementId, labels: [...], props: {...}} per line
 *     rels.jsonl             {startId, startLabels, startProps, relType, relProps, endId, endLabels, endProps}
 *     attachments.tar        (optional) plain tar of ATTACHMENT_DIR
 *     keycloak/<realm>.json  (optional) partial-export of every tenant realm
 */
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { basename } from 'node:path'

export const MANIFEST_FORMAT = 2
export const MANIFEST_FILE   = 'manifest.json'
export const NODES_FILE      = 'nodes.jsonl'
export const RELS_FILE       = 'rels.jsonl'
export const ATTACHMENTS_TAR = 'attachments.tar'
export const KEYCLOAK_DIR    = 'keycloak'

export interface NodeRow { id: string; labels: string[]; props: Record<string, unknown> }
export interface RelRow {
  startId: string;       startLabels: string[]; startProps: Record<string, unknown>
  relType: string;       relProps: Record<string, unknown>
  endId: string;         endLabels: string[];   endProps: Record<string, unknown>
}

export interface BackupManifest {
  format: number
  created_at: string
  app_version: string
  neo4j_version: string | null
  node_count: number
  rel_count: number
  nodes_by_label: Record<string, number>
  rels_by_type: Record<string, number>
  constraints: Record<string, unknown>[]
  indexes: Record<string, unknown>[]
  attachments: { included: boolean; dir: string | null; file_count: number; total_bytes: number; reason: string | null }
  keycloak: { included: boolean; realms: string[]; reason: string | null }
}

// ── Manifest validation ──────────────────────────────────────────────────────

function isCountMap(v: unknown): v is Record<string, number> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
    && Object.values(v as Record<string, unknown>).every((n) => Number.isInteger(n) && (n as number) >= 0)
}

/** Structural check: throws with the offending field on anything that is not a format-2 manifest. */
export function validateManifest(raw: unknown): BackupManifest {
  if (!raw || typeof raw !== 'object') throw new Error('manifest.json: not an object')
  const m = raw as Record<string, unknown>
  if (m['format'] !== MANIFEST_FORMAT) throw new Error(`manifest.json: unsupported format ${JSON.stringify(m['format'])} (expected ${MANIFEST_FORMAT})`)
  for (const k of ['created_at', 'app_version'] as const) {
    if (typeof m[k] !== 'string' || !m[k]) throw new Error(`manifest.json: missing ${k}`)
  }
  for (const k of ['node_count', 'rel_count'] as const) {
    if (!Number.isInteger(m[k]) || (m[k] as number) < 0) throw new Error(`manifest.json: ${k} is not a non-negative integer`)
  }
  if (!isCountMap(m['nodes_by_label'])) throw new Error('manifest.json: nodes_by_label is not a map of counts')
  if (!isCountMap(m['rels_by_type']))   throw new Error('manifest.json: rels_by_type is not a map of counts')
  if (!Array.isArray(m['constraints'])) throw new Error('manifest.json: constraints is not an array')
  if (!Array.isArray(m['indexes']))     throw new Error('manifest.json: indexes is not an array')
  const att = m['attachments'] as Record<string, unknown> | undefined
  if (!att || typeof att['included'] !== 'boolean') throw new Error('manifest.json: attachments.included missing')
  const kc = m['keycloak'] as Record<string, unknown> | undefined
  if (!kc || typeof kc['included'] !== 'boolean' || !Array.isArray(kc['realms'])) throw new Error('manifest.json: keycloak.{included,realms} missing')
  // The sum of rels_by_type must equal rel_count (each rel has one type); nodes
  // may carry several labels, so nodes_by_label is only checked per label.
  const relSum = Object.values(m['rels_by_type'] as Record<string, number>).reduce((s, n) => s + n, 0)
  if (relSum !== m['rel_count']) throw new Error(`manifest.json: rels_by_type sums to ${relSum}, rel_count is ${m['rel_count']}`)
  return m as unknown as BackupManifest
}

// ── JSONL ────────────────────────────────────────────────────────────────────

export async function* readJsonl<T>(filePath: string): AsyncGenerator<T> {
  const rl = createInterface({ input: createReadStream(filePath, { encoding: 'utf8' }), crlfDelay: Infinity })
  let lineNo = 0
  for await (const line of rl) {
    lineNo++
    if (!line.trim()) continue
    try { yield JSON.parse(line) as T }
    catch (err) { throw new Error(`${basename(filePath)}:${lineNo}: invalid JSON (${(err as Error).message})`) }
  }
}

export interface Tally { count: number; byKey: Record<string, number> }

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** Reads nodes.jsonl, validates each row's shape, tallies rows per label. */
export async function tallyNodes(filePath: string): Promise<Tally> {
  const byKey: Record<string, number> = {}
  let count = 0
  for await (const row of readJsonl<NodeRow>(filePath)) {
    count++
    if (typeof row.id !== 'string' || !Array.isArray(row.labels) || !isPlainObject(row.props)
        || !row.labels.every((l) => typeof l === 'string')) {
      throw new Error(`${basename(filePath)}: row #${count} is not a node row {id, labels[], props{}}`)
    }
    for (const l of row.labels) byKey[l] = (byKey[l] ?? 0) + 1
  }
  return { count, byKey }
}

/** Reads rels.jsonl, validates each row's shape, tallies rows per relationship type. */
export async function tallyRels(filePath: string): Promise<Tally> {
  const byKey: Record<string, number> = {}
  let count = 0
  for await (const row of readJsonl<RelRow>(filePath)) {
    count++
    if (typeof row.startId !== 'string' || typeof row.endId !== 'string' || typeof row.relType !== 'string'
        || !Array.isArray(row.startLabels) || !Array.isArray(row.endLabels)
        || !isPlainObject(row.startProps) || !isPlainObject(row.endProps) || !isPlainObject(row.relProps)) {
      throw new Error(`${basename(filePath)}: row #${count} is not a relationship row`)
    }
    byKey[row.relType] = (byKey[row.relType] ?? 0) + 1
  }
  return { count, byKey }
}

/** Differences between an expected count map and the actual one, as human-readable lines (empty = equal). */
export function compareCounts(what: string, expected: Record<string, number>, actual: Record<string, number>): string[] {
  const problems: string[] = []
  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)])
  for (const k of [...keys].sort()) {
    const e = expected[k] ?? 0
    const a = actual[k] ?? 0
    if (e !== a) problems.push(`${what} "${k}": manifest ${e}, file ${a}`)
  }
  return problems
}
