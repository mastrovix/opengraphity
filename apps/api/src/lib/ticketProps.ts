/**
 * Le proprietà del grafo da cui è nato un ticket mappato per GraphQL.
 *
 * I mapper (`mapIncident`, `mapProblem`, `mapChange`, `mapRequest`) espongono
 * campi scelti; i campi personalizzati del cliente (ondata 4) sono proprietà
 * che il mapper non conosce. Il mapper le allega qui, NON enumerabili: non
 * finiscono nelle risposte, nei confronti dei test né nelle copie, e il campo
 * `customFields` non deve rileggere il ticket per ogni riga di una lista.
 */
const PROPS = Symbol.for('opengraphity.ticketProps')

export function withTicketProps<T extends object>(mapped: T, props: Record<string, unknown>): T {
  Object.defineProperty(mapped, PROPS, { value: props, enumerable: false })
  return mapped
}

export function ticketPropsOf(mapped: object): Record<string, unknown> | null {
  return ((mapped as Record<symbol, unknown>)[PROPS] as Record<string, unknown> | undefined) ?? null
}
