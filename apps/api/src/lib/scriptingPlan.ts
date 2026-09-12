/**
 * Limite di piano sugli script del cliente (`TenantSettings.scripting_enabled`
 * — lib/tenantPlans.ts: starter no, pro e enterprise sì).
 *
 * La proprietà esisteva, veniva scritta dall'onboarding e dalle migrazioni e
 * **non veniva letta da nessuno** (D-12): gli script del cliente giravano anche
 * per i tenant che non hanno la funzione. Qui c'è l'unica lettura, usata dai
 * tre punti d'esecuzione:
 *   1. validazione del metamodello   (resolvers/ciMutations.ts)
 *   2. azione `execute_script`       (lib/actionExecutor.ts)
 *   3. script di trasformazione      (rest/webhooks-inbound.ts)
 *
 * Niente silenzio in nessuna delle due direzioni: con il piano che non li
 * include lo script **non viene eseguito** e l'operazione **fallisce dicendolo**
 * (ValidationError → BAD_USER_INPUT su GraphQL, 400 su REST), invece di essere
 * saltato senza che nessuno lo sappia. Un tenant senza nodo `:Tenant` o senza
 * la proprietà è un errore che nomina la migrazione, non un limite inventato
 * a runtime (stessa regola di `assertServiceMapPlanLimit`).
 *
 * **Cosa NON è uno script del cliente**: gli script che il prodotto spedisce
 * nel metamodello condiviso (`scope` `base`/`itil`, `tenant_id = 'system'`:
 * oggi la validazione di `url`, `ipAddress`, `expiresAt` e del tipo
 * `certificate`). Non sono la funzione «scripting» del piano, sono il
 * comportamento del prodotto: applicare il limite anche a loro impedirebbe di
 * creare un CI a **ogni** tenant starter. Il limite vale per le definizioni
 * `scope: 'tenant'`, cioè quelle scritte dal cliente.
 */
import { getSession } from '@opengraphity/neo4j'
import { ValidationError } from './errors.js'

export const SCRIPTING_PLAN_CACHE_TTL_MS = 60_000

export const SCRIPTING_PLAN_CYPHER = `
  MATCH (t:Tenant {id: $tenantId})
  RETURN t.plan AS plan, t.scripting_enabled AS scriptingEnabled`

export interface ScriptingPlan {
  plan:    string
  enabled: boolean
}

interface CachedPlan extends ScriptingPlan { expiresAt: number }

const planCache = new Map<string, CachedPlan>()

/** Senza argomento svuota tutto (test, cambio di piano, shutdown). */
export function invalidateScriptingPlanCache(tenantId?: string): void {
  if (tenantId === undefined) planCache.clear()
  else planCache.delete(tenantId)
}

/**
 * `scripting_enabled` del tenant, con cache per processo a TTL breve (la
 * validazione del metamodello gira a ogni create/update di CI). Su più repliche
 * un cambio di piano arriva alle altre entro il TTL: limite noto, come per le
 * altre cache in memoria dell'API.
 */
export async function getScriptingPlan(tenantId: string, nowMs: number = Date.now()): Promise<ScriptingPlan> {
  const hit = planCache.get(tenantId)
  if (hit && hit.expiresAt > nowMs) return { plan: hit.plan, enabled: hit.enabled }

  const session = getSession()
  try {
    const result = await session.executeRead((tx) => tx.run(SCRIPTING_PLAN_CYPHER, { tenantId }))
    const record = result.records[0]
    if (!record) {
      throw new Error(`Tenant ${tenantId} has no :Tenant node — run the 20260910_1070_event_management_tenants migration`)
    }
    const enabled = record.get('scriptingEnabled') as unknown
    if (typeof enabled !== 'boolean') {
      throw new Error(`Tenant ${tenantId} has no scripting_enabled (got ${JSON.stringify(enabled ?? null)}) — run the 20260909_1010_event_management_fixup migration`)
    }
    const plan = record.get('plan') as unknown
    if (typeof plan !== 'string' || plan === '') {
      throw new Error(`Tenant ${tenantId} has no plan (got ${JSON.stringify(plan ?? null)}): fix the tenant before running scripts`)
    }
    planCache.set(tenantId, { plan, enabled, expiresAt: nowMs + SCRIPTING_PLAN_CACHE_TTL_MS })
    return { plan, enabled }
  } finally {
    await session.close()
  }
}

/**
 * Ferma l'operazione se il piano del tenant non include gli script.
 * `what` nomina lo script che si stava per eseguire (campo, regola,
 * webhook): il messaggio arriva all'amministratore, quindi dice cosa
 * rimuovere o quale piano serve.
 */
export async function assertScriptingEnabled(tenantId: string, what: string): Promise<void> {
  const { plan, enabled } = await getScriptingPlan(tenantId)
  if (!enabled) {
    throw new ValidationError(
      `${what}: il piano "${plan}" del tenant ${tenantId} non include gli script (scripting_enabled = false). ` +
      `Rimuovi lo script dalla configurazione oppure passa a un piano che li include.`,
    )
  }
}

/**
 * Scope delle definizioni di metamodello **spedite dal prodotto**: i loro
 * script non sono la funzione «scripting» del cliente e non passano dal limite
 * di piano. Tutto il resto (`scope: 'tenant'`, e per prudenza uno scope
 * assente o sconosciuto) è del cliente: il limite si applica.
 */
export const SHARED_DEFINITION_SCOPES: readonly string[] = ['base', 'itil']

export function isTenantOwnedDefinition(scope: string | undefined): boolean {
  return !SHARED_DEFINITION_SCOPES.includes(scope ?? '')
}
