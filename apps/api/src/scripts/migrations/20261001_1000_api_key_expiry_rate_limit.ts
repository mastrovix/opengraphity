/**
 * Revisione totale del 16 set 2026 · G-1/A-6: le chiavi API già scritte
 * riallineate alla regola di `lib/apiKeyInput.ts`.
 *  - `expires_at = ''` (il form mandava la stringa vuota) → NULL: erano chiavi
 *    senza scadenza che non funzionavano mai;
 *  - `expires_at = 'AAAA-MM-GG'` → l'istante UTC della fine di quel giorno nel
 *    fuso dell'organizzazione (prima scadevano alle 00:00 UTC del giorno);
 *  - `rate_limit` assente → 60, il valore che l'autenticazione usava in silenzio
 *    per quelle chiavi: ora è scritto e visibile nella pagina.
 * Un valore di scadenza che non si legge fa fallire la migrazione nominando la
 * chiave: toglierlo aprirebbe una chiave che qualcuno voleva scaduta.
 * Idempotente: dopo il primo giro non ci sono più valori da convertire.
 */
import type { Migration } from '@opengraphity/neo4j'
import { normalizeApiKeyExpiry } from '../../lib/apiKeyInput.js'

const LEGACY_RATE_LIMIT = 60

export const apiKeyExpiryRateLimit: Migration = {
  id:          '20261001_1000_api_key_expiry_rate_limit',
  description: 'Chiavi API: scadenza vuota → nessuna scadenza, data → fine del giorno nel fuso del tenant, limite al minuto scritto',

  async up(session) {
    const empty = await session.run(`MATCH (k:ApiKey) WHERE k.expires_at = '' SET k.expires_at = null RETURN count(k) AS n`)
    const rates = await session.run(`MATCH (k:ApiKey) WHERE k.rate_limit IS NULL SET k.rate_limit = $rate RETURN count(k) AS n`, { rate: LEGACY_RATE_LIMIT })

    const rows = await session.run(`
      MATCH (k:ApiKey) WHERE k.expires_at IS NOT NULL AND NOT k.expires_at =~ '^\\\\d{4}-\\\\d{2}-\\\\d{2}T\\\\d{2}:\\\\d{2}:\\\\d{2}\\\\.\\\\d{3}Z$'
      OPTIONAL MATCH (t:Tenant {id: k.tenant_id})
      RETURN k.id AS id, k.tenant_id AS tenantId, k.expires_at AS expiresAt, t.timezone AS timezone`)
    let converted = 0
    for (const r of rows.records) {
      const id = r.get('id') as string
      let iso: string | null
      try {
        iso = normalizeApiKeyExpiry(r.get('expiresAt'), (r.get('timezone') as string | null) ?? null)
      } catch (err) {
        throw new Error(`ApiKey ${id} (tenant ${String(r.get('tenantId'))}): expires_at ${JSON.stringify(r.get('expiresAt'))} cannot be converted — ${err instanceof Error ? err.message : String(err)}`)
      }
      await session.run('MATCH (k:ApiKey {id: $id}) SET k.expires_at = $iso', { id, iso })
      converted++
    }
    console.log(`[${apiKeyExpiryRateLimit.id}] scadenze vuote: ${String(empty.records[0]?.get('n'))}, date convertite: ${converted}, limiti scritti: ${String(rates.records[0]?.get('n'))}`)
  },
}
