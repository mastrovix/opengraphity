/**
 * Servizi monitorati — regole d'impatto come funzione PURA.
 *
 * Dai nodi inclusi nella mappa (con salute del CI, peso, ruolo e finestra di
 * change) e dalle regole del servizio calcola salute, punteggio d'impatto e
 * la spiegazione (le cause con il percorso dal nodo malato al livello 1).
 * Nessun import dal grafo: il motore (engine.ts) legge e scrive, qui si
 * decide.
 *
 * **Le due manutenzioni sono cose diverse** (revisione 2 · R1). Prima erano un
 * solo flag `inMaintenance` e bastava un CI critico con `status = 'maintenance'`
 * per spegnere il servizio per sempre, nascondendo ogni guasto:
 *   - `lifecycleMaintenance` (`ci.status = 'maintenance'`, ciclo di vita del CI):
 *     il nodo **non conta** — come `propagate: never` — quindi non entra nel
 *     denominatore e non produce cause, ma **non** rende il servizio
 *     `maintenance`. È uno stato che nessuno «chiude», a differenza di una change.
 *   - `inChangeWindow` (una change è in finestra su quel CI, **o su un CI a monte**
 *     entro `suppress_upstream_hops` salti — revisione 2 · D6.2, la stessa regola
 *     che silenzia gli allarmi): il nodo non conta e, se è critico, il SERVIZIO è
 *     `maintenance` — ma solo se non c'è di peggio. Quando la copertura viene da
 *     monte il motivo è `upstream_change_window` e la mappa lo spiega.
 *   - `lifecycleRetired` (`ci.status` dismesso o fuori servizio, revisione 2 ·
 *     D6.3): il nodo **non conta** e non rende il servizio `maintenance` nemmeno
 *     se è critico e in finestra — un CI dismesso non torna.
 * **`down` vince su `maintenance`**: un critico che conta e sta giù è un guasto
 * vero, e va detto anche mentre un altro componente è in finestra di change.
 * Quando la salute è `maintenance`, `healthIfActive` dice quale sarebbe senza le
 * finestre di change (le stesse regole con `inChangeWindow` ignorato): è la
 * «in manutenzione, sarebbe: giù» che la UI mostra.
 *
 * La tabella del contratto:
 *
 *   contano      = nodi con propagate ≠ never, non in finestra di change, non in
 *                  manutenzione di ciclo di vita e (salute nota, oppure
 *                  unknown_nodes = operational → operativo)
 *   peso_totale  = Σ weight(contano)
 *   peso_giù     = Σ weight(giù)·1.0 + Σ weight(degradati)·0.5
 *   impact_score = peso_totale = 0 ? 0 : round(100 · peso_giù / peso_totale)
 *   health       = down         se (un critico che conta è giù) o (100·Σweight(giù)/peso_totale ≥ down_share_pct)
 *                  maintenance  se un nodo critico è in finestra di change
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
import { SERVICE_MAX_CAUSES, type NodeExcludedReason, type NodePropagation, type ServiceHealth, type ServiceImpactRules, type ServiceNodeRole } from '../../lib/serviceVocabularies.js'

export interface ImpactNodeInput {
  ciId:          string
  level:         number
  role:          ServiceNodeRole
  propagate:     NodePropagation
  weight:        number
  critical:      boolean
  /** Salute del CI dal monitoraggio; null = mai toccato da un allarme. */
  health:        CIHealth | null
  /** Change in finestra sul CI o su un CI a monte: il nodo non pesa e, se è critico, il servizio è in manutenzione. */
  inChangeWindow: boolean
  /** La change in finestra è su un CI a MONTE, non su questo (solo per il motivo mostrato). */
  changeWindowUpstream: boolean
  /** Ciclo di vita del CI a `maintenance`: il nodo non pesa (gli allarmi non ne aggiornano la salute) ma il servizio NON va in manutenzione. */
  lifecycleMaintenance: boolean
  /** Ciclo di vita del CI dismesso o fuori servizio (CI_LIFECYCLE_RETIRED): il nodo non pesa e non porta il servizio in manutenzione. */
  lifecycleRetired: boolean
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
  /**
   * La salute che il servizio avrebbe SENZA le finestre di change in corso
   * (stessi nodi, `inChangeWindow` ignorato): valorizzata solo quando
   * `health = 'maintenance'`, altrimenti null. È la «sarebbe: giù» della UI.
   */
  healthIfActive: ServiceHealth | null
}

/** Peso «giù» di una salute: giù 1, degradato 0.5, operativo 0. */
const DOWN_FACTOR: Readonly<Record<CIHealth, number>> = { down: 1, degraded: 0.5, operational: 0 }

/** Ciò che serve a decidere se un nodo conta: le due manutenzioni, la propagazione e la salute. */
type NodeGate = Pick<ImpactNodeInput, 'propagate' | 'inChangeWindow' | 'changeWindowUpstream' | 'lifecycleMaintenance' | 'lifecycleRetired' | 'health'>

/** Salute con cui il nodo entra nel calcolo (null → operational solo con unknown_nodes = operational), o null se non conta. */
export function effectiveHealth(node: NodeGate, rules: Pick<ServiceImpactRules, 'unknown_nodes'>): CIHealth | null {
  if (node.propagate === 'never' || node.lifecycleRetired || node.inChangeWindow || node.lifecycleMaintenance) return null
  if (node.health !== null) return node.health
  return rules.unknown_nodes === 'operational' ? 'operational' : null
}

/** True se il nodo conta nel calcolo (per `ServiceMapNode.contributes`). */
export function nodeContributes(node: NodeGate, rules: Pick<ServiceImpactRules, 'unknown_nodes'>): boolean {
  return effectiveHealth(node, rules) !== null
}

/**
 * Perché il nodo non conta, in un vocabolario chiuso (`ServiceMapNode.excludedReason`):
 * null quando conta. L'ordine è quello di `effectiveHealth`, così il motivo
 * mostrato è quello che ha davvero deciso.
 */
export function nodeExcludedReason(node: NodeGate, rules: Pick<ServiceImpactRules, 'unknown_nodes'>): NodeExcludedReason | null {
  if (node.propagate === 'never') return 'never'
  // Il ciclo di vita viene PRIMA della finestra di change: un CI dismesso resta
  // dismesso anche mentre una change lo tocca, e il motivo mostrato dev'essere quello.
  if (node.lifecycleRetired) return 'lifecycle_decommissioned'
  if (node.inChangeWindow) return node.changeWindowUpstream ? 'upstream_change_window' : 'change_window'
  if (node.lifecycleMaintenance) return 'lifecycle_maintenance'
  if (node.health === null && rules.unknown_nodes !== 'operational') return 'unknown_health'
  return null
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

/**
 * Il calcolo vero e proprio, senza `healthIfActive` (che è lo stesso calcolo
 * rifatto una volta sola sui nodi con le finestre di change ignorate: nessuna
 * ricorsione, nessuna doppia contabilità).
 */
function evaluateCore(nodes: readonly ImpactNodeInput[], rules: ServiceImpactRules): Omit<ImpactResult, 'healthIfActive'> {
  const byId = new Map<string, ImpactNodeInput>()
  for (const n of nodes) byId.set(n.ciId, n)

  let totalWeight = 0
  let downScore = 0        // Σ weight · fattore (giù 1, degradato 0.5)
  let downWeight = 0       // Σ weight dei soli nodi giù (quota per down_share_pct)
  let criticalDown = false
  let criticalInChangeWindow = false
  let unhealthyCount = 0
  let knownCount = 0       // nodi che contano CON salute nota: 0 → il servizio è «sconosciuto», non operativo
  const causes: (ImpactCause & { level: number })[] = []

  for (const node of nodes) {
    // SOLO la finestra di change può rendere il servizio in manutenzione: il
    // ciclo di vita del CI toglie il nodo dal calcolo e basta (R1).
    // Un componente dismesso non mette il servizio in manutenzione: nessuno
    // «chiude» quella finestra perché il CI non torna (revisione 2 · D6.3).
    if (node.critical && node.inChangeWindow && !node.lifecycleRetired) criticalInChangeWindow = true
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
  // `down` PRIMA di `maintenance` (R1): un guasto vero su un critico che conta
  // non va nascosto perché un altro componente è in finestra di change.
  // La quota giù vale solo se c'è almeno un nodo giù: con down_share_pct = 0 un servizio sano non è «giù».
  if (criticalDown || (downWeight > 0 && downShare >= rules.down_share_pct)) health = 'down'
  else if (criticalInChangeWindow) health = 'maintenance'
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

export function evaluateImpact(nodes: readonly ImpactNodeInput[], rules: ServiceImpactRules): ImpactResult {
  const result = evaluateCore(nodes, rules)
  if (result.health !== 'maintenance') return { ...result, healthIfActive: null }
  // «Sarebbe»: le stesse regole sugli stessi nodi, con le sole finestre di
  // change tolte di mezzo (il ciclo di vita resta: quei CI non hanno una salute
  // aggiornata nemmeno adesso). Non può tornare `maintenance`: senza finestre
  // nessun critico è in finestra.
  const asIfActive = nodes.map((n) => (n.inChangeWindow ? { ...n, inChangeWindow: false, changeWindowUpstream: false } : n))
  return { ...result, healthIfActive: evaluateCore(asIfActive, rules).health }
}

// ── Nota della valutazione (revisione 2 · D6.2 e D6.4) ───────────────────────

/** Un componente coperto da una change su un CI a MONTE: quel che l'operatore deve leggere. */
export interface UpstreamWindowRef { name: string; changeCode: string; viaName: string }

export interface HealthNoteInput {
  /** Valutazione sospesa perché una sorgente degli allarmi è in tempesta (`during_storm = hold`). */
  held:            boolean
  /** Nomi delle sorgenti in tempesta fra quelle degli allarmi accesi sui componenti. */
  stormSources:    readonly string[]
  /** Componenti in finestra di change a monte. */
  upstreamWindows: readonly UpstreamWindowRef[]
}

/** Quanti elementi si citano per esteso in una nota prima di «e altri N». */
export const HEALTH_NOTE_MAX_ITEMS = 3

function withRest(items: readonly string[]): string {
  const shown = items.slice(0, HEALTH_NOTE_MAX_ITEMS)
  const rest = items.length - shown.length
  return `${shown.join(', ')}${rest > 0 ? `, e altri ${rest}` : ''}`
}

/**
 * Perché la salute è questa, quando l'elenco delle cause non basta
 * (`ServiceMap.health_note`): la tempesta che ha sospeso la valutazione e/o i
 * componenti coperti da una change su un CI a monte. Funzione pura, testi
 * espliciti: `null` quando non c'è niente da spiegare (e la nota va cancellata).
 */
export function serviceHealthNote(input: HealthNoteInput): string | null {
  const parts: string[] = []
  if (input.held && input.stormSources.length > 0) {
    parts.push(`${input.stormSources.length === 1 ? 'Sorgente in tempesta' : 'Sorgenti in tempesta'}: ${withRest([...input.stormSources])}. Valutazione sospesa: la salute resta quella dell'ultima valutazione.`)
  }
  if (input.upstreamWindows.length > 0) {
    parts.push(`${input.upstreamWindows.length === 1 ? 'Componente in finestra di change a monte' : 'Componenti in finestra di change a monte'}: ${withRest(input.upstreamWindows.map((u) => `${u.name} (${u.changeCode} su ${u.viaName})`))}.`)
  }
  return parts.length ? parts.join(' ') : null
}
