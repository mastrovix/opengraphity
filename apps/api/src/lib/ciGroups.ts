/**
 * I gruppi di un CI (proprietario e supporto) come relazioni di sistema del
 * suo tipo. Modulo leggero di proposito: lo usano la scrittura del CI
 * (`resolvers/ciMutations.ts`) e l'assegnazione dei team (`resolvers/team.ts`).
 */
import type { CITypeWithDefinitions } from '@opengraphity/schema-generator'
import { ValidationError } from './errors.js'

/**
 * Un gruppo del CI si può togliere? No, se il metamodello del tipo lo dichiara
 * obbligatorio (revisione del 15 set 2026 · CM-6): il CI resterebbe senza owner
 * e le change su di lui fallirebbero dopo, lontano da chi l'ha tolto.
 */
export function assertGroupRemovable(ciType: CITypeWithDefinitions, relation: string): void {
  const sr = (ciType.systemRelations ?? []).find((r) => r.name === relation)
  if (!sr?.required) return
  const group = sr.label || sr.name
  throw new ValidationError(
    `${group} is required for CIs of type "${ciType.label || ciType.name}": it can be changed, not removed.`,
    { key: 'errors.ci.requiredGroup', params: { group, type: ciType.label || ciType.name } },
  )
}
