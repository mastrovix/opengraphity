/**
 * DUE CAMPI CON LO STESSO NOME NELLO STESSO TIPO.
 *
 * Trovato nel browser su `c-test`: nelle tendine delle automazioni «Priorità»
 * compariva DUE volte, e così «Impatto» e «Urgenza». Non era l'interfaccia: il
 * metamodello aveva davvero due `CIFieldDefinition` con lo stesso nome sotto lo
 * stesso tipo (5 coppie: incident.impact/urgency/priority, problem.impact/urgency),
 * create dalla migrazione `20260920_1720` che usava
 *
 *     MERGE (t)-[:HAS_FIELD]->(f:CIFieldDefinition {name, tenant_id, scope})
 *
 * con `scope` nella chiave: quando una migrazione successiva ha toccato quei
 * nodi, il MERGE non ha più riconosciuto i suoi e ne ha creati altri. Due
 * definizioni per un campo solo non sono cosmetica — il disegnatore ne mostra
 * due, cancellarne una lascia l'altra, e le regole di visibilità o di fase
 * scritte su una non valgono per l'altra.
 *
 * La migrazione `20261005_1010` toglie i doppioni; questo controllo esiste
 * perché NON accada di nuovo in silenzio: se ricompaiono, la diagnostica lo
 * dice a chi può rimediare, invece di lasciare una tendina con due voci
 * identiche.
 */
import type { Session } from 'neo4j-driver'

export interface DuplicateMetamodelField {
  /** Il tipo che ha il doppione (`incident`, `service_request`, un tipo di CI…). */
  typeName: string
  /** Il nome del campo duplicato. */
  field:    string
  /** Quante definizioni ci sono (sempre ≥ 2). */
  count:    number
}

/**
 * I campi duplicati nel metamodello visibile a questo tenant: i suoi tipi e
 * quelli di sistema, con i campi che si leggono davvero (`tenant_id` del
 * tenant o di sistema, la stessa condizione di `loadITILTypes`).
 */
export async function duplicateMetamodelFields(session: Session, tenantId: string): Promise<DuplicateMetamodelField[]> {
  const r = await session.executeRead((tx) => tx.run(
    `MATCH (t:CITypeDefinition)-[:HAS_FIELD]->(f:CIFieldDefinition)
     WHERE t.tenant_id IN [$tenantId, 'system'] AND f.tenant_id IN [$tenantId, 'system']
     WITH t.name AS typeName, f.name AS field, count(DISTINCT f.id) AS quanti
     WHERE quanti > 1
     RETURN typeName, field, quanti
     ORDER BY typeName, field`,
    { tenantId },
  ))
  return r.records.map((rec) => ({
    typeName: rec.get('typeName') as string,
    field:    rec.get('field')    as string,
    count:    Number(rec.get('quanti')),
  }))
}
