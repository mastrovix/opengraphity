/**
 * Il resto del metamodello **per cliente**: il ruolo di un tipo nella mappa di
 * un servizio e i tipi di relazione percorribili (ondata 6 · A-10 / C-1 / C-3).
 *
 * ## Il difetto
 * Le etichette dei CI le chiede al metamodello il nucleo
 * (`lib/ciLabelsForTenant.ts`), ma due liste chiuse restavano fuori:
 *
 *  - **il ruolo nella mappa** era una tabella per etichetta
 *    (`ROLE_BY_CI_LABEL`) e `roleOfLabels` lanciava su tutto il resto. Non si
 *    vedeva solo perché il filtro delle etichette scartava il tipo del cliente
 *    prima; aperto quel filtro, la costruzione della mappa sarebbe fallita.
 *  - **i tipi di relazione percorribili** erano quattro
 *    (`SERVICE_RELATIONSHIP_TYPES`) e `assertRelationshipTypes` rifiutava tutto
 *    il resto. Un cliente che modella «BILANCIA» o «REPLICA_SU» definiva la
 *    relazione nel disegnatore, la vedeva nella topologia, e la mappa del
 *    servizio non la percorreva mai: il ramo mancava dall'albero d'impatto, la
 *    finestra di change non silenziava gli allarmi a monte, e nessuno lo diceva.
 *
 * ## La regola
 * Una sorgente sola, per tenant, condivisa fra mappe dei servizi
 * (`services/serviceImpact/build.ts`), soppressione in finestra di change
 * (`services/events/suppression.ts`) e validazione del disegnatore
 * (`addCIRelation`). I quattro tipi spediti col prodotto restano il **seme**:
 * l'unione comprende i tipi di relazione dichiarati dai tipi CI **del
 * cliente**. Le relazioni dei tipi spediti (`REALIZES` per il livello 1,
 * `HAS_MEMBER`, `PARENT_OF`, `ENABLED_BY`) NON entrano: sono la struttura del
 * prodotto, e renderle percorribili cambierebbe il significato delle mappe di
 * tutti senza che nessuno l'abbia chiesto.
 *
 * ## Fail-loud
 * Se il metamodello non si legge l'errore esce (come nel nucleo): una lista
 * incompleta farebbe sparire un ramo dalle mappe, cioè il difetto che stiamo
 * chiudendo. Un `service_role` o un `relationship_type` fuori forma sul grafo
 * ferma chi legge nominando il tipo: normalizzarlo in silenzio falserebbe il
 * peso dei componenti o — per le relazioni, che finiscono **interpolate** nel
 * pattern Cypher della soppressione — sarebbe un buco.
 */
import { ENUM_SCOPE } from './enumScope.js'
import { loadMetamodel } from '@opengraphity/schema-generator'
import { createMetamodelCache } from './metamodelCache.js'
import { CHAIN_FAMILIES } from './chainCalculator.js'
import { logger } from './logger.js'
import {
  ROLE_BY_CI_LABEL, SERVICE_RELATIONSHIP_TYPES, assertServiceRole,
  type ServiceRoleByLabel, type SettableServiceNodeRole,
} from './serviceVocabularies.js'

const log = logger.child({ module: 'ci-metamodel' })

/**
 * Forma di un tipo di relazione Neo4j: MAIUSCOLO_CON_UNDERSCORE. Non è
 * pignoleria — `changeWindowSubqueryCypher` lo **interpola** nel pattern
 * `-[rel:TIPO*1..n]->`, quindi qui passa solo ciò che è un identificatore.
 */
export const RELATIONSHIP_TYPE_RE = /^[A-Z][A-Z0-9_]*$/
/** Oltre questo un tipo di relazione è un errore di chi lo definisce, non un nome. */
export const RELATIONSHIP_TYPE_MAX_LENGTH = 64

/**
 * Valida UN tipo di relazione: forma e lunghezza. La usano
 * `addCIRelation` (prima di scrivere la definizione) e i lettori qui sotto
 * (una definizione già sul grafo non passa in silenzio).
 */
export function assertRelationshipTypeName(value: unknown, what: string): string {
  if (typeof value !== 'string' || !RELATIONSHIP_TYPE_RE.test(value) || value.length > RELATIONSHIP_TYPE_MAX_LENGTH) {
    throw new Error(
      `${what}: ${JSON.stringify(value)} non è un tipo di relazione valido. ` +
      `Ammesso ${RELATIONSHIP_TYPE_RE.source} (MAIUSCOLO_CON_UNDERSCORE), al massimo ${RELATIONSHIP_TYPE_MAX_LENGTH} caratteri.`,
    )
  }
  return value
}

/**
 * `'DEPENDS_ON|HOSTED_ON'` → `['DEPENDS_ON', 'HOSTED_ON']`. Una definizione può
 * dichiarare più tipi separati da `|` (i tipi spediti lo fanno: vedi `server`),
 * ed è così che li legge anche `resolvers/ciFieldResolvers.ts`.
 */
export function splitRelationshipTypes(raw: string, what: string): string[] {
  return raw.split('|').map((s) => s.trim()).filter(Boolean).map((t) => assertRelationshipTypeName(t, what))
}

/**
 * Ruolo di default per un tipo che non lo dichiara, dalle famiglie di catena:
 * solo `Application` → `component` (è software, soffre e non ospita),
 * altrimenti `infrastructure`. Il tipo che NON dichiara famiglie ricade su
 * `infrastructure`, il ruolo più conservativo (peso standard, non critico).
 */
export function defaultServiceRoleOf(chainFamilies: readonly string[] | undefined): SettableServiceNodeRole {
  const [application, infrastructure] = CHAIN_FAMILIES
  const fams = new Set(chainFamilies ?? [])
  return fams.has(application) && !fams.has(infrastructure) ? 'component' : 'infrastructure'
}

interface TenantCIMetamodel {
  /** Etichetta Neo4j → ruolo nella mappa, per i tipi attivi del cliente più il seme dei tipi spediti. */
  roles:             ServiceRoleByLabel
  /** Tipi di relazione percorribili: i quattro spediti più quelli dichiarati dai tipi DEL cliente. */
  relationshipTypes: readonly string[]
}

/** Cache per tenant: la svuota il canale del metamodello, e scade da sé, come il nucleo. */
const cache = createMetamodelCache<TenantCIMetamodel>({
  name: 'ci-metamodel-for-tenant',
  load: (tenantId) => loadRolesAndRelations(tenantId),
})

function metamodelOf(tenantId: string): Promise<TenantCIMetamodel> {
  return cache.get(tenantId)
}

function loadRolesAndRelations(tenantId: string): Promise<TenantCIMetamodel> {
  return loadMetamodel(tenantId, ENUM_SCOPE)
    .then((types) => {
      // Seme: le etichette spedite col prodotto che nel metamodello non hanno
      // un tipo (SslCertificate, VirtualMachine, Storage… — dal vivo 15
      // etichette per 9 tipi base) resterebbero senza ruolo.
      const roles = new Map<string, SettableServiceNodeRole>(Object.entries(ROLE_BY_CI_LABEL))
      const relationshipTypes = new Set<string>(SERVICE_RELATIONSHIP_TYPES)

      for (const t of types) {
        if (t.neo4jLabel) {
          roles.set(t.neo4jLabel, t.serviceRole == null
            ? (ROLE_BY_CI_LABEL[t.neo4jLabel] ?? defaultServiceRoleOf(t.chainFamilies))
            : assertServiceRole(t.serviceRole, `CITypeDefinition "${t.name}".service_role`))
        }
        // Solo i tipi DEL cliente aprono la lista delle relazioni percorribili:
        // le relazioni dei tipi spediti sono la struttura del prodotto.
        if (t.scope !== 'tenant') continue
        for (const r of t.relations) {
          for (const rt of splitRelationshipTypes(r.relationshipType, `CIRelationDefinition "${r.name}" del tipo "${t.name}"`)) {
            relationshipTypes.add(rt)
          }
        }
      }

      const extraRels = [...relationshipTypes].filter((r) => !(SERVICE_RELATIONSHIP_TYPES as readonly string[]).includes(r))
      if (extraRels.length) log.debug({ tenantId, extraRels }, 'Tipi di relazione del cliente percorribili dalle mappe')
      // Ordine stabile: prima i quattro spediti nel loro ordine canonico, poi
      // quelli del cliente in ordine alfabetico. Serve a rendere deterministici
      // i filtri APOC e i pattern Cypher che ne derivano (e i test).
      return {
        roles,
        relationshipTypes: [...SERVICE_RELATIONSHIP_TYPES, ...extraRels.sort()] as readonly string[],
      }
    })
    .catch((err: unknown) => {
      log.error({ tenantId, err }, 'Metamodello dei CI non leggibile: ruoli e tipi di relazione non risolvibili')
      throw err
    })
}

/** Etichetta → ruolo nella mappa, per i tipi attivi di QUESTO cliente. */
export async function serviceRolesForTenant(tenantId: string): Promise<ServiceRoleByLabel> {
  return (await metamodelOf(tenantId)).roles
}

/**
 * I tipi di relazione che le mappe dei servizi possono percorrere e che la
 * soppressione in finestra di change segue a monte, per QUESTO cliente.
 */
export async function serviceRelationshipTypesForTenant(tenantId: string): Promise<readonly string[]> {
  return (await metamodelOf(tenantId)).relationshipTypes
}

/**
 * Gli stessi tipi nella forma del pattern Cypher (`A|B|C`): la usa la
 * soppressione, che li interpola nel pattern di lunghezza variabile.
 */
export async function suppressionRelPatternForTenant(tenantId: string): Promise<string> {
  return (await serviceRelationshipTypesForTenant(tenantId)).join('|')
}

/**
 * Le relazioni del **blast radius** (`impact.ts`): quelle delle mappe più
 * `REALIZES` e `ENABLED_BY`, che legano il servizio alle sue applicazioni e le
 * capacità di business. UNA sorgente sola per mappe, soppressione e blast
 * radius: `resolvers/impact.ts` chiama `impactRelPatternForTenant` (agente A
 * dell'ondata 6), quindi `IMPACT_REL_TYPES` non è più la verità nemmeno lì.
 */
export const IMPACT_EXTRA_REL_TYPES = ['REALIZES', 'ENABLED_BY'] as const

/** Il pattern del blast radius per questo cliente (`A|B|C`). */
export async function impactRelPatternForTenant(tenantId: string): Promise<string> {
  const types = await serviceRelationshipTypesForTenant(tenantId)
  return [...types, ...IMPACT_EXTRA_REL_TYPES.filter((t) => !types.includes(t))].join('|')
}

/** Solo per i test: svuota tutto. */
export function clearCIMetamodelCache(): void {
  cache.clear()
}
