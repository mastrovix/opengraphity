import { Sandbox, type ScriptContext, type ScriptResult } from './sandbox.js'
import { validateScript } from './validate.js'

// ── Script definition ────────────────────────────────────────────────────────

export type ScriptTrigger =
  | 'incident.created'
  | 'incident.updated'
  | 'incident.resolved'
  | 'change.created'
  | 'change.approved'
  | 'change.rejected'
  | 'problem.created'
  | 'problem.resolved'
  | 'request.created'
  | 'request.completed'
  | 'manual'

export interface ScriptDefinition {
  id: string
  tenant_id: string
  name: string
  description?: string
  trigger: ScriptTrigger
  /** The JS source code to execute. */
  code: string
  enabled: boolean
  /** Memory limit override for this script (MB). Defaults to sandbox default. */
  memory_limit_mb?: number
  /** Timeout override for this script (ms). Defaults to sandbox default. */
  timeout_ms?: number
  created_at: string
  updated_at: string
}

export interface ScriptRunOptions {
  /** If true, run even if validation fails (use with caution). */
  skipValidation?: boolean
}

// ── Runner ───────────────────────────────────────────────────────────────────

/**
 * Validates and executes a ScriptDefinition in an isolated sandbox.
 * Each call creates a fresh V8 Isolate — no state leaks between runs.
 */
export async function runScript(
  definition: ScriptDefinition,
  context: ScriptContext,
  options?: ScriptRunOptions,
): Promise<ScriptResult> {
  // Static validation unless explicitly skipped
  if (!options?.skipValidation) {
    const validation = validateScript(definition.code)
    if (!validation.valid) {
      return {
        success:     false,
        logs:        [],
        error:       `Script validation failed: ${validation.errors.join('; ')}`,
        duration_ms: 0,
      }
    }
  }

  if (!definition.enabled) {
    return {
      success:     false,
      logs:        [],
      error:       `Script "${definition.name}" is disabled`,
      duration_ms: 0,
    }
  }

  const sb = new Sandbox({
    memoryLimitMb: definition.memory_limit_mb,
    timeoutMs:     definition.timeout_ms,
  })

  const enrichedContext: ScriptContext = {
    ...context,
    _script: { id: definition.id, name: definition.name, trigger: definition.trigger },
  }

  const result = await sb.run(definition.code, enrichedContext)

  console.log(
    `[scripting] Script "${definition.name}" (${definition.id}) — ` +
      `${result.success ? 'OK' : 'FAILED'} in ${result.duration_ms}ms` +
      (result.error ? ` — ${result.error}` : ''),
  )

  return result
}

/**
 * Runs all enabled scripts that match the given trigger for the tenant.
 * Failures are isolated — one script failing does not stop the others.
 */
export async function runScriptsForTrigger(
  definitions: ScriptDefinition[],
  trigger: ScriptTrigger,
  tenantId: string,
  context: ScriptContext,
): Promise<Map<string, ScriptResult>> {
  const matching = definitions.filter(
    (d) => d.enabled && d.trigger === trigger && d.tenant_id === tenantId,
  )

  const results = new Map<string, ScriptResult>()

  await Promise.all(
    matching.map(async (def) => {
      const result = await runScript(def, context)
      results.set(def.id, result)
    }),
  )

  return results
}
