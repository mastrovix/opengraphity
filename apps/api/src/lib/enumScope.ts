/**
 * Ambito dei vocabolari (`EnumTypeDefinition`) quando un campo li usa via
 * `USES_ENUM` — il nucleo dell'ondata «isolamento fra tenant» (A-2 / C-6).
 *
 * ## Il difetto
 * Tutti i siti di lettura facevano `OPTIONAL MATCH (f)-[:USES_ENUM]->(e)`
 * **senza filtro di tenant**. E i campi spediti col prodotto vivono su nodi
 * CONDIVISI (`tenant_id = 'system'`, scope `base`/`itil`), quindi il loro
 * legame all'enum è unico per tutti i clienti: dal vivo, 30 campi condivisi
 * (`incident.severity`, `__base__.status`, `server.os`, …) risultavano
 * agganciati ai vocabolari di **c-one**, e ogni altro cliente vedeva e
 * assegnava i valori di c-one. L'enum agganciato vince anche sull'
 * `enum_values` inline del campo, perciò il cliente non vedeva nemmeno i
 * propri valori.
 *
 * ## Il modello
 * 1. **I vocabolari spediti stanno su `tenant_id = 'system'`**, come i tipi e i
 *    campi spediti. Un campo condiviso può essere agganciato SOLO a un
 *    vocabolario di sistema (la scrittura lo impone, vedi `assertEnumLinkable`).
 * 2. **Il cliente personalizza per nome**: se il tenant ha un vocabolario con
 *    lo STESSO nome di quello agganciato, il suo vince in lettura. È così che
 *    un cliente rinomina i valori di `severity` senza toccare il nodo
 *    condiviso, ed è così che `c-one` conserva gli stati `expired`/`revoked`
 *    aggiunti al suo `ci_status`.
 * 3. **Un legame verso un vocabolario di un ALTRO tenant non esiste**: in
 *    lettura viene ignorato (il campo ricade sui suoi `enum_values` inline),
 *    in scrittura è rifiutato.
 *
 * Precedenza, in una riga: `vocabolario del tenant > quello agganciato (di
 * sistema) > enum_values inline del campo`.
 *
 * Niente cache: la lettura è una sola query da poche righe per richiesta di
 * metamodello. Una cache qui vorrebbe un'invalidazione fra replica e replica
 * per una tabella che cambia una volta al mese.
 */
import type { Session } from 'neo4j-driver'
import { ValidationError } from './errors.js'

/** Il tenant delle definizioni spedite col prodotto. */
export const SYSTEM_TENANT = 'system'

/**
 * Filtro da mettere **subito dopo** un `OPTIONAL MATCH (…)-[:USES_ENUM]->(v)`:
 * il vocabolario di un altro tenant non viene nemmeno letto. La query deve
 * passare `$tenantId`.
 */
export function enumScopeClause(enumVar: string): string {
  return `WHERE ${enumVar}.tenant_id IN [$tenantId, '${SYSTEM_TENANT}']`
}

export interface EnumOverride {
  id:     string
  name:   string
  values: string[]
}

/** Righe di campo come le collezionano le query del metamodello. */
export interface EnumRow {
  enumId:     string | null
  enumName:   string | null
  enumValues: string[] | string | null
}

function parseValues(raw: unknown, name: string): string[] {
  if (Array.isArray(raw)) return raw as string[]
  if (typeof raw === 'string') {
    let parsed: unknown
    try { parsed = JSON.parse(raw) }
    catch (e) { throw new Error(`Vocabolario "${name}": values non è JSON valido (${e instanceof Error ? e.message : String(e)})`) }
    if (!Array.isArray(parsed)) throw new Error(`Vocabolario "${name}": values non è un array (${typeof parsed})`)
    return parsed as string[]
  }
  throw new Error(`Vocabolario "${name}": values assente o di tipo inatteso (${typeof raw})`)
}

/**
 * I vocabolari PROPRI del tenant, per nome: sono le sue personalizzazioni e
 * vincono su quelli di sistema agganciati ai campi condivisi.
 */
export async function loadTenantEnumOverrides(session: Session, tenantId: string): Promise<Map<string, EnumOverride>> {
  if (tenantId === SYSTEM_TENANT) return new Map()
  const r = await session.executeRead((tx) =>
    tx.run(
      `MATCH (e:EnumTypeDefinition {tenant_id: $tenantId})
       RETURN e.id AS id, e.name AS name, e.values AS values`,
      { tenantId },
    ),
  )
  const out = new Map<string, EnumOverride>()
  for (const rec of r.records) {
    const name = rec.get('name') as string
    out.set(name, { id: rec.get('id') as string, name, values: parseValues(rec.get('values'), name) })
  }
  return out
}

/**
 * Applica la personalizzazione del tenant a una riga di campo. Se il tenant ha
 * un vocabolario con lo stesso nome di quello agganciato, la riga punta al SUO
 * (id, nome e valori), altrimenti resta com'è.
 */
export function applyEnumOverride<T extends EnumRow>(row: T, overrides: Map<string, EnumOverride>): T {
  if (!row.enumName) return row
  const own = overrides.get(row.enumName)
  if (!own || own.id === row.enumId) return row
  return { ...row, enumId: own.id, enumName: own.name, enumValues: own.values }
}

/** `applyEnumOverride` su una lista (le query collezionano liste di campi). */
export function applyEnumOverrides<T extends EnumRow>(rows: readonly T[], overrides: Map<string, EnumOverride>): T[] {
  return rows.map((row) => applyEnumOverride(row, overrides))
}

/** Un campo è «condiviso» quando vive su un nodo spedito col prodotto. */
export const SHARED_FIELD_SCOPES: readonly string[] = ['base', 'itil']

export function isSharedField(field: { scope?: string | null; tenantId?: string | null }): boolean {
  return SHARED_FIELD_SCOPES.includes(field.scope ?? '') || field.tenantId === SYSTEM_TENANT
}

/**
 * Il legame `USES_ENUM` che si sta per scrivere è ammesso?
 *
 * - vocabolario di sistema → sempre;
 * - vocabolario del tenant su un campo SUO → sì, è la personalizzazione;
 * - vocabolario del tenant su un campo CONDIVISO → **no**: il nodo è uno per
 *   tutti i clienti, quindi quel legame mostrerebbe i valori di questo cliente
 *   a tutti gli altri (è esattamente il difetto A-2/C-6, dal vivo su 30 campi);
 *   la strada è creare un vocabolario con lo stesso nome, che vince in lettura
 *   solo per chi lo possiede;
 * - vocabolario di un altro tenant → no, e il messaggio lo dice.
 */
export function assertEnumLinkable(
  enumDef:  { id: string; name: string; tenantId: string },
  field:    { name: string; scope?: string | null; tenantId?: string | null },
  tenantId: string,
): void {
  if (enumDef.tenantId === SYSTEM_TENANT) return
  if (enumDef.tenantId !== tenantId) {
    throw new ValidationError(
      `Il vocabolario "${enumDef.name}" appartiene a un altro cliente: non può essere agganciato al campo "${field.name}".`,
    )
  }
  if (isSharedField(field)) {
    throw new ValidationError(
      `Il campo "${field.name}" è spedito col prodotto ed è condiviso da tutti i clienti: non può essere agganciato al tuo vocabolario "${enumDef.name}", ` +
      `perché i tuoi valori finirebbero anche negli altri clienti. Crea un vocabolario con il nome "${enumDef.name}" ` +
      `— il tuo vince in lettura solo per te.`,
    )
  }
}
