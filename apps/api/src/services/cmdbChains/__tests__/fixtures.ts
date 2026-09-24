/**
 * The shipped CI types as the chains see them: their labels, chain families
 * and declared relations — copied from the live metamodel of 24 Sep 2026, with
 * the instance's certificates of migration 1090 —
 * plus two of a customer's: a network switch of the Infrastructure family
 * only, and a type with no family at all.
 */
import type { CITypeWithDefinitions } from '@opengraphity/schema-generator'

const APP = ['Application']
const BOTH = ['Application', 'Infrastructure']
const INFRA = ['Infrastructure']

let n = 0
const rel = (relationshipType: string, targetType: string, direction: 'outgoing' | 'incoming') =>
  ({ id: `r${String(++n)}`, name: `r${String(n)}`, label: relationshipType, relationshipType, targetType, direction, cardinality: 'many' as const, order: n })

const type = (name: string, neo4jLabel: string, chainFamilies: string[], relations: ReturnType<typeof rel>[]) =>
  ({ id: name, name, label: neo4jLabel, neo4jLabel, chainFamilies, relations, fields: [], systemRelations: [] }) as unknown as CITypeWithDefinitions

export const TYPES: CITypeWithDefinitions[] = [
  type('application', 'Application', APP, [
    rel('DEPENDS_ON', 'any', 'incoming'), rel('DEPENDS_ON', 'any', 'outgoing'), rel('HOSTED_ON', 'Server', 'outgoing'),
    rel('REALIZES', 'BusinessApplication', 'incoming'), rel('USES_CERTIFICATE', 'Certificate', 'outgoing'),
  ]),
  type('business_application', 'BusinessApplication', APP, [
    rel('DEPENDS_ON', 'any', 'incoming'), rel('DEPENDS_ON', 'any', 'outgoing'), rel('ENABLED_BY', 'BusinessCapability', 'incoming'), rel('REALIZES', 'Application', 'outgoing'),
  ]),
  type('business_capability', 'BusinessCapability', APP, [
    rel('ENABLED_BY', 'BusinessApplication', 'outgoing'), rel('PARENT_OF', 'BusinessCapability', 'incoming'), rel('PARENT_OF', 'BusinessCapability', 'outgoing'),
  ]),
  type('certificate', 'Certificate', BOTH, [
    rel('INSTALLED_ON', 'DatabaseInstance', 'outgoing'), rel('INSTALLED_ON', 'Server', 'outgoing'),
    rel('USES_CERTIFICATE', 'Database', 'incoming'), rel('USES_CERTIFICATE', 'Application', 'incoming'), rel('USES_CERTIFICATE', 'DatabaseInstance', 'incoming'),
  ]),
  type('database', 'Database', BOTH, [rel('DEPENDS_ON', 'any', 'incoming'), rel('DEPENDS_ON', 'any', 'outgoing'), rel('USES_CERTIFICATE', 'Certificate', 'outgoing')]),
  type('database_instance', 'DatabaseInstance', BOTH, [
    rel('DEPENDS_ON', 'any', 'outgoing'), rel('DEPENDS_ON', 'any', 'incoming'), rel('HOSTED_ON', 'Server', 'outgoing'), rel('INSTALLED_ON', 'Certificate', 'incoming'),
    rel('USES_CERTIFICATE', 'Certificate', 'outgoing'),
  ]),
  type('dynamic_ci_group', 'DynamicCIGroup', BOTH, [rel('DEPENDS_ON', 'any', 'incoming'), rel('DEPENDS_ON', 'any', 'outgoing'), rel('HAS_MEMBER', 'any', 'outgoing')]),
  type('server', 'Server', BOTH, [rel('DEPENDS_ON|HOSTED_ON', 'any', 'outgoing'), rel('DEPENDS_ON|HOSTED_ON|INSTALLED_ON', 'any', 'incoming')]),
  type('network_switch', 'NetworkSwitch', INFRA, [rel('DEPENDS_ON', 'any', 'incoming')]),
  type('floor_plan', 'FloorPlan', [], [rel('DEPENDS_ON', 'any', 'incoming')]),
]
