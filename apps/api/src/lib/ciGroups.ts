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

/**
 * Un gruppo si può ASSEGNARE? Solo se il tipo lo dichiara fra le sue relazioni
 * di sistema (24 Sep 2026, owner: a business capability has no Support Group —
 * «non dovrebbe nemmeno esserci il campo»). The form and the detail already
 * follow the declaration; the inputs of every CI type carry `ownerGroupId` and
 * `supportGroupId` (the schema generator's), so without this a group the type
 * does not have could still be written — and would route incidents to it.
 * Removing is always allowed: it is how a stale one goes away.
 */
export function assertGroupDeclared(ciType: CITypeWithDefinitions, relation: string): void {
  if ((ciType.systemRelations ?? []).some((r) => r.name === relation)) return
  throw new ValidationError(
    `CIs of type "${ciType.label || ciType.name}" have no ${relation}: the type does not declare it.`,
    { key: 'errors.ci.groupNotDeclared', params: { group: relation, type: ciType.label || ciType.name } },
  )
}
