/**
 * Servizi monitorati — regole d'impatto come funzione PURA.
 *
 * Dai nodi inclusi nella mappa (con salute del CI, peso, ruolo e finestra di
 * change) e dalle regole del servizio calcola salute, punteggio d'impatto e
 * la spiegazione (le cause con il percorso dal nodo malato al livello 1).
 * Nessun import dal grafo: il motore (engine.ts) legge e scrive, qui si
 * decide. La tabella del contratto (ondata 1):
 *
 *   contano      = nodi con propagate ≠ never, non in finestra di change e
 *                  (salute nota, oppure unknown_nodes = operational → operativo)
 *   peso_totale  = Σ weight(contano)
 *   peso_giù     = Σ weight(giù)·1.0 + Σ weight(degradati)·0.5
 *   impact_score = peso_totale = 0 ? 0 : round(100 · peso_giù / peso_totale)
 *   health       = maintenance  se un nodo critico è in finestra di change
 *                  down         se (un critico che conta è giù) o (100·Σweight(giù)/peso_totale ≥ down_share_pct)
 *                  degraded     se impact_score ≥ degraded_share_pct e (nodi non operativi che contano) ≥ min_nodes
 *                  unknown      se peso_totale = 0 o nessun nodo che conta ha una salute NOTA
 *                               (un servizio non monitorato non è «operativo»: non lo sappiamo)
 *                  operational  altrimenti
 *
 * Default `unknown_nodes = operational`: i nodi mai toccati da un allarme
 * stanno nel denominatore come sani, così un solo componente secondario giù
 * non fa 100 % di quota (con `ignore` il denominatore si riduce ai soli nodi
 * monitorati e una copertura parziale gonfia l'impatto). `ignore` resta
 * un'opzione per chi monitora tutto.
 *   causes       = nodi che contano giù/degradati: critici prima, poi peso desc, poi livello asc; al più 20
 *
 * `always` e `weighted` pesano allo stesso modo (la differenza è semantica,
 * per la UI: «pesa sempre»). Un nodo senza salute non è mai «giù».
 */
import type { CIHealth } from '../../lib/eventVocabularies.js'
import { SERVICE_MAX_CAUSES, type NodePropagation, type ServiceHealth, type ServiceImpactRules, type ServiceNodeRole } from '../../lib/serviceVocabularies.js'

export interface ImpactNodeInput {
  ciId:          string
  level:         number
  role:          ServiceNodeRole
  propagate:     NodePropagation
  weight:        number
  critical:      boolean
  /** Salute del CI dal monitoraggio; null = mai toccato da un allarme. */
  health:        CIHealth | null
  /** Change in finestra sul CI (hops 0): il nodo non pesa. */
  inMaintenance: boolean
  /** Id del CI da cui si arriva (null al livello 1). */
  via:           string | null
}

export interface ImpactCause {
  ciId:     string
  health:   CIHealth
  weight:   number
  critical: boolean
  /** Dal nodo malato risalendo `via` fino al livello 1 (il nodo stesso per primo). */
  path:     string[]
}

export interface ImpactResult {
  health:      ServiceHealth
  impactScore: number
  causes:      ImpactCause[]
}

/** Peso «giù» di una salute: giù 1, degradato 0.5, operativo 0. */
const DOWN_FACTOR: Readonly<Record<CIHealth, number>> = { down: 1, degraded: 0.5, operational: 0 }

/** Salute con cui il nodo entra nel calcolo (null → operational solo con unknown_nodes = operational), o null se non conta. */
export function effectiveHealth(node: Pick<ImpactNodeInput, 'propagate' | 'inMaintenance' | 'health'>, rules: Pick<ServiceImpactRules, 'unknown_nodes'>): CIHealth | null {
  if (node.propagate === 'never' || node.inMaintenance) return null
  if (node.health !== null) return node.health
  return rules.unknown_nodes === 'operational' ? 'operational' : null
}

/** True se il nodo conta nel calcolo (per `ServiceMapNode.contributes`). */
export function nodeContributes(node: Pick<ImpactNodeInput, 'propagate' | 'inMaintenance' | 'health'>, rules: Pick<ServiceImpactRules, 'unknown_nodes'>): boolean {
  return effectiveHealth(node, rules) !== null
}

/**
 * Percorso dal nodo risalendo `via` fino a un nodo senza `via` (livello 1).
 * Un `via` che non è nella mappa (nodo sparito: la mappa è stale) chiude il
 * percorso lì; un ciclo (dato corrotto) non manda in loop.
 */
export function impactPath(ciId: string, byId: ReadonlyMap<string, ImpactNodeInput>): string[] {
  const path: string[] = []
  const seen = new Set<string>()
  let cur: string | null = ciId
  while (cur !== null && !seen.has(cur)) {
    seen.add(cur)
    path.push(cur)
    const node = byId.get(cur)
    cur = node ? node.via : null
  }
  return path
}

function assertWeight(node: ImpactNodeInput): number {
  if (!Number.isInteger(node.weight) || node.weight < 1) {
    throw new Error(`Service map node ${node.ciId} has an invalid weight ${JSON.stringify(node.weight)} (expected an integer >= 1)`)
  }
  return node.weight
}

export function evaluateImpact(nodes: readonly ImpactNodeInput[], rules: ServiceImpactRules): ImpactResult {
  const byId = new Map<string, ImpactNodeInput>()
  for (const n of nodes) byId.set(n.ciId, n)

  let totalWeight = 0
  let downScore = 0        // Σ weight · fattore (giù 1, degradato 0.5)
  let downWeight = 0       // Σ weight dei soli nodi giù (quota per down_share_pct)
  let criticalDown = false
  let criticalInMaintenance = false
  let unhealthyCount = 0
  let knownCount = 0       // nodi che contano CON salute nota: 0 → il servizio è «sconosciuto», non operativo
  const causes: (ImpactCause & { level: number })[] = []

  for (const node of nodes) {
    if (node.critical && node.inMaintenance) criticalInMaintenance = true
    const health = effectiveHealth(node, rules)
    if (health === null) continue
    const weight = assertWeight(node)
    totalWeight += weight
    if (node.health !== null) knownCount++
    const factor = DOWN_FACTOR[health]
    if (factor > 0) {
      unhealthyCount++
      downScore += weight * factor
      if (health === 'down') {
        downWeight += weight
        if (node.critical) criticalDown = true
      }
      causes.push({ ciId: node.ciId, health, weight, critical: node.critical, path: impactPath(node.ciId, byId), level: node.level })
    }
  }

  const impactScore = totalWeight === 0 ? 0 : Math.round((100 * downScore) / totalWeight)
  const downShare = totalWeight === 0 ? 0 : (100 * downWeight) / totalWeight

  let health: ServiceHealth
  if (criticalInMaintenance) health = 'maintenance'
  // La quota giù vale solo se c'è almeno un nodo giù: con down_share_pct = 0 un servizio sano non è «giù».
  else if (criticalDown || (downWeight > 0 && downShare >= rules.down_share_pct)) health = 'down'
  else if (totalWeight > 0 && impactScore >= rules.degraded_share_pct && unhealthyCount >= rules.min_nodes) health = 'degraded'
  else if (totalWeight === 0 || knownCount === 0) health = 'unknown'
  else health = 'operational'

  causes.sort((a, b) =>
    Number(b.critical) - Number(a.critical)
    || b.weight - a.weight
    || a.level - b.level
    || a.ciId.localeCompare(b.ciId))

  return {
    health,
    impactScore,
    causes: causes.slice(0, SERVICE_MAX_CAUSES).map(({ level: _level, ...c }) => c),
  }
}
