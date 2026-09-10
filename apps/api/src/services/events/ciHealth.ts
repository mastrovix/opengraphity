/**
 * Salute del CI dagli allarmi (Event Management).
 *
 * Il monitoraggio scrive SOLO `ci.health` (operational/degraded/down),
 * `ci.health_source` e `ci.last_event_at`; non tocca mai `ci.status`, che è
 * il ciclo di vita del CI (active/inactive/maintenance/decommissioned).
 *
 * `deriveCIHealth` (pura) e il CASE Cypher di `recomputeCIHealth` nascono
 * dalla stessa tabella CI_HEALTH_RULES: la funzione documenta e testa la
 * semantica, il Cypher la applica in UNA query (M11: prima erano lettura +
 * scrittura con la decisione in TypeScript, due round trip per evento).
 */
import { getSession, runQueryOne } from '@opengraphity/neo4j'
import type { CIHealth, CIHealthChangedPayload } from '@opengraphity/types'
import { publishEvent } from '../../lib/publishEvent.js'

/**
 * Severità degli eventi firing → salute, in ordine di gravità: vince la prima
 * riga che combacia. Un evento `flapping` (qualunque severità) vale
 * FLAPPING_HEALTH: è instabilità, non un guasto pieno.
 */
export const CI_HEALTH_RULES: readonly { severity: string; health: CIHealth }[] = [
  { severity: 'critical', health: 'down' },
  { severity: 'warning',  health: 'degraded' },
]
export const FLAPPING_HEALTH: CIHealth = 'degraded'

export function deriveCIHealth(firingSeverities: readonly string[], flapping = false): CIHealth {
  for (const rule of CI_HEALTH_RULES) if (firingSeverities.includes(rule.severity)) return rule.health
  if (flapping) return FLAPPING_HEALTH
  return 'operational'
}

/** CASE Cypher equivalente a deriveCIHealth: `severities` è una lista, `flapping` un booleano. */
export function ciHealthCaseCypher(severities: string, flapping: string): string {
  const whens = CI_HEALTH_RULES.map((r) => `WHEN '${r.severity}' IN ${severities}${r.health === FLAPPING_HEALTH ? ` OR ${flapping}` : ''} THEN '${r.health}'`)
  return `CASE ${whens.join(' ')} ELSE 'operational' END`
}

interface HealthRow { rule: 'manual' | 'maintenance' | 'monitoring'; previous: string | null; health: string | null; changed: boolean }

/**
 * Ricalcola `health` del CI dagli eventi firing in una sola query. Non tocca
 * un CI con `health_source = 'manual'` né la salute di uno con
 * `status = 'maintenance'` (ciclo di vita). Scrive `health_source =
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
           CASE WHEN healthSource = 'manual' THEN 'manual' WHEN status = 'maintenance' THEN 'maintenance' ELSE 'monitoring' END AS rule
      WITH ci, previous, healthSource, derived, rule, (rule = 'monitoring' AND (previous IS NULL OR previous <> derived)) AS changed
      FOREACH (_ IN CASE WHEN rule = 'monitoring' THEN [1] ELSE [] END |
        SET ci.health = derived, ci.health_source = 'monitoring', ci.last_event_at = $now, ci.updated_at = $now,
            ci.health_since = CASE WHEN changed THEN $now ELSE ci.health_since END
      )
      FOREACH (_ IN CASE WHEN rule = 'maintenance' AND previous IS NOT NULL AND healthSource IS NULL THEN [1] ELSE [] END |
        SET ci.health_source = 'monitoring', ci.updated_at = $now
      )
      RETURN rule, previous, CASE WHEN rule = 'monitoring' THEN derived ELSE previous END AS health, changed
    `, { tenantId, ciId, now })
    if (!row) return null
    if (row.changed) {
      const payload: CIHealthChangedPayload = {
        id: ciId, ci_id: ciId,
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
