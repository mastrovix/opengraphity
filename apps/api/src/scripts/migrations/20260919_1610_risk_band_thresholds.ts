/**
 * Rimedio 3 — le **soglie** delle fasce di rischio diventano dato del cliente
 * (revisione delle otto ondate · C·N-2; e l'aperto n. 7 dell'ondata 7).
 *
 * `riskBandOf` leggeva `bands[0..2]` con le soglie 30 e 60 scritte nel codice:
 * riordinare il vocabolario invertiva le fasce **in silenzio** (e la matrice
 * trovava poi una cella valida, quindi la priorità era plausibile e sbagliata),
 * e una quarta fascia era irraggiungibile — l'admin la compilava nella matrice
 * e credeva che valesse.
 *
 * Questa migrazione scrive sul tenant esattamente le soglie che il codice
 * usava, sui primi tre valori del suo vocabolario `risk_band`: il primo giorno
 * non cambia niente. Idempotente; non tocca un tenant che ha già le sue soglie.
 *
 * Se un tenant ha un vocabolario `risk_band` che non ha tre valori, non si
 * inventa una divisione del punteggio: si dice, e la creazione di una change
 * per quel tenant si fermerà dicendo di dichiararle (che è meglio di una
 * priorità sbagliata in silenzio).
 */
import type { Migration } from '@opengraphity/neo4j'
import { factoryThresholdsFor } from '../../lib/riskBands.js'

export const riskBandThresholdsSeed: Migration = {
  id: '20260919_1610_risk_band_thresholds',
  description: 'Tenant.risk_band_thresholds: le soglie del punteggio di rischio diventano dato del cliente, seminate con quelle che il codice usava (30/60/100)',
  async up(session) {
    // Il vocabolario di ogni tenant: il suo se l'ha personalizzato, altrimenti
    // quello spedito (stessa precedenza di `domainVocabulary`).
    const res = await session.run(`
      MATCH (t:Tenant)
      WHERE t.risk_band_thresholds IS NULL
      OPTIONAL MATCH (own:EnumTypeDefinition {tenant_id: t.id, name: 'risk_band'})
      OPTIONAL MATCH (shipped:EnumTypeDefinition {tenant_id: 'system', name: 'risk_band'})
      RETURN t.id AS tenantId, coalesce(own.values, shipped.values) AS values ORDER BY tenantId
    `)

    let seeded = 0
    for (const r of res.records) {
      const tenantId = String(r.get('tenantId'))
      const raw = r.get('values')
      const values = Array.isArray(raw) ? raw.map((v) => String(v)) : []
      const thresholds = factoryThresholdsFor(values)
      if (!thresholds) {
        console.log(
          `[${riskBandThresholdsSeed.id}] ATTENZIONE ${tenantId}: vocabolario risk_band con ${String(values.length)} ` +
          `valori (${values.join(', ') || 'nessuno'}), non tre: non semino soglie di fabbrica. ` +
          `Dichiarale in Impostazioni → Matrici di dominio.`,
        )
        continue
      }
      await session.run(
        'MATCH (t:Tenant {id: $tenantId}) SET t.risk_band_thresholds = $value, t.updated_at = $now',
        { tenantId, value: JSON.stringify(thresholds), now: new Date().toISOString() },
      )
      seeded += 1
      console.log(`[${riskBandThresholdsSeed.id}] ${tenantId}: ${thresholds.map((x) => `${x.band} ≤ ${String(x.upTo)}`).join(', ')}`)
    }
    console.log(`[${riskBandThresholdsSeed.id}] ${String(seeded)} tenant seminati su ${String(res.records.length)} senza soglie.`)
  },
}
