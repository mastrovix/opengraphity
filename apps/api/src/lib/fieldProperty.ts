/**
 * Campi che l'API espone con un nome e il grafo salva con un altro (giro nel
 * browser del 14 set 2026).
 *
 * Una sola tabella, letta da chi traduce un nome di campo in una proprietà:
 * filtri avanzati (lib/filterBuilder.ts) e widget (resolvers/customWidget.ts).
 * Il test `fieldProperty.test.ts` la confronta con il mapper, così le due cose
 * non divergono.
 *
 * - `Incident.priority` → `severity`: la priorità derivata da impatto × urgenza
 *   si salva in `severity` (services/incidentService.ts), e il mapper espone
 *   `priority: props['severity']`. Prima filtri e widget leggevano
 *   `i.priority`, che non esiste.
 */
export const FIELD_PROPERTY_ALIASES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  Incident: { priority: 'severity' },
}

const toSnakeCase = (s: string): string => s.replace(/[A-Z]/g, (l) => `_${l.toLowerCase()}`)

/** La proprietà del grafo per un campo di un tipo GraphQL (`Incident`, `Problem`…). */
export function propertyForField(typeName: string, field: string): string {
  return FIELD_PROPERTY_ALIASES[typeName]?.[field] ?? toSnakeCase(field)
}
