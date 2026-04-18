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

interface StepRow {
  name:       string
  isInitial:  boolean
  isTerminal: boolean
  isOpen:     boolean
  category:   string | null
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
             coalesce(s.is_initial,  s.type = 'start') AS isInitial,
             coalesce(s.is_terminal, s.type = 'end')   AS isTerminal,
             coalesce(s.is_open,     s.type <> 'end')  AS isOpen,
             s.category    AS category
    `, { tenantId, entityType })
    return res.records.map((r) => ({
      name:       r.get('name')       as string,
      isInitial:  Boolean(r.get('isInitial')),
      isTerminal: Boolean(r.get('isTerminal')),
      isOpen:     Boolean(r.get('isOpen')),
      category:   (r.get('category') ?? null) as string | null,
    }))
  })
  stepsCache.set(key, promise)
  // Auto-expire after 30s to keep long-lived processes in sync with designer edits.
  setTimeout(() => { stepsCache.delete(key) }, 30_000).unref?.()
  return promise
}

/** Invalidate cached step metadata for a tenant+entity (call after designer saves). */
export function invalidateWorkflowCache(tenantId?: string, entityType?: string) {
  if (tenantId && entityType) stepsCache.delete(cacheKey(tenantId, entityType))
  else stepsCache.clear()
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
