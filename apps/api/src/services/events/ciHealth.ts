/**
 * Salute del CI dagli allarmi (Event Management).
 *
 * Il monitoraggio scrive SOLO `ci.health` (operational/degraded/down),
 * `ci.health_source` e `ci.last_event_at`; non tocca mai `ci.status`, che è
 * il ciclo di vita del CI (il vocabolario `ci_status` del cliente).
 *
 * `deriveCIHealth` (pura) e il CASE Cypher di `recomputeCIHealth` leggono
 * la stessa matrice `ci_health` del cliente: la funzione documenta e testa la
 * semantica, il Cypher la applica in UNA query (M11: prima erano lettura +
 * scrittura con la decisione in TypeScript, due round trip per evento).
 */
import { getSession, runQueryOne } from '@opengraphity/neo4j'
import type { CIHealth, CIHealthChangedPayload } from '@opengraphity/types'
import { publishEvent } from '../../lib/publishEvent.js'
import { resolveCILifecycleSemantics } from '../../lib/ciLifecycle.js'
import { DOMAIN_MATRIX_KINDS, loadDomainMatrix } from '../../lib/domainMatrix.js'
import { ValidationError } from '../../lib/errors.js'

/**
 * La scala della salute, dal migliore al peggiore: fra gli allarmi firing vince
 * la salute peggiore. Un evento `flapping` (qualunque severità) vale
 * FLAPPING_HEALTH: è instabilità, non un guasto pieno.
 *
 * Quale severità vale quale salute è la matrice di dominio `ci_health` del
 * cliente (revisione del 14 set 2026 · EV-3): prima era `CI_HEALTH_RULES`, con
 * `critical` → down e `warning` → degraded scritti nel codice, e un cliente
 * che rinominava le severità degli allarmi lasciava i CI sempre «operational».
 */
export const CI_HEALTH_SCALE = DOMAIN_MATRIX_KINDS.ci_health.scale
export const FLAPPING_HEALTH: CIHealth = 'degraded'
const HEALTHY: CIHealth = 'operational'

function unmappedError(tenantId: string, severities: readonly string[]): ValidationError {
  const combination = severities.map((s) => `event_severity="${s}"`).join(', ')
  return new ValidationError(
    `Matrix "ci_health" of tenant ${tenantId}: no CI health for ${combination}. Complete the matrix in Data model → Domain matrices.`,
    { key: 'errors.matrix.noValue', params: { matrix: 'ci_health', combination } },
  )
}

/** La salute dagli allarmi, con la matrice del cliente. Pura: documenta la semantica del Cypher. */
export function deriveCIHealth(
  firingSeverities: readonly string[], flapping: boolean, healthBySeverity: Readonly<Record<string, string>>, tenantId = '',
): CIHealth {
  const unmapped = firingSeverities.filter((s) => healthBySeverity[s] === undefined)
  if (unmapped.length) throw unmappedError(tenantId, unmapped)
  const healths = firingSeverities.map((s) => healthBySeverity[s]!)
  for (const level of [...CI_HEALTH_SCALE].reverse()) {
    if (level === HEALTHY) break
    if (healths.includes(level) || (flapping && level === FLAPPING_HEALTH)) return level as CIHealth
  }
  return HEALTHY
}

/** CASE Cypher equivalente a deriveCIHealth: `severities` è una lista, `flapping` un booleano, la matrice è `$healthBySeverity`. */
export function ciHealthCaseCypher(severities: string, flapping: string): string {
  const whens = [...CI_HEALTH_SCALE].reverse().filter((h) => h !== HEALTHY).map((h) =>
    `WHEN any(s IN ${severities} WHERE $healthBySeverity[s] = '${h}')${h === FLAPPING_HEALTH ? ` OR ${flapping}` : ''} THEN '${h}'`)
  return `CASE ${whens.join(' ')} ELSE '${HEALTHY}' END`
}

interface HealthRow { rule: 'manual' | 'maintenance' | 'monitoring'; previous: string | null; health: string | null; changed: boolean; name: string | null; unmapped?: string[] }

/**
 * Ricalcola `health` del CI dagli eventi firing in una sola query. Non tocca
 * un CI con `health_source = 'manual'` né la salute di uno il cui ciclo di
 * vita è «in manutenzione» per QUESTO cliente (ondata 7 · C-4: la lista arriva
 * dalla semantica del tenant e viaggia come parametro `$maintenanceStatuses`;
 * prima `'maintenance'` era un letterale nel Cypher, e un cliente che
 * rinominava lo stato tornava a farsi aggiornare la salute dagli allarmi su un
 * CI in manutenzione, in silenzio). Scrive `health_source =
 * 'monitoring'` e `last_event_at`; se la salute cambia scrive `health_since =
 * now` (a salute invariata non va toccata) e pubblica `ci.health_changed`.
 * In manutenzione `health_source` deve esistere se esiste `health` (I-9):
 * dopo `setCIHealthOverride(null)` il REMOVE lo aveva tolto e il CI restava
 * con `health` senza origine, uno stato che il contratto (`monitoring |
 * manual`) non prevede — si ripristina senza toccare `health`.
 * Restituisce la salute finale (null = CI inesistente).
 */
export async function recomputeCIHealth(tenantId: string, ciId: string, actorId: string): Promise<string | null> {
  const now = new Date().toISOString()
  const [lifecycle, healthMatrix] = await Promise.all([resolveCILifecycleSemantics(tenantId), loadDomainMatrix(tenantId, 'ci_health')])
  const maintenanceStatuses = [...lifecycle.maintenance]
  const healthBySeverity = healthMatrix.entries
  const session = getSession(undefined, 'WRITE')
  try {
    const row = await runQueryOne<HealthRow>(session, `
      MATCH (ci:ConfigurationItem {id: $ciId, tenant_id: $tenantId})
      OPTIONAL MATCH (e:Event {tenant_id: $tenantId, status: 'firing'})-[:RAISED_ON]->(ci)
      WITH ci, collect(DISTINCT e.severity) AS severities
      OPTIONAL MATCH (f:Event {tenant_id: $tenantId, status: 'flapping'})-[:RAISED_ON]->(ci)
      WITH ci, severities, count(f) > 0 AS flapping, ci.status AS status, ci.health AS previous, ci.health_source AS healthSource
      WITH ci, previous, healthSource,
           ${ciHealthCaseCypher('severities', 'flapping')} AS derived,
           [s IN severities WHERE $healthBySeverity[s] IS NULL] AS unmapped,
           CASE WHEN healthSource = 'manual' THEN 'manual' WHEN status IN $maintenanceStatuses THEN 'maintenance' ELSE 'monitoring' END AS rule
      WITH ci, previous, healthSource, derived, unmapped, rule,
           (rule = 'monitoring' AND size(unmapped) = 0 AND (previous IS NULL OR previous <> derived)) AS changed
      FOREACH (_ IN CASE WHEN rule = 'monitoring' AND size(unmapped) = 0 THEN [1] ELSE [] END |
        SET ci.health = derived, ci.health_source = 'monitoring', ci.last_event_at = $now, ci.updated_at = $now,
            ci.health_since = CASE WHEN changed THEN $now ELSE ci.health_since END
      )
      FOREACH (_ IN CASE WHEN rule = 'maintenance' AND previous IS NOT NULL AND healthSource IS NULL THEN [1] ELSE [] END |
        SET ci.health_source = 'monitoring', ci.updated_at = $now
      )
      RETURN rule, previous, CASE WHEN rule = 'monitoring' THEN derived ELSE previous END AS health, changed, ci.name AS name, unmapped
    `, { tenantId, ciId, now, maintenanceStatuses, healthBySeverity })
    if (!row) return null
    // Una severità firing che la matrice non conosce: la query non ha scritto
    // niente, e si dice quale manca invece di lasciare il CI «operational».
    if (row.rule === 'monitoring' && row.unmapped?.length) throw unmappedError(tenantId, row.unmapped)
    if (row.changed) {
      const payload: CIHealthChangedPayload = {
        id: ciId, ci_id: ciId, name: String(row.name ?? ciId),
        previous_health: (row.previous as CIHealth | null) ?? null,
        new_health: row.health as CIHealth,
      }
      await publishEvent('ci.health_changed', tenantId, actorId, payload, now)
    }
    return row.health
  } finally {
    await session.close()
  }
}
