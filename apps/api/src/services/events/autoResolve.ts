/**
 * Passo 7 della pipeline: chiusura automatica.
 *
 * Evento `resolved` con incident correlato: se `auto_resolve` e TUTTI gli
 * eventi correlati sono risolti → `incidentService.resolveIncident`. Se dal
 * passo corrente (es. `new`) non c'è un arco verso `resolved`, si cerca nella
 * definizione un cammino di passi intermedi percorribili dal monitoraggio
 * (`findAutoResolvePath`) e lo si esegue prima di risolvere. La chiusura
 * lascia UN solo commento con il cammino percorso (3.3): i passi intermedi
 * restano nella storia del workflow.
 */
import { runQueryOne } from '@opengraphity/neo4j'
import type { Session } from 'neo4j-driver'
import { publishEvent } from '../../lib/publishEvent.js'
import { audit } from '../../lib/audit.js'
import { logger } from '../../lib/logger.js'
import { withRedisLock } from '../../lib/redisLock.js'
import type { EventPolicy } from '../../lib/eventPolicy.js'
import { incidentsAutoResolvedTotal } from '../../middleware/metrics.js'
import { engine, incidents } from './deps.js'
import { MONITORING_ACTOR, mapEventPayload, monitoringContext, toNumber, toStr } from './shared.js'
import { setCorrelation } from './repo.js'
import { recomputeCIHealth } from './ciHealth.js'
import { incidentStepInfo, loadDefinitionTransitions, runMonitoringTransition, type DefinitionTransition } from './incidentWorkflow.js'
import { GROUP_LOCK_OPTS, groupIdOf, groupLockKey, type EventCorrelatedPayload } from './grouping.js'
import type { StormState } from './storm.js'
import type { EventRecord, PipelineMode, PipelineOutcome, PipelineResult } from './types.js'

const log = logger.child({ module: 'event-correlation' })

/** Massimo numero di passi intermedi che il monitoraggio percorre per arrivare a un passo da cui "resolved" è raggiungibile. */
export const AUTO_RESOLVE_MAX_HOPS = 4
/** Trigger percorribili dal monitoraggio (mai `timer` né `sla_breach`). */
export const AUTO_RESOLVE_TRIGGERS: readonly string[] = ['manual', 'automatic']
/**
 * Condizioni d'arco soddisfatte dalle note che il monitoraggio passa a ogni
 * passaggio (la built-in del motore valuta `notes` non vuote; resolveIncident
 * fornisce la causa come notes). Qualunque altra condizione rende l'arco
 * impercorribile: non conosciamo il dominio che la soddisfa.
 */
export const AUTO_RESOLVE_SATISFIABLE_CONDITIONS: readonly string[] = ['rootCause != null']

/** Passo intermedio da eseguire: arco scelto e trigger con cui percorrerlo. */
export interface AutoResolveHop { toStep: string; toLabel: string | null; trigger: 'manual' | 'automatic' }

function isUsableForAutoResolve(t: DefinitionTransition): boolean {
  return AUTO_RESOLVE_TRIGGERS.includes(t.trigger) && (t.condition == null || AUTO_RESOLVE_SATISFIABLE_CONDITIONS.includes(t.condition))
}

/**
 * Ricerca in ampiezza, nella definizione, del cammino più corto da `fromStep` a
 * un passo da cui `resolvedStep` è raggiungibile con un arco percorribile.
 * Restituisce i passi INTERMEDI da eseguire (l'ultimo arco, verso resolved, lo
 * percorre resolveIncident): `[]` se resolved è già raggiungibile da fromStep,
 * `null` se non esiste un cammino con al più `maxHops` passi intermedi. Solo
 * archi `manual`/`automatic` senza condizione o con condizione soddisfabile
 * dalle note; a parità di arrivo preferisce l'arco manuale; nessun ciclo (ogni
 * passo è visitato una volta sola); `resolvedStep` non è mai un passo intermedio.
 */
export function findAutoResolvePath(transitions: readonly DefinitionTransition[], fromStep: string, resolvedStep: string, maxHops: number = AUTO_RESOLVE_MAX_HOPS): AutoResolveHop[] | null {
  const usable = transitions.filter(isUsableForAutoResolve)
  // Ordine stabile: gli archi manuali prima, così a parità di passo di arrivo vince il manuale.
  usable.sort((a, b) => (a.trigger === b.trigger ? 0 : a.trigger === 'manual' ? -1 : 1))
  const outgoing = new Map<string, DefinitionTransition[]>()
  for (const t of usable) {
    const list = outgoing.get(t.fromStep) ?? []
    list.push(t)
    outgoing.set(t.fromStep, list)
  }

  const visited = new Set<string>([fromStep])
  let frontier: Array<{ step: string; path: AutoResolveHop[] }> = [{ step: fromStep, path: [] }]
  while (frontier.length > 0) {
    const next: typeof frontier = []
    for (const { step, path } of frontier) {
      const edges = outgoing.get(step) ?? []
      if (edges.some((e) => e.toStep === resolvedStep)) return path
      if (path.length >= maxHops) continue
      for (const e of edges) {
        if (e.toStep === resolvedStep || visited.has(e.toStep)) continue
        visited.add(e.toStep)
        next.push({ step: e.toStep, path: [...path, { toStep: e.toStep, toLabel: e.toLabel, trigger: e.trigger as 'manual' | 'automatic' }] })
      }
    }
    frontier = next
  }
  return null
}

export async function handleResolvedEvent(session: Session, tenantId: string, ev: EventRecord, policy: EventPolicy, actorId: string, now: string, mode: PipelineMode, storm: StormState, logCtx: Record<string, unknown> = {}): Promise<PipelineResult> {
  const eventId = toStr(ev.props['id'])
  const done = (outcome: PipelineOutcome, incidentId: string | null = null): PipelineResult =>
    ({ outcome, status: 'resolved', suppressedByChangeId: null, incidentId })

  if (mode === 'resume') {
    // Risolto durante l'attesa: nessuna correlazione. Salute e chiusura sono
    // già state valutate all'ingest del payload resolved.
    if (ev.props['correlation'] === 'delayed') await setCorrelation(session, tenantId, eventId, 'none', now)
    return done('none')
  }
  if (ev.ciId) await recomputeCIHealth(tenantId, ev.ciId, actorId)
  // In tempesta solo la salute: l'incident di tempesta si chiude a mano o
  // automaticamente quando, finita la tempesta, l'ultimo allarme rientra.
  if (storm.active) return done('storm', storm.incidentId)

  // La chiusura automatica gira sotto lo STESSO lock del raggruppamento
  // (tenant, gruppo): "leggi incident e allarmi ancora accesi → percorri i passi
  // → risolvi" non deve intrecciarsi né con un altro rientro dello stesso
  // gruppo (due payload resolved in parallelo: entrambi leggevano "nessun altro
  // acceso" e il secondo falliva con "transizione concorrente" sul primo passo)
  // né con un allarme che nel frattempo apre/riapre/aggancia. Nessuna
  // scorciatoia: chi trova il lock occupato attende e poi rilegge.
  const lockKey = groupLockKey(tenantId, policy.group_by, groupIdOf(policy, ev))
  return withRedisLock<PipelineResult>(lockKey, GROUP_LOCK_OPTS, () => resolveAgainstIncident(session, tenantId, ev, policy, actorId, now, done, logCtx),
    undefined, `auto-resolve of event ${eventId} could not start`)
}

async function resolveAgainstIncident(session: Session, tenantId: string, ev: EventRecord, policy: EventPolicy, actorId: string, now: string,
  done: (outcome: PipelineOutcome, incidentId?: string | null) => PipelineResult, logCtx: Record<string, unknown>): Promise<PipelineResult> {
  const eventId = toStr(ev.props['id'])
  const info = await incidentStepInfo(session, tenantId)
  const linked = await runQueryOne<{ incidentId: string; instanceId: string; step: string; stillFiring: unknown }>(session, `
    MATCH (e:Event {id: $eventId, tenant_id: $tenantId})-[:CORRELATED_INTO]->(i:Incident {tenant_id: $tenantId})
    MATCH (i)-[:HAS_WORKFLOW]->(wi:WorkflowInstance {tenant_id: $tenantId})
    WHERE NOT wi.current_step IN $terminalSteps
    OPTIONAL MATCH (other:Event {tenant_id: $tenantId})-[:CORRELATED_INTO]->(i)
      WHERE other.status <> 'resolved'
    WITH i, wi, count(DISTINCT other) AS stillFiring
    RETURN i.id AS incidentId, wi.id AS instanceId, wi.current_step AS step, stillFiring, i.created_at AS createdAt
    ORDER BY createdAt DESC LIMIT 1
  `, { eventId, tenantId, terminalSteps: info.terminalSteps })
  if (!linked) return done('none')

  if (!policy.auto_resolve) return done('none', linked.incidentId)
  if (toNumber(linked.stillFiring) > 0) return done('none', linked.incidentId)
  if (linked.step === info.resolvedStep) return done('none', linked.incidentId)

  const ctx = { tenantId, userId: MONITORING_ACTOR }
  const title = toStr(ev.props['title'])
  const transitions = await (await engine()).getAvailableTransitions(session, linked.instanceId, tenantId)
  const incidentService = await incidents()

  // Cammino verso resolved: [] se "Risolvi" è già disponibile dal passo
  // corrente; altrimenti (es. incident nato in "new" dal monitoraggio) i passi
  // intermedi percorribili trovati nella definizione; null se non esistono.
  const path = transitions.some((t) => t.toStep === info.resolvedStep)
    ? []
    : findAutoResolvePath(await loadDefinitionTransitions(session, linked.instanceId, tenantId), linked.step, info.resolvedStep)

  let outcome: PipelineOutcome
  if (path) {
    // Ogni passo intermedio è una transizione vera (storia del workflow,
    // evento incident.<step>, senza commento: un solo commento riassuntivo
    // alla fine): le sue enter/exit action possono avviare o fermare gli
    // orologi SLA (seed: assigned avvia il response, in_progress lo ferma e
    // avvia il resolve) — è accettato, l'incident risulta preso in carico e
    // risolto dal monitoraggio. Un passo rifiutato → errore: i passi già
    // fatti restano (ciascuno è atomico e coerente), il job ritenta.
    for (const hop of path) {
      await runMonitoringTransition(session, tenantId, linked.incidentId, linked.instanceId, hop.toStep, hop.trigger,
        `Chiusura automatica dal monitoraggio: passaggio a ${hop.toLabel ?? hop.toStep}`, 'auto-resolve', false)
    }
    // La transizione "Risolvi" richiede la causa (rootCause = notes).
    await incidentService.resolveIncident(linked.incidentId, ctx, `Allarme di monitoraggio rientrato: ${title}`)
    const via = path.length ? ` — passando per ${path.map((h) => h.toLabel ?? h.toStep).join(', ')}` : ''
    await incidentService.addIncidentComment(linked.incidentId, ctx, `Risolto automaticamente: tutti gli allarmi di monitoraggio correlati sono rientrati (ultimo: ${title})${via}`)
    incidentsAutoResolvedTotal.inc({})
    outcome = 'auto_resolved'
  } else {
    // Nessun cammino percorribile (archi solo con condizioni di dominio, o
    // più lungo di AUTO_RESOLVE_MAX_HOPS): si lascia traccia senza forzare.
    await incidentService.addIncidentComment(linked.incidentId, ctx,
      `Tutti gli allarmi di monitoraggio correlati sono rientrati (ultimo: ${title}); l'incident è in "${linked.step}" e non può essere risolto automaticamente da questo passo`)
    outcome = 'auto_resolve_skipped'
  }
  const payload: EventCorrelatedPayload = { ...mapEventPayload(ev.props, ev.ciId), incident_id: linked.incidentId, outcome }
  await publishEvent('event.correlated', tenantId, actorId, payload, now)
  void audit(monitoringContext(tenantId), `event.${outcome}`, 'Event', eventId, { incidentId: linked.incidentId, incidentStep: linked.step, path: path?.map((h) => h.toStep) ?? null })
  log.info({ ...logCtx, tenantId, eventId, incidentId: linked.incidentId, outcome }, 'Resolved event evaluated against its incident')
  return done(outcome, linked.incidentId)
}
