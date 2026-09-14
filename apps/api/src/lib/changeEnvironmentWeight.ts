/**
 * Il **peso dell'ambiente** nel punteggio di un compito di assessment della
 * change, come dato del cliente.
 *
 * ## Il difetto (giro nel browser del 14 set 2026, #32)
 * `ENV_WEIGHT = 5` era scritto in `change/scoring.ts`, contro il peso 1 di
 * ogni domanda. Con una domanda per compito, un CI di produzione (punteggio 3
 * su 3 della matrice `environment_risk`) valeva almeno 83 anche con le
 * risposte migliori: visto dal vivo, risposte migliori → 89, rischio alto.
 * Ogni change in produzione finiva sempre ad alto rischio, e quanto debba
 * pesare l'ambiente rispetto alle domande è una scelta di chi valuta, non del
 * codice.
 *
 * ## La regola
 * `Tenant.change_environment_weight`, intero 0..20. Zero toglie l'ambiente dal
 * punteggio (conta solo il questionario). La proprietà assente è il valore di
 * fabbrica — quello di prima, 5 — e la migrazione `20260924_1050` lo scrive
 * esplicito, così il primo giorno non cambia nessun punteggio.
 */
import { getSession } from '@opengraphity/neo4j'
import { ValidationError } from './errors.js'
import { createMetamodelCache } from './metamodelCache.js'
import { invalidateSchema } from './schemaInvalidator.js'

/** Il peso che il codice usava. */
export const FACTORY_ENVIRONMENT_WEIGHT = 5
export const MAX_ENVIRONMENT_WEIGHT = 20

export interface EnvironmentWeight { weight: number; isDefault: boolean }

const cache = createMetamodelCache<EnvironmentWeight>({
  name: 'change-environment-weight',
  load: (tenantId) => loadWeight(tenantId),
})

/** Solo per i test. */
export function clearEnvironmentWeightCache(): void { cache.clear() }

export async function changeEnvironmentWeight(tenantId: string): Promise<EnvironmentWeight> {
  return cache.get(tenantId)
}

function assertWeight(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_ENVIRONMENT_WEIGHT) {
    throw new ValidationError(
      `${where}: the environment weight must be an integer between 0 and ${String(MAX_ENVIRONMENT_WEIGHT)} (got ${String(value)})`,
      { key: 'errors.environmentWeight.range', params: { max: MAX_ENVIRONMENT_WEIGHT, got: String(value) } },
    )
  }
  return value
}

async function loadWeight(tenantId: string): Promise<EnvironmentWeight> {
  const session = getSession()
  try {
    const r = await session.executeRead((tx) =>
      tx.run('MATCH (t:Tenant {id: $tenantId}) RETURN t.change_environment_weight AS raw', { tenantId }),
    )
    if (!r.records.length) throw new Error(`Tenant ${tenantId} does not exist: the environment weight cannot be determined`)
    const raw: unknown = r.records[0].get('raw')
    if (raw == null) return { weight: FACTORY_ENVIRONMENT_WEIGHT, isDefault: true }
    const n = typeof raw === 'object' && raw !== null && 'toNumber' in raw ? (raw as { toNumber(): number }).toNumber() : raw
    return { weight: assertWeight(n, `Tenant ${tenantId}`), isDefault: false }
  } finally {
    await session.close()
  }
}

export async function setChangeEnvironmentWeight(tenantId: string, weight: number): Promise<EnvironmentWeight> {
  assertWeight(weight, 'updateChangeEnvironmentWeight')
  const session = getSession()
  try {
    const r = await session.executeWrite((tx) =>
      tx.run(
        `MATCH (t:Tenant {id: $tenantId})
         SET t.change_environment_weight = $weight, t.updated_at = $now
         RETURN t.id AS id`,
        { tenantId, weight, now: new Date().toISOString() },
      ),
    )
    if (!r.records.length) throw new ValidationError(`Tenant ${tenantId} does not exist`, { key: 'errors.notFound', params: { entity: 'Tenant', id: tenantId } })
    // La leva unica: svuota le cache di questo processo e lo dice agli altri.
    invalidateSchema(tenantId)
    return { weight, isDefault: false }
  } finally {
    await session.close()
  }
}
