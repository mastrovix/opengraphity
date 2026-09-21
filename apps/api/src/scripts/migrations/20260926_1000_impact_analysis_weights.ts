/**
 * Verifica «Cosa resta cablato», ondata 5: i pesi dell'analisi d'impatto della
 * change diventano dato del cliente (`Tenant.impact_analysis_weights`,
 * lib/impactWeights.ts). Qui si scrivono espliciti i valori che il codice usava
 * (×20, ×10 fino a 40, ×15, ×10, ×5; finestre di 60 e 30 giorni), così nessun
 * punteggio cambia il primo giorno. Pesi già scelti non si toccano. Idempotente.
 */
import type { Migration } from '@opengraphity/neo4j'
import { FACTORY_IMPACT_WEIGHTS } from '../../lib/impactWeights.js'

export const impactAnalysisWeightsSeed: Migration = {
  id: '20260926_1000_impact_analysis_weights',
  description: 'Tenant.impact_analysis_weights: i pesi dell\'analisi d\'impatto diventano configurabili, seminati con quelli di prima',
  async up(session) {
    const r = await session.run(`
      MATCH (t:Tenant) WHERE t.impact_analysis_weights IS NULL
      SET t.impact_analysis_weights = $json, t.updated_at = $now
      RETURN collect(t.id) AS tenants
    `, { json: JSON.stringify(FACTORY_IMPACT_WEIGHTS), now: new Date().toISOString() })
    const tenants = (r.records[0]?.get('tenants') as string[] | undefined) ?? []
    console.log(`[${impactAnalysisWeightsSeed.id}] pesi di fabbrica su: ${tenants.length ? tenants.join(', ') : 'nessuno'}`)
  },
}
