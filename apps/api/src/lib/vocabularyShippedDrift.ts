/**
 * I VALORI SPEDITI CHE LA COPIA DEL CLIENTE NON HA (revisione del 14 set 2026 · F20).
 *
 * Un vocabolario personalizzato è una copia che vince per nome, e il prodotto
 * non la sovrascrive: è la scelta giusta, perché la copia è del cliente. Il
 * rovescio è che un valore aggiunto al vocabolario spedito DOPO la copia non
 * arriva a chi l'ha personalizzato, e nessuno lo diceva.
 *
 * La copia ricorda i valori spediti che ha già VISTO (`shipped_values_seen`):
 * la lista spedita al momento della copia, poi quella dell'ultima decisione
 * dell'amministratore (adottarli o tenerli fuori). Un valore spedito tolto di
 * proposito è già visto, quindi non torna a segnalare; una copia nata prima di
 * questo campo non ha visto niente, e segnala tutto ciò che le manca finché
 * l'amministratore non decide.
 */
import { runQuery, type Queryable } from '@opengraphity/neo4j'

/** Spediti − valori della copia − spediti già visti, nell'ordine spedito. */
export function newShippedValues(shipped: readonly string[], copy: readonly string[], seen: readonly string[] | null): string[] {
  const have = new Set([...copy, ...(seen ?? [])])
  return shipped.filter((v) => !have.has(v))
}

export interface VocabularyDrift {
  /** L'id della COPIA del cliente. */
  id:        string
  name:      string
  newValues: string[]
}

function list(value: unknown, what: string): string[] {
  if (value == null) return []
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error(`${what} is not a list of strings (${JSON.stringify(value)})`)
  }
  return value as string[]
}

/** Le copie del cliente a cui manca almeno un valore spedito non ancora visto. */
export async function vocabulariesBehindShipped(session: Queryable, tenantId: string): Promise<VocabularyDrift[]> {
  const rows = await runQuery<{ id: string; name: string; values: unknown; seen: unknown; shipped: unknown }>(session, `
    MATCH (c:EnumTypeDefinition {tenant_id: $tenantId})
    MATCH (s:EnumTypeDefinition {tenant_id: 'system', name: c.name})
    RETURN c.id AS id, c.name AS name, c.values AS values, c.shipped_values_seen AS seen, s.values AS shipped
    ORDER BY name
  `, { tenantId })
  const out: VocabularyDrift[] = []
  for (const r of rows) {
    const seen = r.seen == null ? null : list(r.seen, `Dictionary "${r.name}": shipped_values_seen`)
    const newValues = newShippedValues(list(r.shipped, `Shipped dictionary "${r.name}": values`), list(r.values, `Dictionary "${r.name}": values`), seen)
    if (newValues.length > 0) out.push({ id: r.id, name: r.name, newValues })
  }
  return out
}
