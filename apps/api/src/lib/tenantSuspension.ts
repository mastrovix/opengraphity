/**
 * IS THE TENANT SUSPENDED? (moved out of auth/resolveAuth.ts on 23 Sep 2026)
 *
 * Suspension shuts the door on every way in, not only the login: since the
 * review of 23 Sep 2026 the API keys, the inbound webhooks and Slack ask too —
 * until then a suspended tenant kept creating incidents through all three.
 *
 * Il tenant è sospeso? Letta a ogni richiesta autenticata, quindi va tenuta
 * ECONOMICA: una proprietà sul nodo `:Tenant`, che è indicizzato per `id`.
 *
 * Nessuna cache: una sospensione serve a chiudere la porta adesso, e un minuto
 * di cache vorrebbe dire un minuto in cui la porta è ancora aperta. Se questa
 * lettura diventasse un costo, la si mette in cache con un TTL di pochi
 * secondi — mai con uno che si misuri in minuti.
 *
 * Un errore di lettura NON apre la porta: si rifiuta. È la scelta severa, ed è
 * quella giusta su un controllo di accesso.
 */
import { getSession } from '@opengraphity/neo4j'

/**
 * `TENANT_SUSPENDED` è definitivo per definizione: non c'è niente che il
 * client possa riprovare. Lo stato resta 401 — l'accesso è negato — ma il
 * codice dice PERCHÉ.
 */
export const TENANT_SUSPENDED = 'TENANT_SUSPENDED'

/** The body a REST route answers with, next to a 401. */
export const TENANT_SUSPENDED_BODY = { error: { code: TENANT_SUSPENDED, message: 'Tenant suspended' } } as const

export async function tenantSospeso(tenantId: string): Promise<boolean> {
  const session = getSession(undefined, 'READ')
  try {
    const result = await session.executeRead((tx) =>
      tx.run('MATCH (t:Tenant {id: $tenantId}) RETURN t.suspended_at AS suspendedAt', { tenantId }))
    const row = result.records[0]
    // Nessun nodo `:Tenant`: non è «non sospeso», è un tenant che non esiste —
    // e chi chiama lo fermerà comunque (utente, chiave o webhook che non trova).
    if (!row) return false
    return row.get('suspendedAt') != null
  } finally {
    await session.close()
  }
}
