/**
 * Automation engine shared by AutoTriggers and BusinessRules (C-20b).
 *
 * Both engines were 85% identical: TTL cache, condition matching, action
 * execution with per-record result/error reporting, audit and logging. The
 * common part lives here, parametrised by `kind`; `triggerEngine.ts` and
 * `rulesEngine.ts` remain as thin facades holding the real differences
 * (Cypher loaders, timer scheduling, AND/OR + priority + stop_on_match for
 * rules, execution counters for triggers).
 */
import { logger as appLogger } from './logger.js'
import { evaluateConditions, parseConditions } from './conditionEvaluator.js'
import { executeActions, parseActions, type ActionExecutionContext, type ActionResult } from './actionExecutor.js'
import { audit } from './audit.js'

const log = appLogger.child({ module: 'automation-engine' })

export type AutomationKind = 'trigger' | 'rule'

interface KindSpec {
  source:      ActionExecutionContext['source']
  auditAction: string
  auditEntity: string
  /** Key under which the record name is reported in the audit payload. */
  nameKey:     string
  label:       string
}

const KIND_SPEC: Record<AutomationKind, KindSpec> = {
  trigger: { source: 'trigger',       auditAction: 'trigger.executed',       auditEntity: 'AutoTrigger',  nameKey: 'triggerName', label: 'Trigger' },
  rule:    { source: 'business_rule', auditAction: 'business_rule.executed', auditEntity: 'BusinessRule', nameKey: 'ruleName',    label: 'Business rule' },
}

/** What the engine needs from a trigger/rule row. */
export interface AutomationRecord {
  id:             string
  name:           string
  conditions:     string | null
  actions:        string | null
  conditionLogic: 'and' | 'or'
  stopOnMatch:    boolean
}

export interface AutomationOutcome {
  id:         string
  name:       string
  /** Conditions were met and the actions were attempted. */
  matched:    boolean
  /** Actions that succeeded. */
  actionsRun: number
  /** This record ended the evaluation (stop_on_match). */
  stopped:    boolean
  /** Corrupt config, failed action or exception — never hidden behind `matched: true`. */
  error?:     string
}

export interface EvaluateRulesOptions {
  kind:       AutomationKind
  tenantId:   string
  entityType: string
  entity:     Record<string, unknown>
  userId:     string
  /** Already filtered (enabled, tenant, entity/event type) and ordered. */
  records:    AutomationRecord[]
  /** Runs after a record's actions (e.g. bump execution counters); an error here is reported on the record. */
  afterExecute?: (record: AutomationRecord, results: ActionResult[]) => Promise<void>
}

/**
 * Evaluates `records` in order against `entity`: for each one whose
 * conditions match, executes its actions and reports the outcome.
 */
export async function evaluateRules(opts: EvaluateRulesOptions): Promise<AutomationOutcome[]> {
  const spec = KIND_SPEC[opts.kind]
  const entityId = opts.entity['id'] as string
  const results: AutomationOutcome[] = []

  for (const record of opts.records) {
    const base = { id: record.id, name: record.name }

    // Corrupt conditions must NOT run the record (parseConditions would
    // otherwise yield [] = "always matches"). Skip it, report it, log loud.
    let matched: boolean
    try {
      matched = evaluateConditions(parseConditions(record.conditions), opts.entity, record.conditionLogic)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error({ err, kind: opts.kind, id: record.id, name: record.name, tenantId: opts.tenantId },
        `${spec.label} has corrupt conditions — NOT executed, fix its configuration`)
      results.push({ ...base, matched: false, actionsRun: 0, stopped: false, error: `corrupt conditions: ${message}` })
      continue
    }

    if (!matched) {
      results.push({ ...base, matched: false, actionsRun: 0, stopped: false })
      continue
    }

    const execCtx: ActionExecutionContext = {
      tenantId:   opts.tenantId,
      userId:     opts.userId,
      entityId,
      entityType: opts.entityType,
      entity:     opts.entity,
      source:     spec.source,
      sourceName: record.name,
    }

    try {
      // parseActions throws on corrupt JSON — handled below like any action failure
      const actions = parseActions(record.actions)
      const actionResults = await executeActions(actions, execCtx)
      await opts.afterExecute?.(record, actionResults)

      void audit(
        { tenantId: opts.tenantId, userId: opts.userId, userEmail: 'system', role: 'system' } as never,
        spec.auditAction, spec.auditEntity, record.id,
        { [spec.nameKey]: record.name, entityId, actionsRun: actionResults.length },
      )

      const actionsRun = actionResults.filter((r) => r.success).length
      const failed = actionResults.find((r) => !r.success)
      const stopped = record.stopOnMatch
      if (failed) {
        // Partial failure is reported in the result (matched + error), not
        // hidden behind a plain `matched: true` (C-15).
        const error = `action "${failed.action}" failed: ${failed.error ?? 'unknown error'} (${actionsRun}/${actionResults.length} actions ran)`
        results.push({ ...base, matched: true, actionsRun, stopped, error })
        log.error({ kind: opts.kind, id: record.id, name: record.name, entityId, error }, `${spec.label} fired with a failed action`)
      } else {
        results.push({ ...base, matched: true, actionsRun, stopped })
        log.info({ kind: opts.kind, id: record.id, name: record.name, entityId, actionsRun, stopped }, `${spec.label} fired`)
      }

      if (stopped) break
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      results.push({ ...base, matched: true, actionsRun: 0, stopped: false, error })
      log.error({ kind: opts.kind, id: record.id, err }, `${spec.label} execution failed`)
    }
  }

  return results
}

// ── Per-tenant TTL cache for loaded records ──────────────────────────────────

export interface AutomationCache<T> {
  get(tenantId: string, entityType: string, eventType: string, loader: () => Promise<T[]>): Promise<T[]>
  invalidate(tenantId: string): void
}

export function createAutomationCache<T>(prefix: string, ttlMs = 60_000): AutomationCache<T> {
  const cache = new Map<string, { items: T[]; loadedAt: number }>()
  const key = (tenantId: string, entityType: string, eventType: string) => `${prefix}:${tenantId}:${entityType}:${eventType}`
  return {
    async get(tenantId, entityType, eventType, loader) {
      const k = key(tenantId, entityType, eventType)
      const cached = cache.get(k)
      if (cached && Date.now() - cached.loadedAt < ttlMs) return cached.items
      const items = await loader()
      cache.set(k, { items, loadedAt: Date.now() })
      return items
    },
    invalidate(tenantId) {
      for (const k of cache.keys()) {
        if (k.startsWith(`${prefix}:${tenantId}:`)) cache.delete(k)
      }
    },
  }
}
