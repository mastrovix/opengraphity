/**
 * Quante voci d'Audit Log ha scritto la richiesta in corso (giro UI del 15 set
 * 2026 · U-25, scelta del proprietario: registro unico).
 *
 * Il registro delle mutation (`graphql/auditMutationsPlugin.ts`) deve sapere
 * se una mutation ha già scritto la SUA voce — con nome e dettagli su misura —
 * per non aggiungerne una seconda. Il contesto GraphQL non basta: molte
 * chiamate passano un contesto costruito al volo (`{ tenantId, userId }`), non
 * lo stesso oggetto. Qui il conto vive nella richiesta HTTP, per tutte le
 * chiamate asincrone che ne discendono.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

interface AuditScope { written: number }

const storage = new AsyncLocalStorage<AuditScope>()

/** Esegue `fn` (la gestione di una richiesta GraphQL) con un contatore suo. */
export function runInAuditScope<T>(fn: () => T): T {
  return storage.run({ written: 0 }, fn)
}

/** Lo chiama `audit()`, in modo sincrono, prima di scrivere. Fuori da una richiesta non fa nulla. */
export function noteAuditWritten(): void {
  const scope = storage.getStore()
  if (scope) scope.written++
}

/** Le voci scritte finora nella richiesta; `null` fuori da una richiesta GraphQL. */
export function auditsWrittenInScope(): number | null {
  return storage.getStore()?.written ?? null
}
