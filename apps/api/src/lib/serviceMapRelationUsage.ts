/**
 * Una relazione del metamodello che una mappa di servizio segue non si toglie
 * (revisione del 15 set 2026 · SV-6, scelta del proprietario: rifiutare con
 * l'elenco delle mappe, come CM-4 fa con gli archi).
 *
 * Una mappa salva i tipi di relazione che percorre (`relationship_types`).
 * La costruzione li valida contro quelli percorribili ADESSO dal cliente
 * (services/serviceImpact/build.ts): tolta la sola definizione che dichiarava
 * un tipo, la sincronizzazione, «Sincronizza ora» e la proposta di quella
 * mappa fallivano per sempre, e l'unica uscita era ricrearla perdendo
 * cronologia, esclusioni e regole. Qui si guarda prima: cosa resterebbe
 * percorribile senza quella relazione (o senza quel tipo), e quali mappe
 * seguono un tipo che sparirebbe.
 */
import { runQuery, type Queryable } from '@opengraphity/neo4j'
import { loadMetamodel } from '@opengraphity/schema-generator'
import { ENUM_SCOPE } from './enumScope.js'
import { ValidationError } from './errors.js'
import { traversableRelationshipTypes } from './ciMetamodelForTenant.js'

export const SERVICE_MAPS_FOLLOWING_TYPES_CYPHER = `
  MATCH (m:ServiceMap {tenant_id: $tenantId})
  WHERE any(t IN m.relationship_types WHERE t IN $types)
  RETURN m.name AS name
  ORDER BY name`

/**
 * I tipi di relazione che smetterebbero di essere percorribili togliendo
 * `without`, con l'etichetta di ciò che si toglie (per la frase).
 */
export async function relationshipTypesLostWithout(
  tenantId: string, without: { typeId?: string; relationId?: string },
): Promise<{ lost: string[]; name: string }> {
  const types = await loadMetamodel(tenantId, ENUM_SCOPE)
  const remaining = new Set(traversableRelationshipTypes(types, without))
  const lost = traversableRelationshipTypes(types).filter((t) => !remaining.has(t))
  const type = types.find((t) => t.id === without.typeId)
  const relation = types.flatMap((t) => t.relations).find((r) => r.id === without.relationId)
  return { lost, name: relation?.label || relation?.name || type?.label || type?.name || without.relationId || without.typeId || '' }
}

/**
 * Le mappe che bloccherebbero la rimozione, per nome. La conferma di
 * cancellazione del tipo le legge PRIMA (giro UI del 15 set 2026 · U-16: la
 * conferma elencava cosa sarebbe andato via e il rifiuto arrivava dopo).
 */
export async function serviceMapsBlockingRemoval(
  session: Queryable, tenantId: string, without: { typeId?: string; relationId?: string },
): Promise<{ lost: string[]; name: string; maps: string[] }> {
  const { lost, name } = await relationshipTypesLostWithout(tenantId, without)
  if (lost.length === 0) return { lost, name, maps: [] }
  const maps = (await runQuery<{ name: string | null }>(session, SERVICE_MAPS_FOLLOWING_TYPES_CYPHER, { tenantId, types: lost })).map((r) => r.name ?? '')
  return { lost, name, maps }
}

/** Rifiuta la rimozione se una mappa segue un tipo di relazione che sparirebbe. */
export async function assertNoServiceMapFollows(
  session: Queryable, tenantId: string, without: { typeId?: string; relationId?: string },
): Promise<void> {
  const { lost, name, maps } = await serviceMapsBlockingRemoval(session, tenantId, without)
  if (maps.length === 0) return
  throw new ValidationError(
    `"${name}" was not removed: it is the only declaration of ${lost.join(', ')}, which ${maps.length} service map(s) follow (${maps.join(', ')}). `
    + `Without it those maps could no longer be synchronized. Remove the relationship type from the maps first (service detail → Scope).`,
    { key: 'errors.ciType.relationUsedByServiceMaps', params: { name, relationshipTypes: lost.join(', '), count: maps.length, maps: maps.join(', ') } },
  )
}
