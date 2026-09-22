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

/**
 * LE COPIE CHE NON AGGIUNGONO NIENTE (18 set 2026).
 *
 * Personalizzare un vocabolario vuol dire farne una copia che vince per nome, e
 * il prodotto non la tocca più: da quel momento un valore aggiunto alla lista
 * spedita non arriva (è `vocabulariesBehindShipped`, sopra). È un prezzo che ha
 * senso pagare quando la copia SERVE — etichette per valore, colori, un ordine
 * diverso, valori in più o in meno.
 *
 * Una copia che invece è uguale in tutto non compra niente e paga lo stesso
 * prezzo: resta indietro in silenzio alla prima aggiunta del prodotto. Nascono
 * così — un provisioning ripetuto, un'importazione — e nessuno se ne accorge,
 * perché a schermo si vede una riga sola.
 *
 * «Uguale in tutto» vuol dire: stessi valori NELLO STESSO ORDINE (l'ordine è
 * quello che si vede nelle tendine), stessa etichetta del vocabolario, e
 * stesse etichette e colori PER VALORE — non «senza etichette», che era la
 * prima versione e non serviva a niente: le copie nascono dal provisioning
 * CON le etichette di fabbrica dentro, e confrontarle con «vuoto» le
 * assolveva tutte (trovato sui dati veri di c-one, 18 set 2026).
 *
 * Se differisce qualcosa — un ordine diverso, un'etichetta rinominata — la
 * copia sta facendo il suo mestiere e non si tocca.
 */
export interface VocabularyRedundantCopy {
  id:    string
  name:  string
  label: string
}

/** Due mappe JSON sono uguali se hanno le stesse coppie: l'ORDINE DELLE CHIAVI non conta. */
export function stessaMappa(a: unknown, b: unknown): boolean {
  const leggi = (v: unknown): Record<string, unknown> => {
    if (v == null || v === '' || v === '{}') return {}
    if (typeof v === 'object') return v as Record<string, unknown>
    try { return JSON.parse(String(v)) as Record<string, unknown> } catch { return { __illeggibile: String(v) } }
  }
  const x = leggi(a)
  const y = leggi(b)
  const cx = Object.keys(x)
  if (cx.length !== Object.keys(y).length) return false
  return cx.every((k) => JSON.stringify(x[k]) === JSON.stringify(y[k]))
}

export async function vocabulariesCopiedWithoutChanges(session: Queryable, tenantId: string): Promise<VocabularyRedundantCopy[]> {
  /*
   * IL CONFRONTO SI FA QUI, NON IN CYPHER, e su mappe PARSATE.
   *
   * Le etichette e i colori per valore sono JSON in una proprietà: confrontarli
   * come stringhe dice «diverse» anche quando cambia solo l'ordine delle
   * chiavi — ed è quello che succede davvero, perché la copia le riscrive
   * mentre le rilegge. Sui dati di c-one tre copie identiche in tutto
   * risultavano diverse per questo (18 set 2026), e la regola non trovava mai
   * niente: un controllo che non può accendersi è peggio di nessun controllo.
   */
  // `tenant-ok(condivisi)`: la copia è del tenant, la spedita è del tenant condiviso 'system'.
  const rows = await runQuery<{
    id: string; name: string; label: string
    values: unknown; shippedValues: unknown
    labels: unknown; shippedLabels: unknown
    colors: unknown; shippedColors: unknown
    shippedLabel: string | null
  }>(session, `
    MATCH (c:EnumTypeDefinition {tenant_id: $tenantId})
    MATCH (s:EnumTypeDefinition {tenant_id: 'system', name: c.name})
    RETURN c.id AS id, c.name AS name, coalesce(c.label, c.name) AS label,
           c.values AS values, s.values AS shippedValues,
           c.value_labels AS labels, s.value_labels AS shippedLabels,
           c.value_colors AS colors, s.value_colors AS shippedColors,
           s.label AS shippedLabel
    ORDER BY toLower(coalesce(c.label, c.name))
  `, { tenantId })

  return rows
    .filter((r) => {
      const suoi = list(r.values, `Dictionary "${r.name}": values`)
      const spediti = list(r.shippedValues, `Shipped dictionary "${r.name}": values`)
      // L'ordine dei VALORI conta: è quello che si vede nelle tendine.
      if (suoi.length !== spediti.length || suoi.some((v, i) => v !== spediti[i])) return false
      if ((r.label ?? '') !== (r.shippedLabel ?? '')) return false
      return stessaMappa(r.labels, r.shippedLabels) && stessaMappa(r.colors, r.shippedColors)
    })
    .map((r) => ({ id: r.id, name: r.name, label: r.label }))
}
