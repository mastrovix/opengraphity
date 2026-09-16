/**
 * IL TETTO SUI MODULI DEL CATALOGO (ondata 4).
 *
 * Perché esiste: la libreria e i moduli sono dato del cliente, e ogni campo
 * della libreria diventa una proprietà sui ticket, una voce nei filtri e una
 * colonna possibile. Senza un tetto, la prima cosa che si rompe non è il
 * database ma la lista dei filtri e la pagina del modulo — e si rompe piano,
 * senza un errore, quando ormai i dati ci sono.
 *
 * Perché NON è un limite di piano: la ragione del tetto è tecnica, quindi è la
 * stessa per un tenant starter e per un enterprise. Il valore sta sul nodo del
 * tenant e l'amministratore lo cambia dalla pagina dei moduli: è una cinghia di
 * sicurezza che si può allentare sapendo cosa si sta facendo, non una leva
 * commerciale. Se un giorno i piani vorranno dire qualcosa, il posto dove
 * scrivere il numero è già questo.
 *
 * Nessun default a runtime: un tenant senza i numeri è un tenant non migrato, e
 * lo diciamo con il nome della migrazione. La stessa regola di
 * `max_service_maps` — un limite inventato al volo è peggio di un errore.
 */
import type { Queryable } from '@opengraphity/neo4j'
import { runQueryOne } from '@opengraphity/neo4j'
import { ValidationError } from './errors.js'

/** I valori con cui nasce un tenant (migrazione 20261003_1020 e onboarding). */
export const CATALOG_FORM_LIMIT_DEFAULTS = {
  /** Campi della libreria: sopra il centinaio la lista dei filtri non si legge più. */
  maxLibraryFields: 120,
  /** Campi in UN modulo: oltre la sessantina nessuno lo compila fino in fondo. */
  maxFieldsPerForm: 60,
  /**
   * Righe in UNA tabella di un modulo (ondata 7). Ogni riga è un nodo nel
   * grafo: cento righe per ticket su diecimila ticket è un milione di nodi che
   * nessuno ha chiesto. Chi ne ha bisogno di più alza il tetto sapendolo.
   */
  maxTableRows: 50,
} as const

/** Il minimo accettabile per un tetto: sotto 1 vorrebbe dire «nessun modulo». */
export const CATALOG_FORM_LIMIT_MIN = 1
/**
 * Il massimo che l'amministratore può scrivere. Non è un secondo tetto
 * nascosto: è la difesa contro il numero scritto per sbaglio (un incolla, uno
 * zero di troppo), che equivarrebbe a spegnere il tetto senza volerlo.
 */
export const CATALOG_FORM_LIMIT_MAX = 1000

export interface CatalogFormLimits {
  maxLibraryFields: number
  maxFieldsPerForm: number
  /** Righe in una tabella di un modulo (ondata 7). */
  maxTableRows: number
}

const LIMITS_QUERY = `
  MATCH (t:Tenant {id: $tenantId})
  RETURN t.max_form_fields AS maxLibraryFields, t.max_form_fields_per_form AS maxFieldsPerForm,
         t.max_form_table_rows AS maxTableRows`

/** I due tetti del tenant. Fail-loud: mai un numero inventato. */
export async function catalogFormLimits(session: Queryable, tenantId: string): Promise<CatalogFormLimits> {
  const row = await runQueryOne<{ maxLibraryFields: unknown; maxFieldsPerForm: unknown; maxTableRows: unknown }>(session, LIMITS_QUERY, { tenantId })
  if (!row) throw new Error(`Tenant ${tenantId} has no :Tenant node: fix the tenant before using catalog forms`)
  if (row.maxLibraryFields == null || row.maxFieldsPerForm == null) {
    throw new Error(`Tenant ${tenantId} has no catalog form limits — run the 20261003_1020_catalog_form_limits migration`)
  }
  // `max_form_table_rows` è dell'ondata 7: un tenant migrato fino all'ondata 4
  // ce l'ha assente, e la sua migrazione lo scrive.
  if (row.maxTableRows == null) {
    throw new Error(`Tenant ${tenantId} has no max_form_table_rows — run the 20261004_1010_form_table_rows_limit migration`)
  }
  return {
    maxLibraryFields: Number(row.maxLibraryFields),
    maxFieldsPerForm: Number(row.maxFieldsPerForm),
    maxTableRows: Number(row.maxTableRows),
  }
}

/**
 * Un campo in più nella libreria ci sta? Si controlla PRIMA di scrivere.
 * Due creazioni simultanee sull'ultimo posto possono superare il tetto di una
 * (Neo4j non blocca un conteggio): la successiva viene comunque rifiutata.
 */
export async function assertLibraryRoom(session: Queryable, tenantId: string): Promise<void> {
  const { maxLibraryFields } = await catalogFormLimits(session, tenantId)
  const row = await runQueryOne<{ n: unknown }>(session, `
    MATCH (f:FormField {tenant_id: $tenantId}) RETURN count(f) AS n`, { tenantId })
  const quanti = Number(row?.n ?? 0)
  if (quanti >= maxLibraryFields) {
    throw new ValidationError(`The field library is full: ${maxLibraryFields} fields is the limit, ${quanti} already exist. Raise the limit on the catalog forms page, or delete a field nobody uses.`,
      { key: 'errors.formField.libraryFull', params: { max: maxLibraryFields, existing: quanti } })
  }
}

/** Quanti campi cita un modulo: si controlla al salvataggio del modulo. */
export async function assertFormSize(session: Queryable, tenantId: string, fieldCount: number): Promise<void> {
  const { maxFieldsPerForm } = await catalogFormLimits(session, tenantId)
  if (fieldCount > maxFieldsPerForm) {
    throw new ValidationError(`This form has ${fieldCount} fields: ${maxFieldsPerForm} is the limit. Raise the limit on the catalog forms page, or split the request into two catalog items.`,
      { key: 'errors.catalogForm.tooManyFields', params: { max: maxFieldsPerForm, count: fieldCount } })
  }
}

/** Il tetto scritto dall'amministratore: dentro i binari, e un intero. */
export function assertLimitValue(what: string, value: number): number {
  if (!Number.isInteger(value) || value < CATALOG_FORM_LIMIT_MIN || value > CATALOG_FORM_LIMIT_MAX) {
    throw new ValidationError(`${what} must be a whole number between ${CATALOG_FORM_LIMIT_MIN} and ${CATALOG_FORM_LIMIT_MAX}. Got: ${JSON.stringify(value)}`,
      { key: 'errors.catalogForm.limitOutOfRange', params: { what, min: CATALOG_FORM_LIMIT_MIN, max: CATALOG_FORM_LIMIT_MAX } })
  }
  return value
}
