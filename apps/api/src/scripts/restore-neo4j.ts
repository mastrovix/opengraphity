/**
 * Restore di Neo4j da un archivio prodotto da backup-neo4j (.tar.gz con
 * backup_<stamp>/{manifest.json, nodes.jsonl, rels.jsonl, …}; accettato anche
 * il layout legacy backup_nodes_<stamp>.jsonl + backup_rels_<stamp>.jsonl).
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
 * NON ripristina: gli allegati (attachments.tar → estrarre a mano in
 * ATTACHMENT_DIR), i realm Keycloak (keycloak/<realm>.json → import dalla
 * console/Admin API), constraint e indici (→ `pnpm neo4j:init`), gli
 * embedding vettoriali (proprietà normali: vengono ripristinati, ma l'indice
 * vettoriale lo crea il worker). Vedi docs/OPERATIONS.md.
 *
 * Uso: pnpm --filter @opengraphity/api restore:neo4j -- --input ./backups/backup_<stamp>.tar.gz --yes-restore [--dry-run]
 */
import { parseArgs, promisify }    from 'node:util'
import { execFile }                from 'node:child_process'
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir }                  from 'node:os'
import { join, resolve, basename } from 'node:path'
import { pathToFileURL }           from 'node:url'
import pino                        from 'pino'
import { getSession }              from '@opengraphity/neo4j'
import { LABEL_RE, REL_TYPE_RE }   from '../lib/cypherIdentifiers.js'
import { requireConfirmFlag }      from './lib/scriptArgs.js'
import { runScript }               from './lib/runScript.js'
import { readJsonl, MANIFEST_FILE, NODES_FILE, RELS_FILE, ATTACHMENTS_TAR, KEYCLOAK_DIR, type NodeRow, type RelRow } from './lib/backupManifest.js'

const execFileAsync = promisify(execFile)
const log = pino({ level: 'info' })
const BATCH = 500

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

async function* batches<T>(gen: AsyncGenerator<T>, size: number): AsyncGenerator<T[]> {
  let buf: T[] = []
  for await (const x of gen) { buf.push(x); if (buf.length >= size) { yield buf; buf = [] } }
  if (buf.length) yield buf
}

// ── Archivio ──────────────────────────────────────────────────────────────────

export interface BackupFiles {
  /** Directory con i file (la `backup_<stamp>/` dell'archivio, o la root per il legacy). */
  dir: string
  nodesFile: string
  relsFile: string
  /** null per gli archivi legacy (formato 1, senza manifest). */
  manifestFile: string | null
  attachmentsTar: string | null
  keycloakDir: string | null
}

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true } catch { return false }
}

/** Estrae l'archivio in una directory temporanea (il chiamante la rimuove). */
export async function extractArchive(archivePath: string): Promise<string> {
  const tmpDir = await mkdtemp(join(tmpdir(), 'og-backup-'))
  await execFileAsync('tar', ['-xzf', archivePath, '-C', tmpDir])
  return tmpDir
}

/** Individua i file del backup nell'archivio estratto (layout 2 o legacy). Errore se manca qualcosa. */
export async function locateBackupFiles(extractDir: string): Promise<BackupFiles> {
  const entries = await readdir(extractDir, { withFileTypes: true })
  const dir = entries.find((e) => e.isDirectory() && e.name.startsWith('backup_'))
  if (dir) {
    const base = join(extractDir, dir.name)
    const nodesFile = join(base, NODES_FILE)
    const relsFile  = join(base, RELS_FILE)
    const manifest  = join(base, MANIFEST_FILE)
    for (const f of [nodesFile, relsFile, manifest]) {
      if (!(await exists(f))) throw new Error(`Archivio incompleto: manca ${dir.name}/${basename(f)}`)
    }
    const att = join(base, ATTACHMENTS_TAR)
    const kc  = join(base, KEYCLOAK_DIR)
    return {
      dir: base, nodesFile, relsFile, manifestFile: manifest,
      attachmentsTar: (await exists(att)) ? att : null,
      keycloakDir:    (await exists(kc))  ? kc  : null,
    }
  }
  const nodes = entries.find((e) => e.isFile() && /^backup_nodes_.*\.jsonl$/.test(e.name))
  const rels  = entries.find((e) => e.isFile() && /^backup_rels_.*\.jsonl$/.test(e.name))
  if (!nodes || !rels) throw new Error(`Archivio non riconosciuto: né backup_<stamp>/ né backup_nodes_*.jsonl in ${extractDir}`)
  return { dir: extractDir, nodesFile: join(extractDir, nodes.name), relsFile: join(extractDir, rels.name), manifestFile: null, attachmentsTar: null, keycloakDir: null }
}

// ── Nodi ──────────────────────────────────────────────────────────────────────

export interface NodeStats { total: number; withId: number; naturalKey: number; exactMatch: number }

/**
 * Le righe vengono raggruppate per "forma" (label + strategia) perché la
 * Cypher interpola label e chiavi: una query per gruppo, UNWIND sulle righe.
 * In dry-run non apre alcuna sessione.
 */
export async function restoreNodes(nodesFile: string, dryRun: boolean): Promise<NodeStats> {
  const stats: NodeStats = { total: 0, withId: 0, naturalKey: 0, exactMatch: 0 }
  const session = dryRun ? null : getSession(undefined, 'WRITE')
  try {
    for await (const batch of batches(readJsonl<NodeRow>(nodesFile), BATCH)) {
      const groups = new Map<string, { cypher: string; rows: Record<string, unknown>[] }>()
      for (const row of batch) {
        stats.total++
        const labels = assertLabels(row.labels, `nodo #${stats.total}`)
        const first  = labels[0]!
        const nk     = NATURAL_KEYS[first]
        const strategy = 'id' in row.props ? 'id' : nk ? 'nk' : 'exact'
        const key    = `${labels.join(':')}|${strategy}`
        let group = groups.get(key)
        if (!group) {
          let cypher: string
          if (strategy === 'id') {
            // MERGE sulla prima label + id; le altre label vengono aggiunte (un nodo
            // che nel frattempo ha cambiato set di label non viene duplicato).
            cypher = `UNWIND $rows AS r MERGE (n:${first} {id: r.props.id}) SET n += r.props SET n${labelsCypher(labels)}`
          } else if (strategy === 'nk') {
            cypher = `UNWIND $rows AS r MERGE (n:${first} {${nk!.map((k) => `${k}: r.props.${k}`).join(', ')}}) SET n += r.props SET n${labelsCypher(labels)}`
          } else {
            // Nessuna chiave: crea solo se non esiste un nodo con le stesse label e proprietà.
            cypher = `UNWIND $rows AS r OPTIONAL MATCH (m${labelsCypher(labels)}) WHERE properties(m) = r.props WITH r, m WHERE m IS NULL CREATE (n${labelsCypher(labels)}) SET n = r.props`
          }
          group = { cypher, rows: [] }
          groups.set(key, group)
        }
        if (strategy === 'id') stats.withId++
        else if (strategy === 'nk') stats.naturalKey++
        else stats.exactMatch++
        group.rows.push({ props: row.props })
      }
      if (!session) continue
      for (const g of groups.values()) {
        await session.executeWrite((tx) => tx.run(g.cypher, { rows: g.rows }))
      }
      if (stats.total % 5000 === 0) log.info({ nodes: stats.total }, 'nodi ripristinati finora')
    }
  } finally {
    await session?.close()
  }
  return stats
}

// ── Relazioni ─────────────────────────────────────────────────────────────────

export interface RelStats { total: number; restored: number; skippedNoId: string[]; unmatched: number }

export async function restoreRelations(relsFile: string, dryRun: boolean): Promise<RelStats> {
  const stats: RelStats = { total: 0, restored: 0, skippedNoId: [], unmatched: 0 }
  const session = dryRun ? null : getSession(undefined, 'WRITE')
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
      if (!session) { stats.restored += [...groups.values()].reduce((s, g) => s + g.rows.length, 0); continue }
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
    await session?.close()
  }
  return stats
}

/** Riepilogo per forma delle relazioni saltate (nodi senza id). */
export function summarizeSkipped(skipped: string[]): string {
  const byShape = new Map<string, number>()
  for (const s of skipped) byShape.set(s, (byShape.get(s) ?? 0) + 1)
  return [...byShape].map(([k, v]) => `${k}×${v}`).join(', ')
}

// ── CLI ───────────────────────────────────────────────────────────────────────
// Guarded: verify-backup.ts importa le funzioni sopra e non deve avviare un restore.

const isDirectRun = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href

if (isDirectRun) {
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
    const tmpDir = await extractArchive(archivePath)
    try {
      const files = await locateBackupFiles(tmpDir)
      if (!files.manifestFile) log.warn('Archivio legacy (senza manifest): nessuna verifica dei conteggi possibile')
      if (files.attachmentsTar) log.warn({ file: files.attachmentsTar }, 'Allegati presenti nell\'archivio: NON ripristinati da questo script (estrarli in ATTACHMENT_DIR)')
      if (files.keycloakDir)    log.warn({ dir: files.keycloakDir },     'Export Keycloak presente nell\'archivio: NON ripristinato da questo script (import realm da console/Admin API)')

      const nodes = await restoreNodes(files.nodesFile, dryRun)
      log.info({ ...nodes, dryRun }, 'Nodi: fatto')
      const rels = await restoreRelations(files.relsFile, dryRun)
      log.info({ total: rels.total, restored: rels.restored, unmatched: rels.unmatched, skippedNoId: rels.skippedNoId.length, dryRun }, 'Relazioni: fatto')

      const problems: string[] = []
      if (rels.skippedNoId.length) problems.push(`${rels.skippedNoId.length} relazioni saltate (nodi senza id): ${summarizeSkipped(rels.skippedNoId)}`)
      if (rels.unmatched > 0) problems.push(`${rels.unmatched} relazioni non ricostruite (nodo di testa assente nel DB)`)
      if (problems.length) throw new Error(`Restore INCOMPLETO:\n  - ${problems.join('\n  - ')}`)
      log.info({ nodes: nodes.total, rels: rels.restored, dryRun }, 'Restore completo')
    } finally {
      await rm(tmpDir, { recursive: true, force: true })
    }
  })
}
