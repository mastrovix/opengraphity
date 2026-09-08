/**
 * Verifica di un archivio di backup (Ondata 4): apre il tar.gz, valida
 * manifest e JSONL (righe parseabili, forma delle righe, conteggi per label e
 * per tipo coerenti col manifest), controlla allegati e realm Keycloak
 * dichiarati, esegue il restore in `--dry-run` in-process (stesse funzioni di
 * restore-neo4j: label/tipi validati, piano dei MERGE) e stampa un riepilogo.
 *
 * Exit ≠ 0 su qualsiasi incoerenza. Le relazioni fra nodi senza `id` (non
 * ricostruibili dal restore) sono riportate come AVVISO: sono una proprietà
 * dei dati, non un difetto dell'archivio.
 *
 * Usato dal maintenance worker dopo ogni backup schedulato e a mano:
 *   pnpm --filter @opengraphity/api exec tsx --env-file=.env src/scripts/verify-backup.ts --input ./backups/backup_<stamp>.tar.gz
 *
 * Richiede il driver Neo4j importabile (il pacchetto apre la connessione
 * all'import): eseguirlo dove NEO4J_* puntano allo stack.
 */
import { parseArgs, promisify }      from 'node:util'
import { execFile }                  from 'node:child_process'
import { readFile, readdir, rm }     from 'node:fs/promises'
import { basename, join, resolve }   from 'node:path'
import { pathToFileURL }             from 'node:url'
import { runScript }                 from './lib/runScript.js'
import { validateManifest, tallyNodes, tallyRels, compareCounts, type BackupManifest } from './lib/backupManifest.js'
import { extractArchive, locateBackupFiles, restoreNodes, restoreRelations, summarizeSkipped } from './restore-neo4j.js'

const execFileAsync = promisify(execFile)

export interface VerifyReport {
  archivePath: string
  ok: boolean
  /** Incoerenze: l'archivio NON è affidabile. */
  problems: string[]
  /** Avvisi: l'archivio è coerente, ma il restore avrà dei limiti. */
  warnings: string[]
  manifest: BackupManifest | null
  nodes: number
  rels: number
  /** Relazioni ricostruibili dal restore (dry-run). */
  restorableRels: number
}

export async function verifyBackup(archivePath: string): Promise<VerifyReport> {
  const report: VerifyReport = { archivePath, ok: false, problems: [], warnings: [], manifest: null, nodes: 0, rels: 0, restorableRels: 0 }
  const tmpDir = await extractArchive(archivePath)
  try {
    const files = await locateBackupFiles(tmpDir)
    if (!files.manifestFile) {
      report.problems.push('archivio legacy senza manifest.json: non verificabile (rifare il backup con la versione corrente)')
      return report
    }

    // 1. manifest
    let manifest: BackupManifest
    try {
      manifest = validateManifest(JSON.parse(await readFile(files.manifestFile, 'utf8')))
    } catch (err) {
      report.problems.push((err as Error).message)
      return report
    }
    report.manifest = manifest

    // 2. JSONL: parse + shape + counts
    try {
      const nodes = await tallyNodes(files.nodesFile)
      report.nodes = nodes.count
      if (nodes.count !== manifest.node_count) report.problems.push(`nodes.jsonl: ${nodes.count} righe, manifest node_count ${manifest.node_count}`)
      report.problems.push(...compareCounts('label', manifest.nodes_by_label, nodes.byKey))
    } catch (err) { report.problems.push((err as Error).message) }
    try {
      const rels = await tallyRels(files.relsFile)
      report.rels = rels.count
      if (rels.count !== manifest.rel_count) report.problems.push(`rels.jsonl: ${rels.count} righe, manifest rel_count ${manifest.rel_count}`)
      report.problems.push(...compareCounts('relationship type', manifest.rels_by_type, rels.byKey))
    } catch (err) { report.problems.push((err as Error).message) }

    // 3. attachments
    if (manifest.attachments.included) {
      if (!files.attachmentsTar) report.problems.push('manifest dichiara gli allegati ma attachments.tar manca')
      else {
        try {
          const { stdout } = await execFileAsync('tar', ['-tf', files.attachmentsTar], { maxBuffer: 64 * 1024 * 1024 })
          const fileEntries = stdout.split('\n').filter((l) => l && !l.endsWith('/')).length
          if (fileEntries !== manifest.attachments.file_count) {
            report.problems.push(`attachments.tar: ${fileEntries} file, manifest file_count ${manifest.attachments.file_count}`)
          }
        } catch (err) { report.problems.push(`attachments.tar illeggibile: ${(err as Error).message}`) }
      }
    } else {
      report.warnings.push(`allegati non inclusi (${manifest.attachments.reason ?? 'motivo non indicato'})`)
    }

    // 4. keycloak
    if (manifest.keycloak.included) {
      if (manifest.keycloak.realms.length > 0 && !files.keycloakDir) report.problems.push('manifest dichiara i realm Keycloak ma la directory keycloak/ manca')
      else if (files.keycloakDir) {
        const present = new Set((await readdir(files.keycloakDir)).map((f) => basename(f, '.json')))
        for (const realm of manifest.keycloak.realms) {
          if (!present.has(realm)) { report.problems.push(`keycloak/${realm}.json mancante`); continue }
          try {
            const body = JSON.parse(await readFile(join(files.keycloakDir, `${realm}.json`), 'utf8')) as { realm?: unknown }
            if (body.realm !== realm) report.problems.push(`keycloak/${realm}.json: realm ${JSON.stringify(body.realm)} invece di "${realm}"`)
          } catch (err) { report.problems.push(`keycloak/${realm}.json non parseabile: ${(err as Error).message}`) }
        }
      }
    } else {
      report.warnings.push(`realm Keycloak non inclusi (${manifest.keycloak.reason ?? 'motivo non indicato'})`)
    }

    // 5. restore dry-run in-process (stesse funzioni dello script di restore)
    if (report.problems.length === 0) {
      try {
        await restoreNodes(files.nodesFile, true)
        const rels = await restoreRelations(files.relsFile, true)
        report.restorableRels = rels.restored
        if (rels.skippedNoId.length) {
          report.warnings.push(`${rels.skippedNoId.length} relazioni fra nodi senza id non ricostruibili dal restore: ${summarizeSkipped(rels.skippedNoId)}`)
        }
      } catch (err) { report.problems.push(`restore --dry-run fallito: ${(err as Error).message}`) }
    }

    report.ok = report.problems.length === 0
    return report
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
}

export function formatReport(r: VerifyReport): string {
  const m = r.manifest
  const lines = [
    `Archivio: ${r.archivePath}`,
    m ? `Creato: ${m.created_at} — app ${m.app_version}, Neo4j ${m.neo4j_version ?? '?'}` : 'Manifest: assente/invalido',
    `Nodi: ${r.nodes}${m ? ` (${Object.keys(m.nodes_by_label).length} label)` : ''}`,
    `Relazioni: ${r.rels}${m ? ` (${Object.keys(m.rels_by_type).length} tipi)` : ''}, ricostruibili dal restore: ${r.restorableRels}`,
    m ? `Schema: ${m.constraints.length} constraint, ${m.indexes.length} indici` : '',
    m ? `Allegati: ${m.attachments.included ? `${m.attachments.file_count} file, ${m.attachments.total_bytes} byte` : 'non inclusi'}` : '',
    m ? `Keycloak: ${m.keycloak.included ? `${m.keycloak.realms.length} realm (${m.keycloak.realms.join(', ')})` : 'non incluso'}` : '',
    ...r.warnings.map((w) => `AVVISO: ${w}`),
    ...r.problems.map((p) => `ERRORE: ${p}`),
    r.ok ? 'Esito: OK' : 'Esito: ARCHIVIO NON AFFIDABILE',
  ]
  return lines.filter((l) => l !== '').join('\n')
}

// ── CLI ───────────────────────────────────────────────────────────────────────

const isDirectRun = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href

if (isDirectRun) {
  const { values } = parseArgs({ options: { input: { type: 'string', short: 'i' } }, strict: false })
  runScript('verify-backup', async () => {
    const input = values['input']
    if (typeof input !== 'string' || !input) throw new Error('--input <archivio.tar.gz> è obbligatorio')
    const report = await verifyBackup(resolve(input))
    console.log(formatReport(report))
    if (!report.ok) throw new Error(`verifica fallita: ${report.problems.length} incoerenza/e`)
  })
}
