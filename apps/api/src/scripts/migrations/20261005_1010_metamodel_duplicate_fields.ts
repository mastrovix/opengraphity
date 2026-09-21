/**
 * VIA I CAMPI DEFINITI DUE VOLTE NELLO STESSO TIPO.
 *
 * Trovato nel browser su `c-test`: nelle tendine delle automazioni «Priorità»
 * compariva due volte, e con lei «Impatto» e «Urgenza». Non era l'interfaccia.
 * Il metamodello aveva davvero cinque doppioni —
 * incident.impact/urgency/priority e problem.impact/urgency — creati dalla
 * migrazione `20260920_1720`, che faceva
 *
 *     MERGE (t)-[:HAS_FIELD]->(f:CIFieldDefinition {name, tenant_id, scope})
 *
 * con `scope` DENTRO la chiave: appena un'altra migrazione ha toccato quei nodi
 * il MERGE non ha più riconosciuto i propri e ne ha creati altri. (Quella
 * migrazione è stata corretta nello stesso commit: ora la chiave è
 * tipo + nome + tenant, e `scope` si scrive solo alla creazione.)
 *
 * ## Quale copia resta
 *
 * La PIÙ VECCHIA: è quella che le migrazioni successive hanno aggiornato (ha
 * `updated_at`, ha le etichette per lingua) ed è quella a cui puntano gli
 * eventuali legami. Le altre si cancellano con `DETACH DELETE`, che porta via
 * anche il loro `USES_ENUM`.
 *
 * ## Perché si può cancellare senza perdere dati
 *
 * Un `CIFieldDefinition` è una DEFINIZIONE: il valore vive come proprietà del
 * ticket, con il nome del campo — non con l'id della definizione. Togliere la
 * copia in eccesso non tocca nessun valore. Per prudenza la migrazione
 * cancella solo i nodi che non hanno legami oltre a `HAS_FIELD` e `USES_ENUM`:
 * se qualcosa punta al doppione (una regola di visibilità, per dire) lo LASCIA
 * e lo dice, invece di portarsi via il riferimento di nascosto.
 *
 * Idempotente: al secondo giro non trova più doppioni e non scrive niente.
 */
import type { Migration } from '@opengraphity/neo4j'

export const metamodelDuplicateFields: Migration = {
  id:          '20261005_1010_metamodel_duplicate_fields',
  description: 'toglie i campi del metamodello definiti due volte nello stesso tipo (incident/problem impact, urgency, priority)',

  async up(session) {
    /*
     * I gruppi con più di una definizione, ognuno con le copie in eccesso già
     * scelte: si ordina per `created_at` e si tiene la prima. `collect` dopo
     * un `ORDER BY` conserva l'ordine, quindi `tail(...)` sono le copie.
     */
    const doppioni = await session.run(
      `MATCH (t:CITypeDefinition)-[:HAS_FIELD]->(f:CIFieldDefinition)
       WITH t, f.name AS nome, f.tenant_id AS di, f
       ORDER BY coalesce(f.created_at, '') ASC, f.id ASC
       WITH t, nome, di, collect(f) AS copie
       WHERE size(copie) > 1
       RETURN t.name AS tipo, t.scope AS scope, nome, di,
              [c IN tail(copie) | {id: c.id, altri: size([(c)<-[r]-() WHERE type(r) <> 'HAS_FIELD' | r])}] AS eccesso`,
    )

    let tolti = 0
    let lasciati = 0
    for (const rec of doppioni.records) {
      const tipo    = rec.get('tipo') as string
      const nome    = rec.get('nome') as string
      const eccesso = rec.get('eccesso') as Array<{ id: string; altri: unknown }>
      for (const copia of eccesso) {
        const altri = Number(copia.altri)
        if (altri > 0) {
          // Fail-loud: qualcosa punta al doppione. Non si cancella di nascosto.
          console.warn(
            `[20261005_1010] ${tipo}.${nome}: la copia ${copia.id} ha ${altri} legami oltre a HAS_FIELD — LASCIATA. ` +
            `Va guardata a mano: cancellarla porterebbe via quei riferimenti.`,
          )
          lasciati += 1
          continue
        }
        await session.run(
          `MATCH (f:CIFieldDefinition {id: $id}) DETACH DELETE f`,
          { id: copia.id },
        )
        console.log(`[20261005_1010] ${tipo}.${nome}: cancellata la copia in eccesso ${copia.id}`)
        tolti += 1
      }
    }
    console.log(`[20261005_1010] doppioni tolti: ${tolti}, lasciati (con legami): ${lasciati}`)
  },
}
