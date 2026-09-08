/**
 * Runner CLI delle migrazioni versionate (packages/neo4j migrations.ts +
 * scripts/migrations/index.ts).
 *
 *   migrate                       applica le migrazioni pendenti, in ordine
 *   migrate --status              stato di ogni migrazione (applicata quando / pendente / drift / sconosciuta)
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
