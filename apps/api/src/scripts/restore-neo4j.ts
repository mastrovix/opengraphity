/**
 * Restore di Neo4j da un archivio prodotto da backup-neo4j (.tar.gz con
 * backup_<stamp>/{manifest.json, nodes.jsonl, rels.jsonl, …}; accettato anche
 * il layout legacy backup_nodes_<stamp>.jsonl + backup_rels_<stamp>.jsonl).
 *
 * Contratto (D-28 della revisione):
 *   - idempotente: i nodi con `id` sono MERGE per (prima label, id) e ricevono
 *     tutte le label del backup; i nodi SENZA `id` sono MERGE per chiave
 *     naturale se la label la definisce (NATURAL_KEYS) e altrimenti creati una
 *     volta per elementId dell'archivio (RESTORE_EID, sotto);
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
 * console/Admin API), constraint e indici (→ `pnpm neo4j:schema`, PRIMA del
 * restore; poi `migrate` — docs/OPERATIONS.md §2), gli
 * embedding vettoriali (proprietà normali: vengono ripristinati, ma l'indice
 * vettoriale lo crea il worker). Vedi docs/OPERATIONS.md.
 *
 * UN TENANT (review of 23 Sep 2026): an archive written by `backup:neo4j
 * --tenant <slug>` is restored with `--tenant <slug>`, and only that way: the
 * slug must be the archive's, and every node must belong to that tenant or be
 * a shipped `system` node — checked on the whole file BEFORE anything is
 * written. Additive like the rest: to restore a tenant from scratch, delete
 * it first.
 *
 * Uso: pnpm --filter @opengraphity/api restore:neo4j -- --input ./backups/backup_<stamp>.tar.gz --yes-restore [--dry-run] [--tenant <slug>]
 */
import { parseArgs, promisify }    from 'node:util'
import { execFile }                from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir }                  from 'node:os'
import { join, resolve, basename } from 'node:path'
import { pathToFileURL }           from 'node:url'
import pino                        from 'pino'
import { getSession, MAINTENANCE_TX_CONFIG } from '@opengraphity/neo4j'
import type { Session }           from 'neo4j-driver'
import { LABEL_RE, REL_TYPE_RE }   from '../lib/cypherIdentifiers.js'
import { requireConfirmFlag }      from './lib/scriptArgs.js'
import { runScript }               from './lib/runScript.js'
import { readJsonl, validateManifest, manifestTenant, MANIFEST_FILE, NODES_FILE, RELS_FILE, ATTACHMENTS_TAR, KEYCLOAK_DIR, type NodeRow, type RelRow } from './lib/backupManifest.js'

const execFileAsync = promisify(execFile)
const log = pino({ level: 'info' })
const BATCH = 500

/** Chiavi naturali dei nodi che non hanno `id` (allineate ai constraint di init.ts). */
const NATURAL_KEYS: Record<string, string[]> = {
  Counter:       ['tenant_id', 'kind'],
  DomainMatrix:  ['tenant_id', 'kind'],
  AnomalyConfig: ['tenant_id'],
  // Unique in the schema (migration 20261003_1010): the revision of an item's form.
  CatalogFormRevision: ['tenant_id', 'item_id', 'revision'],
}

/**
 * THE RESTORE OF A LARGE GRAPH FINISHES, AND LOSES NOTHING (review of 23 Sep
 * 2026, found by the first real restore, on a copy).
 *
 * - Speed: a node is MERGEd by (first label, id), and many labels have no
 *   index on `id` (AuditEntry: 1.6 million nodes). Every MERGE scanned the
 *   label: 200 nodes a second, six hours for the demo tenant. The labels the
 *   archive needs get a TEMPORARY index on `id`, dropped at the end: the
 *   schema stays the product's (init.ts), not the restore's.
 * - Nodes without `id` (the rows of a form table, the revisions of a catalog
 *   form): the relationships that touched them were skipped, and the restore
 *   ended INCOMPLETE with 12,786 relationships lost. Each such node now gets
 *   the elementId it had in the archive as `_restore_eid` (with a temporary
 *   index), the relationships find it by that, and the property is removed
 *   at the end.
 */
export const RESTORE_EID = '_restore_eid'
const TEMP_INDEX_PREFIX = 'og_restore_'

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
            cypher = `UNWIND $rows AS r MERGE (n:${first} {${nk!.map((k) => `${k}: r.props.${k}`).join(', ')}}) SET n += r.props SET n${labelsCypher(labels)} SET n.${RESTORE_EID} = r.eid`
          } else {
            // Nessuna chiave: l'identità è l'elementId dell'archivio (RESTORE_EID), non le
            // proprietà — due righe uguali di due richieste diverse sono due nodi, e prima
            // se ne ripristinava uno solo. Rilanciare lo stesso restore non duplica (il segno
            // è indicizzato); un secondo restore dopo la pulizia sì: questi nodi, oggi, sono
            // solo quelli degli archivi scritti prima che ogni nodo avesse un id.
            cypher = `UNWIND $rows AS r OPTIONAL MATCH (m${labelsCypher(labels)} {${RESTORE_EID}: r.eid}) WITH r, m WHERE m IS NULL CREATE (n${labelsCypher(labels)}) SET n = r.props, n.${RESTORE_EID} = r.eid`
          }
          group = { cypher, rows: [] }
          groups.set(key, group)
        }
        if (strategy === 'id') stats.withId++
        else if (strategy === 'nk') stats.naturalKey++
        else stats.exactMatch++
        group.rows.push({ props: row.props, eid: row.id })
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

/** How a relationship end is found: by `id`, or by the archive elementId the restore wrote on it. */
function endMatch(alias: string, label: string, props: Record<string, unknown>, param: string): string {
  return 'id' in props ? `(${alias}:${label} {id: r.${param}})` : `(${alias}:${label} {${RESTORE_EID}: r.${param}})`
}

/**
 * PARALLEL RELATIONSHIPS SURVIVE (review of 23 Sep 2026, found by the first
 * real restore). The restore did `MERGE (a)-[:T]->(b)`, which folds every
 * relationship of one type between two nodes into ONE: the factory close of
 * a resolved incident (timer) and «Confirm resolution» (manual) — two
 * TRANSITIONS_TO between the same steps — came back as one, and so did a
 * request referring to the same CI from two form fields. And the count said
 * «restored» for both. A relationship's identity is now its ends, its type
 * AND its properties, and it is written as many times as the archive has it:
 * restoring twice still adds nothing. (Two identical parallel relationships
 * in two different batches of the file count as one: the multiplicity is
 * counted per batch of BATCH rows.)
 */
export async function restoreRelations(relsFile: string, dryRun: boolean): Promise<RelStats> {
  const stats: RelStats = { total: 0, restored: 0, skippedNoId: [], unmatched: 0 }
  const session = dryRun ? null : getSession(undefined, 'WRITE')
  try {
    for await (const batch of batches(readJsonl<RelRow>(relsFile), BATCH)) {
      const groups = new Map<string, { cypher: string; rows: Map<string, Record<string, unknown> & { k: number }> }>()
      for (const row of batch) {
        stats.total++
        const a = assertLabels(row.startLabels, `relazione #${stats.total} (start)`)[0]!
        const b = assertLabels(row.endLabels,   `relazione #${stats.total} (end)`)[0]!
        const t = assertRelType(row.relType)
        const aById = 'id' in row.startProps
        const bById = 'id' in row.endProps
        const key = `${a}|${aById}|${t}|${b}|${bById}`
        let group = groups.get(key)
        if (!group) {
          group = {
            cypher: `UNWIND $rows AS r MATCH ${endMatch('a', a, row.startProps, 'start')} MATCH ${endMatch('b', b, row.endProps, 'end')}
              OPTIONAL MATCH (a)-[e:${t}]->(b) WHERE properties(e) = r.relProps
              WITH a, b, r, count(e) AS have
              FOREACH (_ IN range(1, r.k - have) | CREATE (a)-[x:${t}]->(b) SET x = r.relProps)
              RETURN sum(r.k) AS n`,
            rows: new Map(),
          }
          groups.set(key, group)
        }
        const start = aById ? row.startProps['id'] : row.startId
        const end   = bById ? row.endProps['id']   : row.endId
        const identity = JSON.stringify([start, end, row.relProps])
        const seen = group.rows.get(identity)
        if (seen) seen.k++
        else group.rows.set(identity, { start, end, relProps: row.relProps, k: 1 })
      }
      if (!session) { stats.restored += [...groups.values()].reduce((s, g) => s + [...g.rows.values()].reduce((x, r) => x + r.k, 0), 0); continue }
      for (const g of groups.values()) {
        const rows = [...g.rows.values()]
        const res = await session.executeWrite((tx) => tx.run(g.cypher, { rows }))
        const n = Number(res.records[0]?.get('n') ?? 0)
        stats.restored += n
        // MATCH mancato = nodo di testa assente: una relazione persa in silenzio è un restore monco
        stats.unmatched += rows.reduce((x, r) => x + r.k, 0) - n
      }
      if (stats.total % 5000 === 0) log.info({ rels: stats.total }, 'relazioni elaborate finora')
    }
  } finally {
    await session?.close()
  }
  return stats
}

/** What the archive's nodes need: the labels MERGEd by `id`, and those that get the elementId marker. */
export async function restorePlan(nodesFile: string): Promise<{ byId: Set<string>; byEid: Set<string> }> {
  const byId = new Set<string>()
  const byEid = new Set<string>()
  for await (const row of readJsonl<NodeRow>(nodesFile)) {
    const first = assertLabels(row.labels, 'nodo')[0]!
    if ('id' in row.props) byId.add(first)
    else byEid.add(first)
  }
  return { byId, byEid }
}

/**
 * Creates the temporary indexes the restore needs (see RESTORE_EID) and
 * waits until they are online. Returns their names, for `dropRestoreIndexes`.
 */
export async function createRestoreIndexes(session: Session, plan: { byId: Set<string>; byEid: Set<string> }): Promise<string[]> {
  const existing = await session.run(`SHOW INDEXES YIELD labelsOrTypes, properties, entityType WHERE entityType = 'NODE' AND size(labelsOrTypes) = 1 AND properties = ['id'] RETURN labelsOrTypes[0] AS label`)
  const indexedById = new Set(existing.records.map((r) => r.get('label') as string))
  const created: string[] = []
  const create = async (label: string, prop: string) => {
    const name = `${TEMP_INDEX_PREFIX}${label}_${prop.replace(/^_+/, '')}`
    await session.run(`CREATE INDEX \`${name}\` IF NOT EXISTS FOR (n:${label}) ON (n.${prop})`)
    created.push(name)
  }
  for (const label of plan.byId) if (!indexedById.has(label)) await create(label, 'id')
  for (const label of plan.byEid) await create(label, RESTORE_EID)
  if (created.length) {
    // Up to ten minutes by design: past the server's 120 s (queryScope.ts in @opengraphity/neo4j).
    await session.run('CALL db.awaitIndexes(600)', {}, MAINTENANCE_TX_CONFIG)
    log.info({ indexes: created.length }, 'Indici temporanei del restore pronti')
  }
  return created
}

/** Removes the elementId markers and drops the temporary indexes: the graph and the schema end as the product has them. */
export async function cleanUpRestore(session: Session, byEid: Set<string>, indexes: string[]): Promise<void> {
  for (const label of byEid) {
    // The outer transaction of `IN TRANSACTIONS` lasts the whole label: past the server's 120 s.
    await session.run(`MATCH (n:${label}) WHERE n.${RESTORE_EID} IS NOT NULL CALL (n) { REMOVE n.${RESTORE_EID} } IN TRANSACTIONS OF 10000 ROWS`, {}, MAINTENANCE_TX_CONFIG)
  }
  for (const name of indexes) {
    if (!name.startsWith(TEMP_INDEX_PREFIX) || !/^[A-Za-z0-9_]+$/.test(name)) throw new Error(`Not a restore index: ${name}`)
    await session.run(`DROP INDEX \`${name}\` IF EXISTS`)
  }
}

/**
 * Whether the archive may be restored as asked (review of 23 Sep 2026): a
 * tenant archive only with its own `--tenant`, an installation archive never
 * with one. `null` = fine; otherwise the reason.
 */
export function scopeMismatch(archiveTenant: string | null, requested: string | null): string | null {
  if (archiveTenant === requested) return null
  if (archiveTenant === null) return `this is a backup of the whole installation: restore it without --tenant (asked: ${String(requested)})`
  if (requested === null) return `this is the backup of tenant "${archiveTenant}": restore it with --tenant ${archiveTenant}`
  return `this is the backup of tenant "${archiveTenant}", not of "${requested}"`
}

/**
 * Every node of a tenant archive belongs to that tenant (its own Tenant node
 * included) or is a shipped `system` node. A foreign node would be written
 * into another tenant by a restore meant for this one: the whole file is read
 * first, and one such node refuses the restore before anything is written.
 */
export async function foreignNodesInTenantArchive(nodesFile: string, tenant: string): Promise<{ count: number; sample: string[] }> {
  let count = 0
  const sample: string[] = []
  for await (const row of readJsonl<NodeRow>(nodesFile)) {
    const owner = row.props['tenant_id']
    const ownTenantNode = row.labels.includes('Tenant') && row.props['id'] === tenant
    if (owner === tenant || owner === 'system' || ownTenantNode) continue
    count++
    if (sample.length < 5) sample.push(`${row.labels.join(':')} ${JSON.stringify(row.props['id'] ?? null)} (tenant_id ${JSON.stringify(owner ?? null)})`)
  }
  return { count, sample }
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
      tenant:        { type: 'string' },
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
      const requested = typeof values['tenant'] === 'string' && values['tenant'] ? values['tenant'] : null
      const archiveTenant = files.manifestFile ? manifestTenant(validateManifest(JSON.parse(await readFile(files.manifestFile, 'utf8')))) : null
      const mismatch = scopeMismatch(archiveTenant, requested)
      if (mismatch) throw new Error(`Restore refused: ${mismatch}`)
      if (requested) {
        const foreign = await foreignNodesInTenantArchive(files.nodesFile, requested)
        if (foreign.count > 0) throw new Error(`Restore refused: ${foreign.count} nodes of the archive do not belong to tenant "${requested}" (e.g. ${foreign.sample.join('; ')})`)
      }
      if (files.attachmentsTar) log.warn({ file: files.attachmentsTar }, 'Allegati presenti nell\'archivio: NON ripristinati da questo script (estrarli in ATTACHMENT_DIR)')
      if (files.keycloakDir)    log.warn({ dir: files.keycloakDir },     'Export Keycloak presente nell\'archivio: NON ripristinato da questo script (import realm da console/Admin API)')

      const plan = await restorePlan(files.nodesFile)
      const admin = dryRun ? null : getSession(undefined, 'WRITE')
      let tempIndexes: string[] = []
      let nodes: NodeStats
      let rels: RelStats
      try {
        if (admin) tempIndexes = await createRestoreIndexes(admin, plan)
        nodes = await restoreNodes(files.nodesFile, dryRun)
        log.info({ ...nodes, dryRun }, 'Nodi: fatto')
        rels = await restoreRelations(files.relsFile, dryRun)
        log.info({ total: rels.total, restored: rels.restored, unmatched: rels.unmatched, skippedNoId: rels.skippedNoId.length, dryRun }, 'Relazioni: fatto')
      } finally {
        // Also after a failure: no marker and no temporary index stays behind.
        if (admin) {
          await cleanUpRestore(admin, plan.byEid, tempIndexes)
          await admin.close()
        }
      }

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
