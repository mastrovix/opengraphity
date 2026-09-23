/**
 * HOW FAR APART TWO CIs ARE DRAWN, BY RELATION TYPE (D76, tour of 23 Sep 2026).
 *
 * The table below knows three relation types. Every other one — `REALIZES`
 * (a business application realizes an application), `PARENT_OF` and
 * `ENABLED_BY` (the capability hierarchy), all declared by the tenant's
 * metamodel — was logged as «unknown value», once per edge: twenty lines in
 * the console for one map, for relations that are perfectly normal.
 *
 * Now a type the metamodel declares is a normal type: it takes the default
 * distance. Only a type the metamodel does NOT declare is reported — once per
 * type and drawing — because that is data the metamodel cannot explain.
 */

/** Relation types with a distance of their own: the tightest bonds are drawn closest. */
const DISTANCE: Readonly<Record<string, number>> = { HOSTED_ON: 80, DEPENDS_ON: 120, CONNECTS_TO: 100 }

/** Every other declared relation type. */
export const DEFAULT_RELATION_DISTANCE = 110

interface RelationLike { relationshipType: string }
export interface CITypeRelations {
  relations?: readonly RelationLike[] | undefined
  systemRelations?: readonly RelationLike[] | undefined
}

/**
 * The relation types the tenant's metamodel declares, on every CI type
 * (relations and system relations). One declaration can hold several types
 * (`DEPENDS_ON | HOSTED_ON`). `null` while the metamodel is not known: then
 * nothing can be called unknown.
 */
export function declaredRelationTypes(ciTypes: readonly CITypeRelations[] | undefined): ReadonlySet<string> | null {
  // Types that came without their relations say nothing about what is declared.
  if (!ciTypes || !ciTypes.some((ct) => ct.relations !== undefined || ct.systemRelations !== undefined)) return null
  const declared = new Set<string>()
  for (const ct of ciTypes) {
    for (const r of [...(ct.relations ?? []), ...(ct.systemRelations ?? [])]) {
      for (const part of r.relationshipType.split('|')) {
        const type = part.trim()
        if (type) declared.add(type)
      }
    }
  }
  return declared
}

/** The distance of one relation type; an undeclared type is reported once on `reported`. */
export function relationDistance(type: string, declared: ReadonlySet<string> | null, reported: Set<string>): number {
  const own = DISTANCE[type]
  if (own !== undefined) return own
  if (declared !== null && !declared.has(type) && !reported.has(type)) {
    reported.add(type)
    console.error(`[EDGE_DIST] relation type not declared by the metamodel: "${type}"`)
  }
  return DEFAULT_RELATION_DISTANCE
}

/** The link distance of one drawing (d3 `forceLink().distance`): each undeclared type reported once. */
export function linkDistance(ciTypes: readonly CITypeRelations[] | undefined): (link: { relType: string }) => number {
  const declared = declaredRelationTypes(ciTypes)
  const reported = new Set<string>()
  return (link) => relationDistance(link.relType, declared, reported)
}
