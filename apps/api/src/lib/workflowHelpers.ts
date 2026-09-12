/**
 * Workflow helpers: every caller that needs to reason about step names
 * must go through here, so step names are never hardcoded in resolvers
 * or services. The workflow engine (WorkflowDefinition/WorkflowStep nodes)
 * is the single source of truth.
 */

import type { Session } from 'neo4j-driver'

// ── Per-request cache ─────────────────────────────────────────────────────────
// Keyed by tenant_id + entity_type. Keeps identity per request; the module
// stays alive per process so the first call of a request warms it up and
// subsequent calls are cheap. Cache is only a micro-optimisation: every query
// is small and safe to re-run if the cache is bypassed.

const stepsCache = new Map<string, Promise<StepRow[]>>()

export interface StepRow {
  name:       string
  /** Etichetta scelta dal cliente nel disegnatore; `null` se non l'ha messa. */
  label:      string | null
  isInitial:  boolean
  isTerminal: boolean
  isOpen:     boolean
  category:   string | null
  /**
   * Lo SCOPO del passo (`WORKFLOW_STEP_PURPOSES`): che ruolo ha nel processo.
   * `null` = il cliente non l'ha dichiarato. Chi decide in base allo scopo
   * deve dire cosa fa in quel caso, mai indovinare dal nome (B-4).
   */
  purpose:    string | null
  stepOrder:  number | null
}

function cacheKey(tenantId: string, entityType: string) {
  return `${tenantId}::${entityType}`
}

async function loadSteps(session: Session, tenantId: string, entityType: string): Promise<StepRow[]> {
  const key = cacheKey(tenantId, entityType)
  const hit = stepsCache.get(key)
  if (hit) return hit
  const promise = session.executeRead(async (tx) => {
    const res = await tx.run(`
      MATCH (wd:WorkflowDefinition {tenant_id: $tenantId, entity_type: $entityType, active: true})
      MATCH (wd)-[:HAS_STEP]->(s:WorkflowStep)
      RETURN s.name       AS name,
             s.label      AS label,
             coalesce(s.is_initial,  s.type = 'start') AS isInitial,
             coalesce(s.is_terminal, s.type = 'end')   AS isTerminal,
             coalesce(s.is_open,     s.type <> 'end')  AS isOpen,
             s.category    AS category,
             s.purpose     AS purpose,
             s.step_order  AS stepOrder
    `, { tenantId, entityType })
    return res.records.map((r) => ({
      name:       r.get('name')       as string,
      label:      (r.get('label') ?? null) as string | null,
      isInitial:  Boolean(r.get('isInitial')),
      isTerminal: Boolean(r.get('isTerminal')),
      isOpen:     Boolean(r.get('isOpen')),
      category:   (r.get('category') ?? null) as string | null,
      purpose:    (r.get('purpose')  ?? null) as string | null,
      stepOrder:  r.get('stepOrder') != null ? Number(r.get('stepOrder')) : null,
    }))
  })
  stepsCache.set(key, promise)
  // Auto-expire after 30s to keep long-lived processes in sync with designer edits.
  setTimeout(() => { stepsCache.delete(key) }, 30_000).unref?.()
  return promise
}

/**
 * Svuota la cache dei metadata dei passi. La chiamano TUTTE le mutation che
 * cambiano una definizione o i suoi passi (B-24): senza, dopo un salvataggio
 * dal disegnatore il processo continuava fino a 30 s con i flag vecchi —
 * un passo appena marcato terminale che per le liste era ancora aperto.
 *
 * - `(tenant, entityType)` → solo quella chiave;
 * - `(tenant)` → tutte le entità di quel tenant (gli altri tenant non si
 *   toccano: prima cadeva l'intera cache, e con essa quella degli altri);
 * - nessun argomento → tutto.
 *
 * Resta fuori portata il multi-replica: worker ed `events-worker` sono processi
 * separati, con la loro copia della cache, e non se ne accorgono (vedi rapporto).
 */
export function invalidateWorkflowCache(tenantId?: string, entityType?: string) {
  if (tenantId && entityType) { stepsCache.delete(cacheKey(tenantId, entityType)); return }
  if (tenantId) {
    const prefix = `${tenantId}::`
    for (const key of [...stepsCache.keys()]) if (key.startsWith(prefix)) stepsCache.delete(key)
    return
  }
  stepsCache.clear()
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function getTerminalStepNames(session: Session, tenantId: string, entityType: string): Promise<string[]> {
  const steps = await loadSteps(session, tenantId, entityType)
  return steps.filter((s) => s.isTerminal).map((s) => s.name)
}

export async function getOpenStepNames(session: Session, tenantId: string, entityType: string): Promise<string[]> {
  const steps = await loadSteps(session, tenantId, entityType)
  return steps.filter((s) => s.isOpen).map((s) => s.name)
}

export async function getInitialStepName(session: Session, tenantId: string, entityType: string): Promise<string> {
  const steps = await loadSteps(session, tenantId, entityType)
  const initial = steps.find((s) => s.isInitial)
  if (!initial) throw new Error(`No initial step defined for entityType "${entityType}" in tenant "${tenantId}"`)
  return initial.name
}

export async function getEntityCurrentStep(session: Session, entityId: string, tenantId: string): Promise<string | null> {
  const res = await session.executeRead((tx) => tx.run(`
    MATCH (e {id: $entityId, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
    RETURN wi.current_step AS step
  `, { entityId, tenantId }))
  if (!res.records.length) return null
  return res.records[0].get('step') as string
}

export async function isEntityInTerminalStep(session: Session, entityId: string, tenantId: string): Promise<boolean> {
  const res = await session.executeRead((tx) => tx.run(`
    MATCH (e {id: $entityId, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
    MATCH (wi)-[:CURRENT_STEP]->(s:WorkflowStep)
    RETURN coalesce(s.is_terminal, s.type = 'end') AS terminal
  `, { entityId, tenantId }))
  if (!res.records.length) return false
  return Boolean(res.records[0].get('terminal'))
}

export async function isEntityOpen(session: Session, entityId: string, tenantId: string): Promise<boolean> {
  const terminal = await isEntityInTerminalStep(session, entityId, tenantId)
  return !terminal
}

export async function getStepCategory(session: Session, tenantId: string, entityType: string, stepName: string): Promise<string | null> {
  const steps = await loadSteps(session, tenantId, entityType)
  return steps.find((s) => s.name === stepName)?.category ?? null
}

/** All step rows for an entity type — useful for bulk operations (filters, UI). */
export async function getWorkflowSteps(session: Session, tenantId: string, entityType: string): Promise<StepRow[]> {
  return loadSteps(session, tenantId, entityType)
}

// ── Classi di stato (B0-3) ────────────────────────────────────────────────────

/**
 * Le quattro classi di stato con cui il portale filtra e conta i ticket.
 * Sono classi, NON nomi di passo: il portale filtrava per il nome `'open'`,
 * che nessun workflow definisce (di fabbrica il passo iniziale si chiama
 * `new`), quindi la scheda «Aperti» era vuota per costruzione e non coincideva
 * col contatore della home, che invece ragionava sui metadata.
 */
export const TICKET_STATUS_CLASSES = ['open', 'in_progress', 'resolved', 'closed'] as const
export type TicketStatusClass = (typeof TICKET_STATUS_CLASSES)[number]

/**
 * Classi a cui appartiene un passo, dedotte SOLO dal dato (`is_open`,
 * `is_initial`, `is_terminal`, `category`), mai dal nome: un cliente che
 * rinomina «assigned» in «preso in carico» non cambia nulla qui.
 *
 * - `resolved`: la categoria del passo è `resolved`
 * - `closed`:   il passo è terminale e non è la categoria `resolved`
 * - `open`:     il passo è aperto (`is_open`) e non è la categoria `resolved`
 * - `in_progress`: sottoinsieme di `open` che non è il passo iniziale
 *
 * `open` e `in_progress` si SOVRAPPONGONO di proposito: «Aperti» è tutto ciò
 * che è ancora in gioco (ed è il numero della home), «In lavorazione» è la
 * parte che qualcuno ha già preso in mano.
 */
export function stepStatusClasses(step: StepRow): TicketStatusClass[] {
  const out: TicketStatusClass[] = []
  const isResolved = step.category === 'resolved'
  if (isResolved) out.push('resolved')
  if (step.isTerminal && !isResolved) out.push('closed')
  if (step.isOpen && !isResolved) {
    out.push('open')
    if (!step.isInitial) out.push('in_progress')
  }
  return out
}

/**
 * Nomi dei passi del workflow del tenant per ogni classe. Un tenant con due
 * definizioni attive per la stessa entità (c-one ne ha due per gli incident)
 * contribuisce con l'unione dei nomi: un nome appartiene a una classe se
 * almeno una definizione attiva lo mette lì.
 */
export async function getStepNamesByClass(
  session: Session, tenantId: string, entityType: string,
): Promise<Record<TicketStatusClass, string[]>> {
  const steps = await loadSteps(session, tenantId, entityType)
  const out = { open: new Set<string>(), in_progress: new Set<string>(), resolved: new Set<string>(), closed: new Set<string>() }
  for (const step of steps) for (const cls of stepStatusClasses(step)) out[cls].add(step.name)
  return {
    open:        [...out.open],
    in_progress: [...out.in_progress],
    resolved:    [...out.resolved],
    closed:      [...out.closed],
  }
}

// ── Scopo del passo (ondata 4, B-4 / C-9 / D-22) ──────────────────────────────

/**
 * I nomi dei passi che hanno uno di questi SCOPI, nel workflow del tenant.
 *
 * È il sostituto dei letterali: dove il codice scriveva
 * `wi.current_step IN ['scheduled','deployment']` ora chiede «quali passi
 * hanno scopo `scheduled` o `implementation`», e il cliente può chiamarli
 * «CAB approvato» e «Rilascio» senza spegnere niente.
 *
 * Ritorna una lista, non un nome: un cliente può avere due passi con lo stesso
 * scopo (due finestre di rilascio, due livelli di approvazione), e più
 * definizioni attive per la stessa entità contribuiscono con l'unione.
 */
export async function getStepNamesByPurpose(
  session: Session, tenantId: string, entityType: string, purposes: readonly string[],
): Promise<string[]> {
  const steps = await loadSteps(session, tenantId, entityType)
  const wanted = new Set(purposes)
  return [...new Set(steps.filter((s) => s.purpose != null && wanted.has(s.purpose)).map((s) => s.name))]
}

/**
 * Lo scopo di un passo preciso, `null` se non dichiarato. Serve a chi ha in
 * mano il nome corrente di un'istanza e deve capire dove si trova.
 */
export async function getStepPurpose(
  session: Session, tenantId: string, entityType: string, stepName: string,
): Promise<string | null> {
  const steps = await loadSteps(session, tenantId, entityType)
  return steps.find((s) => s.name === stepName)?.purpose ?? null
}

/**
 * Come `getStepNamesByPurpose`, ma **fail-loud**: se nel workflow del tenant
 * nessun passo dichiara nessuno degli scopi richiesti, l'operazione si ferma e
 * lo dice, invece di procedere con una lista vuota che spegnerebbe in silenzio
 * una regola di dominio (soppressione degli allarmi, varco delle approvazioni,
 * sincronizzazione fra change e problem).
 *
 * `what` descrive l'operazione, e finisce nel messaggio.
 */
export async function requireStepNamesByPurpose(
  session: Session, tenantId: string, entityType: string, purposes: readonly string[], what: string,
): Promise<string[]> {
  const names = await getStepNamesByPurpose(session, tenantId, entityType, purposes)
  if (names.length === 0) {
    throw new Error(
      `${what}: nel workflow "${entityType}" del tenant ${tenantId} nessun passo dichiara lo scopo ` +
      `[${purposes.join(', ')}]. Assegna lo scopo ai passi nel disegnatore: senza, questa regola non ha ` +
      `su quali passi applicarsi.`,
    )
  }
  return names
}
