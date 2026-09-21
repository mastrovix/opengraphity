/**
 * Personalizzazioni, ondata 8 (D-14) — un tenant nasce in **un** modo.
 *
 * ## Il difetto
 * Di modi ce n'erano due, e solo uno rendeva il tenant usabile:
 * `scripts/onboard-tenant.ts` (nodo `:Tenant`, utente, dashboard, regole di
 * notifica, matrici di dominio e tutte le definizioni di workflow) e le
 * migrazioni `20260909_1010` / `20260910_1070`, che creano il solo nodo
 * `:Tenant` con la policy eventi — il caso previsto del tenant «solo
 * integrazione» (nato da un webhook, da una chiave API o da un import) e quello
 * non previsto dell'onboarding interrotto.
 *
 * `c-two` è nel secondo stato: dal vivo, prima di questa migrazione, **0**
 * `WorkflowDefinition`. Il suo primo `createIncident` muore a voce alta con
 * «No active workflow definition for "incident" in tenant "c-two"» — corretto
 * come rifiuto, inutile come esperienza: il tenant esiste e non può fare
 * niente, e nessuno lo sa finché qualcuno non ci prova.
 *
 * ## Cosa fa
 * Per ogni `:Tenant` chiama `provisionTenantData` — la **stessa** funzione
 * dell'onboarding (`lib/provisionTenantData.ts`). Additiva e idempotente per
 * costruzione: ogni pezzo è un MERGE «solo dove manca», e una definizione di
 * workflow o una matrice già presenti non vengono riallineate al seme (regola
 * dell'ondata 2: il seed non cancella il disegnatore). Su un tenant completo,
 * quindi, non cambia niente.
 *
 * Il tenant condiviso `system` non è un cliente — non ha ticket, non ha
 * dashboard — ed è escluso.
 *
 * ## In coda: `ci_chain.values` da stringa a lista (A-18)
 * `seed-metamodel.ts` scriveva i valori di **quel solo** vocabolario come
 * stringa JSON (`"[\"Application\",\"Infrastructure\"]"`) mentre tutti gli
 * altri sono liste, e `mapEnum` doveva tollerare le due forme. Nessun danno
 * oggi, un difetto al primo consumatore che facesse `values.length`. Qui il
 * nodo già scritto viene normalizzato, così `mapEnum` può tornare a pretendere
 * una lista sola (e a lanciare, invece di indovinare).
 */
import type { Migration } from '@opengraphity/neo4j'
import { provisionTenantData, tenantProvisioningGaps } from '../../lib/provisionTenantData.js'

/** Il tenant dei nodi spediti col prodotto: non è un cliente. */
export const SHARED_TENANT_ID = 'system'

export const provisionTenantDataMigration: Migration = {
  id: '20260918_1910_provision_tenant_data',
  description: 'D-14: one way to be born — run provisionTenantData (dashboard, notification rules, domain matrices, workflow definitions) for every :Tenant, so tenants created by a migration are as usable as onboarded ones',
  async up(session) {
    const tenants = await session.run(`
      MATCH (t:Tenant)
      WHERE t.id IS NOT NULL AND t.id <> $shared
      RETURN t.id AS id ORDER BY t.id
    `, { shared: SHARED_TENANT_ID })

    for (const record of tenants.records) {
      const tenantId = String(record.get('id'))
      const before = await tenantProvisioningGaps(session, tenantId)
      if (before.length === 0) {
        console.log(`[${provisionTenantDataMigration.id}] ${tenantId}: già completo — nulla da fare`)
        continue
      }
      const result = await provisionTenantData(session, tenantId)
      const after = await tenantProvisioningGaps(session, tenantId)
      console.log(
        `[${provisionTenantDataMigration.id}] ${tenantId}: mancava [${before.join(' · ')}] → ` +
        `dashboard ${result.dashboardCreated ? 'creata' : 'già presente'}, ` +
        `${result.notificationRulesCreated} regole di notifica, ` +
        `matrici create: ${result.matricesCreated.length === 0 ? 'nessuna' : result.matricesCreated.join(', ')}, ` +
        `${result.workflows.length} definizioni di workflow verificate` +
        (after.length === 0 ? '' : ` — ATTENZIONE, resta da sistemare: [${after.join(' · ')}]`),
      )
    }

    console.log(`[${provisionTenantDataMigration.id}] ${tenants.records.length} tenant esaminati (escluso "${SHARED_TENANT_ID}")`)

    // A-18: `values` come lista, in tutti i vocabolari. Il valore era una
    // stringa JSON solo per `ci_chain`, e il `JSON.parse` di ripiego in
    // `mapEnum` spariva con questa riga.
    const normalized = await session.run(`
      MATCH (e:EnumTypeDefinition)
      WHERE e.values IS NOT NULL AND NOT e.values IS :: LIST<ANY>
      RETURN e.tenant_id AS tenantId, e.name AS name, e.values AS values
    `)
    for (const record of normalized.records) {
      const raw = record.get('values')
      if (typeof raw !== 'string') {
        throw new Error(`EnumTypeDefinition ${String(record.get('tenantId'))}/${String(record.get('name'))}: values non è né una lista né una stringa (${typeof raw}); sistemalo prima di migrare`)
      }
      let parsed: unknown
      try { parsed = JSON.parse(raw) }
      catch (e) { throw new Error(`EnumTypeDefinition ${String(record.get('tenantId'))}/${String(record.get('name'))}: values è una stringa che non è JSON (${e instanceof Error ? e.message : String(e)}); sistemalo prima di migrare`) }
      if (!Array.isArray(parsed) || parsed.some((v) => typeof v !== 'string')) {
        throw new Error(`EnumTypeDefinition ${String(record.get('tenantId'))}/${String(record.get('name'))}: values non è una lista di stringhe; sistemalo prima di migrare`)
      }
      await session.run(`
        MATCH (e:EnumTypeDefinition {tenant_id: $tenantId, name: $name})
        SET e.values = $values, e.updated_at = $now
      `, { tenantId: record.get('tenantId'), name: record.get('name'), values: parsed, now: new Date().toISOString() })
      console.log(`[${provisionTenantDataMigration.id}] ${String(record.get('tenantId'))}/${String(record.get('name'))}: values da stringa JSON a lista (${parsed.length} valori)`)
    }
    if (normalized.records.length === 0) console.log(`[${provisionTenantDataMigration.id}] nessun vocabolario con values non-lista`)
  },
}
