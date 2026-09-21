/**
 * Verifica «Cosa resta cablato», ondata 1: il badge del rischio della change
 * legge fascia, etichetta e colore dal cliente (soglie in Matrici di dominio,
 * colore nel Dizionario) invece di tre livelli fissi con una palette propria.
 *
 * Perché il primo giorno non cambi niente, il vocabolario `risk_band` riceve i
 * colori che quella palette aveva (low verde, medium giallo, high rosso): il
 * seme spedito si risemina, e le COPIE dei clienti li ricevono solo per i valori
 * che hanno ancora e solo se non hanno già colori scelti da loro.
 *
 * Idempotente.
 */
import type { Migration } from '@opengraphity/neo4j'
import { seedSystemEnumTypes, SYSTEM_ENUMS } from '../../lib/seedEnumTypes.js'
import { SYSTEM_TENANT } from '../../lib/enumScope.js'

const tag = '[20260925_1000_risk_band_colors]'

export const riskBandColors: Migration = {
  id: '20260925_1000_risk_band_colors',
  description: 'Colori del vocabolario risk_band (verde/giallo/rosso, quelli del badge del rischio)',
  async up(session) {
    await seedSystemEnumTypes(session)
    const colors = SYSTEM_ENUMS.find((e) => e.name === 'risk_band')?.valueColors
    if (!colors) throw new Error(`${tag} the shipped risk_band vocabulary has no colors: the seed and this migration disagree`)
    const r = await session.run(`
      MATCH (c:EnumTypeDefinition {name: 'risk_band'})
      WHERE c.tenant_id <> $systemTenant AND c.value_colors IS NULL
      WITH c, [v IN c.values WHERE v IN keys($colors)] AS colored
      WHERE size(colored) > 0
      SET c.value_colors = apoc.convert.toJson(apoc.map.fromPairs([v IN colored | [v, $colors[v]]])), c.updated_at = $now
      RETURN c.tenant_id AS tenant, size(colored) AS n
    `, { systemTenant: SYSTEM_TENANT, colors, now: new Date().toISOString() })
    for (const row of r.records) console.log(`${tag} ${String(row.get('tenant'))}: risk_band riceve ${String(row.get('n'))} colori`)
  },
}
