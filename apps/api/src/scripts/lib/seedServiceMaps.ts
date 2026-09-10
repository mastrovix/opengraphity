/**
 * Servizi monitorati — logica del seed demo (scripts/seed-service-maps.ts è
 * il runner): una mappa del servizio per ogni BusinessApplication del tenant
 * che non ne ha ancora una, con la costruzione automatica della mutation
 * createServiceMap (profondità e relazioni di default, status active,
 * valutazione immediata con la salute attuale dei CI). Idempotente: le
 * BusinessApplication con mappa vengono saltate, mai ricostruite. Separato
 * dal runner così è testabile senza avviare lo script.
 */
import { getSession, runQuery } from '@opengraphity/neo4j'
import { SERVICE_MAP_DEFAULT_DEPTH, SERVICE_RELATIONSHIP_TYPES } from '../../lib/serviceVocabularies.js'
import { createServiceMap } from '../../services/serviceImpact/engine.js'
import { readOptionValue, resolveTenantArg, ScriptArgError } from './scriptArgs.js'

export const SEED_ACTOR = 'seed-service-maps'

export interface SeedServiceMapsOptions {
  tenantId:          string
  maxDepth:          number
  relationshipTypes: readonly string[]
}

export interface SeedServiceMapsResult { created: { serviceId: string; mapId: string }[] }

/** Le BusinessApplication del tenant senza mappa, per nome. */
export async function listCandidates(tenantId: string): Promise<{ id: string; name: string }[]> {
  const session = getSession()
  try {
    return await runQuery<{ id: string; name: string }>(session, `
      MATCH (ba:BusinessApplication {tenant_id: $tenantId})
      WHERE NOT EXISTS { (ba)-[:HAS_SERVICE_MAP]->(:ServiceMap {tenant_id: $tenantId}) }
      RETURN ba.id AS id, ba.name AS name
      ORDER BY ba.name
    `, { tenantId })
  } finally { await session.close() }
}

/** Crea una mappa per ogni candidata; un errore su una mappa ferma il seed (fail-loud, mai una mappa saltata in silenzio). */
export async function seedServiceMaps(opts: SeedServiceMapsOptions, log: (m: string) => void = console.log): Promise<SeedServiceMapsResult> {
  const candidates = await listCandidates(opts.tenantId)
  const created: SeedServiceMapsResult['created'] = []
  for (const ba of candidates) {
    const { mapId, proposal, evaluation } = await createServiceMap({
      tenantId: opts.tenantId, serviceId: ba.id, maxDepth: opts.maxDepth, relationshipTypes: opts.relationshipTypes, actorId: SEED_ACTOR,
    })
    created.push({ serviceId: ba.id, mapId })
    const levels = new Map<number, number>()
    for (const n of proposal.nodes) levels.set(n.level, (levels.get(n.level) ?? 0) + 1)
    const perLevel = [...levels.entries()].sort((a, b) => a[0] - b[0]).map(([l, n]) => `L${l}: ${n}`).join(', ')
    log(`✓ ${ba.name} → mappa ${mapId}: ${proposal.nodes.length} componenti (${perLevel || 'nessuno'}), salute ${evaluation.health} (${evaluation.impactScore})`)
  }
  if (candidates.length === 0) log(`Nessuna BusinessApplication senza mappa nel tenant ${opts.tenantId}: niente da fare`)
  return { created }
}

/** Argomenti del seed dalla riga di comando (valori non validi → ScriptArgError, nessun default silenzioso oltre a quelli del contratto). */
export function parseSeedArgs(argv: readonly string[]): SeedServiceMapsOptions {
  const tenantId = resolveTenantArg(argv)
  const depthRaw = readOptionValue('--max-depth', argv)
  const maxDepth = depthRaw === undefined ? SERVICE_MAP_DEFAULT_DEPTH : Number(depthRaw)
  if (!Number.isInteger(maxDepth)) throw new ScriptArgError(`--max-depth deve essere un intero, ricevuto ${JSON.stringify(depthRaw)}`)
  const relRaw = readOptionValue('--relationships', argv)
  const relationshipTypes = relRaw === undefined ? [...SERVICE_RELATIONSHIP_TYPES] : relRaw.split(',').map((s) => s.trim()).filter(Boolean)
  if (relationshipTypes.length === 0) throw new ScriptArgError(`--relationships vuoto: ammessi ${SERVICE_RELATIONSHIP_TYPES.join(', ')}`)
  return { tenantId, maxDepth, relationshipTypes }
}
