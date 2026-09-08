/**
 * Restore di Neo4j da un archivio prodotto da backup-neo4j (.tar.gz con
 * backup_nodes_<stamp>.jsonl e backup_rels_<stamp>.jsonl).
 *
 * Contratto (D-28 della revisione):
 *   - idempotente: i nodi con `id` sono MERGE per (prima label, id) e ricevono
 *     tutte le label del backup; i nodi SENZA `id` sono MERGE per chiave
 *     naturale se la label la definisce (Counter) e altrimenti creati solo se
 *     non esiste già un nodo identico (stesse label e proprietà);
 *   - fail-loud: label/tipi di relazione validati (niente interpolazione di
 *     input non conformi), relazioni non ricostruibili contate e, alla fine,
 *     exit ≠ 0 con il conteggio — mai "restore completo" su un restore parziale;
 *   - additivo: non cancella nulla; per un ripristino da zero svuotare prima
 *     il DB esplicitamente;
 *   - batch UNWIND per 500 righe in una sessione (non una sessione per riga);
 *   - `tar` invocato con execFile (niente shell, path con caratteri strani ok).
 *
 * Uso: pnpm --filter @opengraphity/api restore:neo4j -- --input ./backups/backup_<stamp>.tar.gz --yes-restore [--dry-run]
 */
import { parseArgs, promisify }    from 'node:util'
import { createInterface }         from 'node:readline'
import { createReadStream }        from 'node:fs'
import { execFile }                from 'node:child_process'
import { mkdtemp, rm }             from 'node:fs/promises'
import { tmpdir }                  from 'node:os'
import { join, resolve, basename } from 'node:path'
import pino                        from 'pino'
import { getSession }              from '@opengraphity/neo4j'
import { LABEL_RE, REL_TYPE_RE }   from '../lib/cypherIdentifiers.js'
import { requireConfirmFlag }      from './lib/scriptArgs.js'
import { runScript }               from './lib/runScript.js'

const execFileAsync = promisify(execFile)
const log = pino({ level: 'info' })
const BATCH = 500

// ── Tipi ──────────────────────────────────────────────────────────────────────

interface NodeRow { labels: string[]; props: Record<string, unknown> }
interface RelRow {
  startLabels: string[]; startProps: Record<string, unknown>
  relType: string;       relProps: Record<string, unknown>
  endLabels: string[];   endProps: Record<string, unknown>
}

/** Chiavi naturali dei nodi che non hanno `id` (allineate ai constraint di init.ts). */
const NATURAL_KEYS: Record<string, string[]> = {
  Counter: ['tenant_id', 'kind'],
}

// ── Validazione identificatori (finiscono in Cypher per interpolazione) ──────

function assertLabels(labels: string[], where: string): string[] {
  if (labels.length === 0) throw new Error(`${where}: nodo senza label`)
  for (const l of labels) if (!LABEL_RE.test(l)) throw new Error(`${where}: label non ammessa "${l}"`)
  return labels
}
function assertRelType(t: string): string {
  if (!REL_TYPE_RE.test(t)) throw new Error(`Tipo di relazione non ammesso "${t}"`)
  return t
}
const labelsCypher = (labels: string[]) => labels.map((l) => `:${l}`).join('')

// ── Lettura JSONL ─────────────────────────────────────────────────────────────

async function* readJsonl<T>(filePath: string): AsyncGenerator<T> {
  const rl = createInterface({ input: createReadStream(filePath, { encoding: 'utf8' }), crlfDelay: Infinity })
  let lineNo = 0
  for await (const line of rl) {
    lineNo++
    if (!line.trim()) continue
    try { yield JSON.parse(line) as T }
    catch (err) { throw new Error(`${basename(filePath)}:${lineNo}: JSON non valido (${(err as Error).message})`) }
  }
}

async function* batches<T>(gen: AsyncGenerator<T>, size: number): AsyncGenerator<T[]> {
  let buf: T[] = []
  for await (const x of gen) { buf.push(x); if (buf.length >= size) { yield buf; buf = [] } }
  if (buf.length) yield buf
}

// ── Nodi ──────────────────────────────────────────────────────────────────────

interface NodeStats { total: number; withId: number; naturalKey: number; exactMatch: number }

/**
 * Le righe vengono raggruppate per "forma" (label + strategia) perché la
 * Cypher interpola label e chiavi: una query per gruppo, UNWIND sulle righe.
 */
async function restoreNodes(nodesFile: string, dryRun: boolean): Promise<NodeStats> {
  const stats: NodeStats = { total: 0, withId: 0, naturalKey: 0, exactMatch: 0 }
  const session = getSession(undefined, 'WRITE')
  try {
    for await (const batch of batches(readJsonl<NodeRow>(nodesFile), BATCH)) {
      const groups = new Map<string, { cypher: string; rows: Record<string, unknown>[] }>()
      for (const row of batch) {
        stats.total++
        const labels = assertLabels(row.labels, `nodo #${stats.total}`)
        const first  = labels[0]!
        const key    = `${labels.join(':')}|${'id' in row.props ? 'id' : NATURAL_KEYS[first] ? 'nk' : 'exact'}`
        let group = groups.get(key)
        if (!group) {
          let cypher: string
          if ('id' in row.props) {
            stats.withId++
            // MERGE sulla prima label + id; le altre label vengono aggiunte (un nodo
            // che nel frattempo ha cambiato set di label non viene duplicato).
            cypher = `UNWIND $rows AS r MERGE (n:${first} {id: r.props.id}) SET n += r.props SET n${labelsCypher(labels)}`
          } else if (NATURAL_KEYS[first]) {
            stats.naturalKey++
            const nk = NATURAL_KEYS[first]!
            cypher = `UNWIND $rows AS r MERGE (n:${first} {${nk.map((k) => `${k}: r.props.${k}`).join(', ')}}) SET n += r.props SET n${labelsCypher(labels)}`
          } else {
            stats.exactMatch++
            // Nessuna chiave: crea solo se non esiste un nodo con le stesse label e proprietà.
            cypher = `UNWIND $rows AS r OPTIONAL MATCH (m${labelsCypher(labels)}) WHERE properties(m) = r.props WITH r, m WHERE m IS NULL CREATE (n${labelsCypher(labels)}) SET n = r.props`
          }
          group = { cypher, rows: [] }
          groups.set(key, group)
        }
        group.rows.push({ props: row.props })
      }
      if (dryRun) continue
      for (const g of groups.values()) {
        await session.executeWrite((tx) => tx.run(g.cypher, { rows: g.rows }))
      }
      if (stats.total % 5000 === 0) log.info({ nodes: stats.total }, 'nodi ripristinati finora')
    }
  } finally {
    await session.close()
  }
  return stats
}

// ── Relazioni ─────────────────────────────────────────────────────────────────

interface RelStats { total: number; restored: number; skippedNoId: string[]; unmatched: number }

async function restoreRelations(relsFile: string, dryRun: boolean): Promise<RelStats> {
  const stats: RelStats = { total: 0, restored: 0, skippedNoId: [], unmatched: 0 }
  const session = getSession(undefined, 'WRITE')
  try {
    for await (const batch of batches(readJsonl<RelRow>(relsFile), BATCH)) {
      const groups = new Map<string, { cypher: string; rows: Record<string, unknown>[] }>()
      for (const row of batch) {
        stats.total++
        if (!('id' in row.startProps) || !('id' in row.endProps)) {
          stats.skippedNoId.push(`${row.startLabels.join(':')}-[${row.relType}]->${row.endLabels.join(':')}`)
          continue
        }
        const a = assertLabels(row.startLabels, `relazione #${stats.total} (start)`)[0]!
        const b = assertLabels(row.endLabels,   `relazione #${stats.total} (end)`)[0]!
        const t = assertRelType(row.relType)
        const key = `${a}|${t}|${b}`
        let group = groups.get(key)
        if (!group) {
          group = { cypher: `UNWIND $rows AS r MATCH (a:${a} {id: r.startId}) MATCH (b:${b} {id: r.endId}) MERGE (a)-[rel:${t}]->(b) SET rel += r.relProps RETURN count(rel) AS n`, rows: [] }
          groups.set(key, group)
        }
        group.rows.push({ startId: row.startProps['id'], endId: row.endProps['id'], relProps: row.relProps })
      }
      if (dryRun) { stats.restored += [...groups.values()].reduce((s, g) => s + g.rows.length, 0); continue }
      for (const g of groups.values()) {
        const res = await session.executeWrite((tx) => tx.run(g.cypher, { rows: g.rows }))
        const n = Number(res.records[0]?.get('n') ?? 0)
        stats.restored += n
        // MATCH mancato = nodo di testa assente: una relazione persa in silenzio è un restore monco
        stats.unmatched += g.rows.length - n
      }
      if (stats.total % 5000 === 0) log.info({ rels: stats.total }, 'relazioni elaborate finora')
    }
  } finally {
    await session.close()
  }
  return stats
}

// ── CLI ───────────────────────────────────────────────────────────────────────

const { values } = parseArgs({
  options: {
    input:         { type: 'string', short: 'i' },
    'dry-run':     { type: 'boolean', default: false },
    'yes-restore': { type: 'boolean', default: false },
  },
  strict: false,
})

runScript('restore-neo4j', async () => {
  const inputPath = values['input']
  const dryRun    = values['dry-run'] === true
  if (typeof inputPath !== 'string' || !inputPath) throw new Error('--input <archivio.tar.gz> è obbligatorio')
  if (!dryRun) requireConfirmFlag('--yes-restore')

  const archivePath = resolve(inputPath)
  log.info({ archivePath, dryRun }, 'Avvio restore')
  const tmpDir = await mkdtemp(join(tmpdir(), 'neo4j-restore-'))
  try {
    await execFileAsync('tar', ['-xzf', archivePath, '-C', tmpDir])
    const stamp     = basename(archivePath, '.tar.gz').replace('backup_', '')
    const nodesFile = join(tmpDir, `backup_nodes_${stamp}.jsonl`)
    const relsFile  = join(tmpDir, `backup_rels_${stamp}.jsonl`)

    const nodes = await restoreNodes(nodesFile, dryRun)
    log.info({ ...nodes, dryRun }, 'Nodi: fatto')
    const rels = await restoreRelations(relsFile, dryRun)
    log.info({ total: rels.total, restored: rels.restored, unmatched: rels.unmatched, skippedNoId: rels.skippedNoId.length, dryRun }, 'Relazioni: fatto')

    const problems: string[] = []
    if (rels.skippedNoId.length) {
      const byShape = new Map<string, number>()
      for (const s of rels.skippedNoId) byShape.set(s, (byShape.get(s) ?? 0) + 1)
      problems.push(`${rels.skippedNoId.length} relazioni saltate (nodi senza id): ${[...byShape].map(([k, v]) => `${k}×${v}`).join(', ')}`)
    }
    if (rels.unmatched > 0) problems.push(`${rels.unmatched} relazioni non ricostruite (nodo di testa assente nel DB)`)
    if (problems.length) throw new Error(`Restore INCOMPLETO:\n  - ${problems.join('\n  - ')}`)
    log.info({ nodes: nodes.total, rels: rels.restored, dryRun }, 'Restore completo')
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
})
