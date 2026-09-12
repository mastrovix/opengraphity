/**
 * Runner CLI delle migrazioni versionate (packages/neo4j migrations.ts +
 * scripts/migrations/index.ts).
 *
 *   migrate                       applica le migrazioni pendenti, in ordine
 *   migrate --status              stato di ogni migrazione (applicata quando / pendente / drift / sconosciuta)
 *                                 + i tenant INCOMPLETI (D-14): un tenant nato da una migrazione
 *                                   ha il nodo :Tenant e non ha workflow, e il sintomo arriva solo
 *                                   al primo createIncident. La migrazione 20260918_1910 li completa.
 *   migrate --dry-run             elenca cosa verrebbe applicato, senza lock né scritture
 *   migrate --to <id>             applica fino a <id> incluso
 *   migrate --init-schema         prima constraint/indici/counter (initSchema di packages/neo4j), poi le migrazioni
 *   migrate --force               riapplica anche le migrazioni già applicate (devono essere idempotenti)
 *
 * Uso: pnpm --filter @opengraphity/api exec tsx --env-file=.env src/scripts/migrate.ts [opzioni]
 * Exit ≠ 0 alla prima migrazione fallita (con il suo id) o se il lock è occupato.
 */
import { parseArgs }  from 'node:util'
import { getSession, initSchema, listMigrationStatus, runMigrations } from '@opengraphity/neo4j'
import { MIGRATIONS } from './migrations/index.js'
import { SHARED_TENANT_ID } from './migrations/20260918_1910_provision_tenant_data.js'
import { tenantProvisioningGaps } from '../lib/provisionTenantData.js'
import { runScript }  from './lib/runScript.js'

const { values } = parseArgs({
  options: {
    status:        { type: 'boolean', default: false },
    'dry-run':     { type: 'boolean', default: false },
    to:            { type: 'string' },
    'init-schema': { type: 'boolean', default: false },
    force:         { type: 'boolean', default: false },
  },
})

runScript('migrate', async () => {
  if (values['init-schema']) {
    if (values.status || values['dry-run']) throw new Error('--init-schema non è combinabile con --status/--dry-run')
    await initSchema({ migrations: MIGRATIONS })
    return
  }

  const session = getSession(undefined, 'WRITE')
  try {
    if (values.status) {
      const rows = await listMigrationStatus(session, MIGRATIONS)
      for (const r of rows) {
        const state = r.unknown ? 'SCONOSCIUTA (non nel codice)' : r.appliedAt ? `applicata ${r.appliedAt}` : 'pendente'
        const drift = r.checksumDrift ? '  [codice cambiato dopo l\'applicazione]' : ''
        console.log(`${r.id}  ${state}${drift}\n    ${r.description ?? ''}`)
      }
      console.log(`\n${rows.filter((r) => !r.appliedAt).length} pendenti, ${rows.filter((r) => r.appliedAt && !r.unknown).length} applicate`)
      await printIncompleteTenants(session)
      return
    }

    const res = await runMigrations(MIGRATIONS, {
      session,
      dryRun: values['dry-run'],
      force:  values.force,
      ...(values.to !== undefined ? { to: values.to } : {}),
    })
    console.log(`\nApplicate: ${res.applied.length}  Già applicate: ${res.skipped.length}  Pendenti: ${res.pending.length}`)
  } finally {
    await session.close()
  }
})

/**
 * I tenant che esistono ma non possono funzionare (D-14). `c-two` era in questo
 * stato da giorni — 0 `WorkflowDefinition` — e non c'era nessun modo di
 * accorgersene prima del primo ticket. `--status` lo dice.
 */
async function printIncompleteTenants(session: Parameters<typeof tenantProvisioningGaps>[0]): Promise<void> {
  const r = await session.run(`
    MATCH (t:Tenant)
    WHERE t.id IS NOT NULL AND t.id <> $shared
    RETURN t.id AS id ORDER BY t.id
  `, { shared: SHARED_TENANT_ID })
  const incomplete: Array<[string, string[]]> = []
  for (const record of r.records) {
    const tenantId = String(record.get('id'))
    const gaps = await tenantProvisioningGaps(session, tenantId)
    if (gaps.length > 0) incomplete.push([tenantId, gaps])
  }
  if (incomplete.length === 0) {
    console.log(`\n${r.records.length} tenant, tutti completi (dashboard, regole di notifica, matrici, workflow).`)
    return
  }
  console.log(`\n${incomplete.length} tenant INCOMPLETI su ${r.records.length}:`)
  for (const [tenantId, gaps] of incomplete) console.log(`  ${tenantId}: ${gaps.join(' · ')}`)
  console.log(`  → li completa la migrazione 20260918_1910_provision_tenant_data (idempotente, additiva).`)
}
