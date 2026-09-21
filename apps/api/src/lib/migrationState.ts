/**
 * LE MIGRAZIONI NON APPLICATE, sapute dal prodotto (revisione del 14 set 2026 ·
 * F8).
 *
 * Un deploy senza `migrate` girava con schema e dati non allineati, in
 * silenzio: nessun controllo all'avvio né in /health. Qui c'è la lettura, che
 * usano tre posti:
 *   - `/health` risponde «degraded» (503) finché ce ne sono;
 *   - la diagnostica le mostra all'admin nel banner (`migrations_pending`);
 *   - l'avvio le scrive nei log, e con `REQUIRE_APPLIED_MIGRATIONS=true` si
 *     ferma.
 *
 * Perché l'avvio non si ferma per default: la ricetta di deploy lancia le
 * migrazioni DENTRO il container dell'API (`docker exec … migrate.js`). Un'API
 * che non parte renderebbe impossibile applicarle. Chi le lancia in un passo
 * separato (un job di deploy) accende la variabile e ottiene il blocco.
 */
import { getSession, listMigrationStatus } from '@opengraphity/neo4j'
import { MIGRATIONS } from '../scripts/migrations/index.js'

const TTL_MS = 60_000
let cached: { ids: string[]; expires: number } | null = null

export function clearMigrationStateCache(): void {
  cached = null
}

/** Gli id delle migrazioni del codice non ancora applicate, in ordine. */
export async function pendingMigrations(nowMs: number = Date.now()): Promise<string[]> {
  if (cached && cached.expires > nowMs) return cached.ids
  const session = getSession()
  try {
    const rows = await listMigrationStatus(session, MIGRATIONS)
    const ids = rows.filter((r) => !r.unknown && !r.appliedAt).map((r) => r.id)
    cached = { ids, expires: nowMs + TTL_MS }
    return ids
  } finally {
    await session.close()
  }
}

interface BootLog { error: (obj: object, msg: string) => void; info: (obj: object, msg: string) => void }

/** Controllo all'avvio: log sempre, blocco solo se richiesto. Ritorna le pendenti. */
export async function assertMigrationsAppliedAtBoot(opts: { require: boolean; log: BootLog }): Promise<string[]> {
  const pending = await pendingMigrations()
  if (pending.length === 0) {
    opts.log.info({ migrations: MIGRATIONS.length }, 'All migrations applied')
    return pending
  }
  opts.log.error({ pending }, `${pending.length} migrations pending: run migrate.js (the API is serving with a schema that does not match the code)`)
  if (opts.require) {
    throw new Error(`REQUIRE_APPLIED_MIGRATIONS=true and ${pending.length} migrations are pending: ${pending.join(', ')}`)
  }
  return pending
}
