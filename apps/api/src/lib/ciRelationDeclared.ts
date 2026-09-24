import type { CITypeWithDefinitions } from '@opengraphity/schema-generator'

/**
 * Il metamodello dichiara l'arco `relType` da un CI con etichetta `sourceLabel`
 * a uno con etichetta `targetLabel`? O come relazione in uscita del tipo
 * sorgente, o come relazione in entrata del tipo destinazione; `targetType` è
 * l'etichetta dell'altro capo o `any`. È lo stesso predicato di
 * `relationDeclared` (ciRelationships.ts), qui sui tipi già caricati.
 */
export function relationDeclaredBy(
  types: readonly CITypeWithDefinitions[], relType: string, sourceLabel: string, targetLabel: string,
): boolean {
  const lists = (t: CITypeWithDefinitions, dir: 'outgoing' | 'incoming', other: string) =>
    t.relations.some((r) => r.direction === dir
      && r.relationshipType.split('|').map((x) => x.trim()).includes(relType)
      && (r.targetType === 'any' || r.targetType === other))
  return types.some((t) => (t.neo4jLabel === sourceLabel && lists(t, 'outgoing', targetLabel))
    || (t.neo4jLabel === targetLabel && lists(t, 'incoming', sourceLabel)))
}
