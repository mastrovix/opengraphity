/**
 * IS THIS RELATION ADMITTED? (owner, 24 Sep 2026: a relation no chain draws
 * is refused when it is created — «è ovviamente la 2» — and CMDB Health
 * counts what got in anyway, so it must always read zero.)
 *
 * The same answer for every way a relation between CIs is born: the
 * `addCIRelationship` mutation (detail, topology, group members), the
 * discovery sync, the «linked» resolution of a sync conflict.
 *
 * The chains govern the relations between the types they draw. A type no
 * chain draws is outside them — a dynamic group, «per definizione un
 * aggregatore di CI esistenti», which «per il momento non ha catene»; a
 * customer's new type until it is drawn — and its relations follow the
 * metamodel alone.
 */
import type { Session } from 'neo4j-driver'
import { loadMetamodel } from '@opengraphity/schema-generator'
import { ENUM_SCOPE } from '../../lib/enumScope.js'
import { ValidationError } from '../../lib/errors.js'
import { admittedRelationKeys, drawnTypeLabels, relationKey } from './model.js'
import { listChains } from './store.js'

/** Answers, for one tenant, whether a relation is admitted: load once, ask many times (a discovery batch). */
export interface RelationAdmission {
  /** How many chains the tenant has drawn. */
  chains: number
  admits(relationType: string, sourceLabels: readonly string[], targetLabels: readonly string[]): boolean
}

export async function relationAdmission(session: Session, tenantId: string): Promise<RelationAdmission> {
  const [chains, types] = await Promise.all([listChains(session, tenantId), loadMetamodel(tenantId, ENUM_SCOPE)])
  const keys = admittedRelationKeys(chains, types)
  const drawn = drawnTypeLabels(chains, types)
  return {
    chains: chains.length,
    admits: (relationType, sourceLabels, targetLabels) =>
      // Outside the chains when either end's type is drawn in none: the metamodel alone decides.
      !sourceLabels.some((l) => drawn.has(l)) || !targetLabels.some((l) => drawn.has(l))
      || sourceLabels.some((s) => targetLabels.some((t) => keys.has(relationKey(s, relationType, t)))),
  }
}

/** The CI type a list of labels names (the label that is not `ConfigurationItem`). */
const typeLabel = (labels: readonly string[]): string => labels.find((l) => l !== 'ConfigurationItem') ?? labels[0] ?? '?'

/** The refusal for a relation the chains do not admit: why, and where to change it. */
export function notAdmittedError(_admission: RelationAdmission, relationType: string, sourceLabels: readonly string[], targetLabels: readonly string[]): ValidationError {
  const source = typeLabel(sourceLabels)
  const target = typeLabel(targetLabels)
  return new ValidationError(
    `No CMDB chain admits ${relationType} from ${source} to ${target}: draw it in a chain in CMDB Health → Chains`,
    { key: 'errors.cmdbChain.relationNotAdmitted', params: { relation: relationType, source, target } },
  )
}

/** Refuses a relation no chain admits. */
export async function assertRelationAdmitted(
  session: Session, tenantId: string, relationType: string, sourceLabels: readonly string[], targetLabels: readonly string[],
): Promise<void> {
  const admission = await relationAdmission(session, tenantId)
  if (!admission.admits(relationType, sourceLabels, targetLabels)) throw notAdmittedError(admission, relationType, sourceLabels, targetLabels)
}
