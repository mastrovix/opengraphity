/**
 * DI CHI È UNA RIGA DI LOG (20 set 2026, dal giro nel browser).
 *
 * ## Il difetto
 * La pagina «Log» legge il buffer circolare del PROCESSO
 * (`lib/logBuffer.ts`), e lo leggeva tutto: un amministratore di un cliente
 * vedeva le righe di ogni altro cliente servito dallo stesso processo. Non
 * sono righe innocue — fra quelle di c-test: «GraphQL error: CI "DB portale
 * clienti" has no Owner Group», cioè il nome di un CI di un altro cliente.
 * Il lint sullo scoping non poteva vederlo: qui non c'è nessuna Cypher, c'è
 * un array in memoria.
 *
 * ## La regola
 * Ogni riga sa di chi è, e la pagina mostra solo le proprie. Il tenant si
 * prende, in ordine:
 *  1. dalla RICHIESTA in corso (questo modulo): vale per tutto ciò che viene
 *     loggato mentre si serve una chiamata GraphQL, comprese le catene
 *     asincrone che ne discendono;
 *  2. dal campo `tenantId` della riga stessa, che i job di sfondo scrivono
 *     già (`{ tenantId, … }, 'messaggio'`).
 * Una riga senza né l'uno né l'altro è di PIATTAFORMA — l'avvio, le code, il
 * bus del metamodello — e non si mostra a nessun cliente: quelle si leggono
 * da «Monitoraggio della piattaforma», che è la pagina di chi amministra il
 * prodotto.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

const storage = new AsyncLocalStorage<string>()

/** Esegue `fn` (la gestione di una richiesta) dichiarando di quale cliente è. */
export function runInLogTenantScope<T>(tenantId: string, fn: () => T): T {
  return storage.run(tenantId, fn)
}

/** Il cliente della richiesta in corso, `null` fuori da una richiesta. */
export function currentLogTenant(): string | null {
  return storage.getStore() ?? null
}
