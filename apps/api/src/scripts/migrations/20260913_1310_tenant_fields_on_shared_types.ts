/**
 * Personalizzazioni, ondata 1 (A-5) — i campi di un cliente appesi ai tipi
 * SPEDITI col prodotto.
 *
 * ## Il difetto che questa migrazione bonifica
 * `addCIField` accettava qualunque tipo con `tenant_id IN [$tenantId,
 * 'system']`, e sul `__base__` (che è di sistema, uno per tutti i clienti)
 * scriveva il campo con `scope: 'base'`, `is_system: true` e il `tenant_id` di
 * CHI aveva cliccato. Le letture del metamodello non filtravano il tenant,
 * quindi quel campo entrava nel metamodello di **ogni** cliente, e da lì nella
 * query dinamica di **ogni** tipo: `generateSDL` esclude i campi `is_system`,
 * perciò la pagina di dettaglio di qualunque CI rispondeva
 * `Cannot query field "<campo>" on type "<Tipo>"`. Un clic, e la CMDB di tutti
 * era rotta — e `removeCIField` (che richiede `t.scope = 'tenant'`) non lo
 * annullava: era un no-op silenzioso.
 *
 * La correzione è nel codice (`addCIField` rifiuta, `removeCIField` si ferma e
 * lo dice, le letture filtrano per tenant). Questa migrazione è la **rete per
 * i clienti veri**: i campi che qualcuno avesse già creato così.
 *
 * ## Perché RIMUOVERLI e non riassegnarli
 * 1. Un campo così **non è mai stato usabile**: nasceva `is_system: true`, e
 *    `generateSDL` esclude i campi di sistema sia dai tipi sia dagli input.
 *    Non è mai entrato nello schema, quindi nessuna scrittura del prodotto ha
 *    potuto valorizzarlo su un CI. Era solo il detonatore dell'errore.
 * 2. Riassegnarlo al tenant (`scope: 'tenant'`) lo lascerebbe appeso al
 *    `__base__` CONDIVISO: comparirebbe in cima a ogni tipo del proprietario e
 *    nello SDL, cioè trasformerebbe l'inquinamento in una modifica di modello
 *    che nessuno ha chiesto. Il campo di tenant su un tipo condiviso è una
 *    funzione da progettare (non è di questa ondata); finché non c'è, la
 *    strada è «un campo sul proprio tipo».
 * 3. **Niente cancellazioni al buio**: prima di togliere il campo si guarda se
 *    qualche nodo del cliente porta davvero quella proprietà (import, sync,
 *    script). Se sì la migrazione **si ferma** e nomina campo, tipo e quanti
 *    nodi: quel dato si guarda in faccia prima di buttare la definizione.
 *
 * Dal vivo (12 set 2026) i campi in questa condizione sono **0**: la
 * migrazione lo dice e non scrive niente. Idempotente per costruzione (alla
 * seconda esecuzione non trova più nulla).
 */
import type { Migration } from '@opengraphity/neo4j'

/** Gli scope dei tipi/campi spediti col prodotto. */
const SHIPPED_SCOPES = ['base', 'itil'] as const

/** `server_farm` → `ServerFarm` (la label Neo4j delle istanze del tipo). */
function toPascalCase(name: string): string {
  return name.split(/[_\s-]+/).filter(Boolean).map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('')
}

export const tenantFieldsOnSharedTypes: Migration = {
  id: '20260913_1310_tenant_fields_on_shared_types',
  description: 'Personalizzazioni (ondata 1, A-5): remove the tenant-owned fields wrongly attached to shipped CI types (scope base/itil with a tenant_id other than system) — stopping if any node actually carries the property',
  async up(session) {
    const offenders = await session.run(`
      MATCH (t:CITypeDefinition)-[:HAS_FIELD]->(f:CIFieldDefinition)
      WHERE f.scope IN $shippedScopes
        AND coalesce(f.tenant_id, 'system') <> 'system'
      RETURN f.id AS fieldId, f.name AS fieldName, f.scope AS fieldScope,
             f.tenant_id AS fieldTenant, f.is_system AS isSystem,
             t.name AS typeName, t.tenant_id AS typeTenant
      ORDER BY t.name, f.name
    `, { shippedScopes: [...SHIPPED_SCOPES] })

    if (offenders.records.length === 0) {
      console.log(
        `[${tenantFieldsOnSharedTypes.id}] nessun campo di un cliente appeso ai tipi spediti ` +
        `(scope base/itil con tenant_id diverso da 'system'): niente da bonificare.`,
      )
      return
    }

    // 1° passaggio: i dati. Se un nodo porta davvero la proprietà, STOP.
    const withData: string[] = []
    for (const record of offenders.records) {
      const fieldName = String(record.get('fieldName'))
      const typeName  = String(record.get('typeName'))
      const tenantId  = String(record.get('fieldTenant'))
      const label     = toPascalCase(typeName)
      const used = await session.run(`
        MATCH (n {tenant_id: $tenantId})
        WHERE $label IN labels(n) AND $fieldName IN keys(n)
        RETURN count(n) AS n
      `, { tenantId, label, fieldName })
      const n = Number(used.records[0]?.get('n') ?? 0)
      if (n > 0) withData.push(`${typeName}.${fieldName} (${tenantId}): ${n} nodi ${label} portano la proprietà`)
    }

    if (withData.length > 0) {
      throw new Error(
        `[${tenantFieldsOnSharedTypes.id}] STOP: ci sono campi di un cliente appesi a un tipo spedito che portano DATI:\n  ` +
        withData.join('\n  ') +
        `\nQuesta migrazione non cancella definizioni di campi valorizzati. Sposta i valori su un campo di un tuo tipo ` +
        `(o esportali) e ri-esegui: il resto della bonifica è automatico.`,
      )
    }

    // 2° passaggio: rimozione. `DETACH DELETE` porta via anche l'HAS_FIELD e
    // l'eventuale USES_ENUM, che è l'altra metà del difetto (A-2).
    const log: string[] = []
    for (const record of offenders.records) {
      const fieldId   = String(record.get('fieldId'))
      const fieldName = String(record.get('fieldName'))
      const typeName  = String(record.get('typeName'))
      const tenantId  = String(record.get('fieldTenant'))
      await session.run(`
        MATCH (f:CIFieldDefinition {id: $fieldId, tenant_id: $tenantId})
        DETACH DELETE f
      `, { fieldId, tenantId })
      log.push(`${typeName}.${fieldName} (${tenantId}, scope ${String(record.get('fieldScope'))}) rimosso`)
    }

    console.log(
      `[${tenantFieldsOnSharedTypes.id}] campi di clienti rimossi dai tipi spediti: ${log.length}\n  ` +
      log.join('\n  '),
    )
  },
}
