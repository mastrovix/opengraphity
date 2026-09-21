/**
 * I **pesi dell'analisi d'impatto** della change, come dato del cliente
 * (verifica «Cosa resta cablato», ondata 5).
 *
 * ## Il difetto
 * `calculateRiskScore` sommava con pesi scritti nel codice — ×20 per CI in
 * produzione, ×10 per CI nel blast radius (al massimo 40), ×15 per incident
 * aperto, ×10 per change fallita, ×5 per change in corso — e dava il livello
 * con soglie proprie (76/51/26 → critical/high/medium/low). Il livello non
 * aveva niente a che fare con le fasce di rischio che il cliente dichiara in
 * Matrici di dominio, e «produzione» era il letterale `production`, mentre il
 * vocabolario degli ambienti è del cliente.
 *
 * ## La regola
 * `Tenant.impact_analysis_weights`, un JSON con i pesi e le due finestre in
 * giorni. La proprietà assente è il valore di fabbrica — quello di prima — e la
 * migrazione `20260926_1000_impact_analysis_weights` lo scrive esplicito. Il
 * livello è la fascia di rischio del cliente (`riskBandOf`), con il punteggio
 * limitato a 100 come ogni punteggio di rischio. Un «CI in produzione» è un CI
 * il cui ambiente vale il punteggio più alto della matrice `environment_risk`:
 * con la matrice di fabbrica è esattamente `production`.
 */
import { getSession } from '@opengraphity/neo4j'
import {
  IMPACT_WEIGHT_KEYS, IMPACT_WINDOW_KEYS, IMPACT_LIMITS, MAX_IMPACT_WEIGHT, MAX_IMPACT_WINDOW_DAYS,
} from '@opengraphity/types'
import { ValidationError } from './errors.js'
import { createMetamodelCache } from './metamodelCache.js'
import { invalidateSchema } from './schemaInvalidator.js'

// Chiavi e intervalli stanno in @opengraphity/types: li usa anche la pagina
// dell'interfaccia, e due copie a mano derivano (revisione totale · G-25).
export { IMPACT_WEIGHT_KEYS, IMPACT_WINDOW_KEYS, MAX_IMPACT_WEIGHT, MAX_IMPACT_WINDOW_DAYS, IMPACT_LIMITS }
export type ImpactWeightKey = (typeof IMPACT_WEIGHT_KEYS)[number]
export type ImpactWindowKey = (typeof IMPACT_WINDOW_KEYS)[number]
export type ImpactWeightValues = Record<ImpactWeightKey | ImpactWindowKey, number>

export interface ImpactWeights extends ImpactWeightValues { isDefault: boolean }

/** I valori che il codice usava. */
export const FACTORY_IMPACT_WEIGHTS: Readonly<ImpactWeightValues> = {
  productionCI: 20, blastRadiusCI: 10, blastRadiusCap: 40, openIncident: 15, failedChange: 10, ongoingChange: 5,
  recentChangesDays: 60, recentIncidentsDays: 30,
}



const cache = createMetamodelCache<ImpactWeights>({
  name: 'impact-analysis-weights',
  load: (tenantId) => loadWeights(tenantId),
})

/** Solo per i test. */
export function clearImpactWeightsCache(): void { cache.clear() }

export function impactAnalysisWeights(tenantId: string): Promise<ImpactWeights> {
  return cache.get(tenantId)
}

/** Valida un insieme completo di pesi: ogni chiave presente, intera, nel suo intervallo, nessuna chiave in più. */
export function assertImpactWeights(raw: unknown, where: string): ImpactWeightValues {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ValidationError(`${where}: the impact weights must be an object`, { key: 'errors.impactWeights.shape' })
  }
  const obj = raw as Record<string, unknown>
  const known = new Set<string>([...IMPACT_WEIGHT_KEYS, ...IMPACT_WINDOW_KEYS])
  const extra = Object.keys(obj).filter((k) => !known.has(k))
  if (extra.length > 0) {
    throw new ValidationError(`${where}: unknown impact weight(s): ${extra.join(', ')}`, { key: 'errors.impactWeights.unknown', params: { names: extra.join(', ') } })
  }
  const out = {} as ImpactWeightValues
  // G-25: gli intervalli vengono dalla sorgente condivisa, non da numeri qui.
  for (const key of [...IMPACT_WEIGHT_KEYS, ...IMPACT_WINDOW_KEYS]) {
    out[key] = assertInt(obj[key], key, IMPACT_LIMITS[key].min, IMPACT_LIMITS[key].max, where)
  }
  return out
}

function assertInt(value: unknown, name: string, min: number, max: number, where: string): number {
  const n = typeof value === 'object' && value !== null && 'toNumber' in value ? (value as { toNumber(): number }).toNumber() : value
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) {
    throw new ValidationError(
      `${where}: "${name}" must be an integer between ${String(min)} and ${String(max)} (got ${String(n)})`,
      { key: 'errors.impactWeights.range', params: { name, min, max, got: String(n) } },
    )
  }
  return n
}

async function loadWeights(tenantId: string): Promise<ImpactWeights> {
  const session = getSession()
  try {
    const r = await session.executeRead((tx) =>
      tx.run('MATCH (t:Tenant {id: $tenantId}) RETURN t.impact_analysis_weights AS raw', { tenantId }),
    )
    if (!r.records.length) throw new Error(`Tenant ${tenantId} does not exist: the impact weights cannot be determined`)
    const raw: unknown = r.records[0].get('raw')
    if (raw == null) return { ...FACTORY_IMPACT_WEIGHTS, isDefault: true }
    let parsed: unknown
    try { parsed = JSON.parse(String(raw)) }
    catch (e) { throw new Error(`Tenant ${tenantId}: impact_analysis_weights is not valid JSON (${e instanceof Error ? e.message : String(e)})`) }
    return { ...assertImpactWeights(parsed, `Tenant ${tenantId}`), isDefault: false }
  } finally {
    await session.close()
  }
}

export async function setImpactAnalysisWeights(tenantId: string, input: unknown): Promise<ImpactWeights> {
  const values = assertImpactWeights(input, 'updateImpactAnalysisWeights')
  const session = getSession()
  try {
    const r = await session.executeWrite((tx) =>
      tx.run(
        `MATCH (t:Tenant {id: $tenantId})
         SET t.impact_analysis_weights = $json, t.updated_at = $now
         RETURN t.id AS id`,
        { tenantId, json: JSON.stringify(values), now: new Date().toISOString() },
      ),
    )
    if (!r.records.length) throw new ValidationError(`Tenant ${tenantId} does not exist`, { key: 'errors.notFound', params: { entity: 'Tenant', id: tenantId } })
    invalidateSchema(tenantId)
    return { ...values, isDefault: false }
  } finally {
    await session.close()
  }
}
