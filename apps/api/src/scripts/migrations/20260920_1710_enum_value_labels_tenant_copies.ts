/**
 * Le etichette per valore anche sulle COPIE DEI TENANT (ondata 1, seguito).
 *
 * La `1700` ha scritto l'italiano sui vocabolari di SISTEMA, e va bene per chi
 * non ha personalizzato niente. Ma una copia del tenant VINCE in lettura su
 * quella spedita: chi aveva personalizzato `priority`, `severity` o
 * `environment` continuava a leggerli in inglese — cioe proprio i clienti che
 * hanno usato il prodotto piu a fondo. Trovato dalla diagnostica appena
 * accesa, su `c-one`: «questi valori non hanno un'etichetta» per tre
 * vocabolari.
 *
 * Non si modifica la `1700`, che e gia applicata (il runner segnalerebbe la
 * deriva del checksum): questa e una migrazione nuova, e legge la sua lista
 * congelata.
 *
 * Cosa fa, e solo questo:
 *  - guarda le copie dei tenant che portano il nome di un vocabolario di cui
 *    conosciamo le traduzioni;
 *  - scrive le etichette SOLO per i valori che quella copia ha davvero — un
 *    valore aggiunto dal cliente non lo conosciamo, e resta senza (la
 *    diagnostica lo dira all'admin, che e l'unico a poterlo nominare);
 *  - solo dove `value_labels` e assente: chi ha gia scritto le sue etichette
 *    non viene toccato.
 *
 * Idempotente: alla seconda esecuzione non manca piu nulla e non scrive.
 */
import type { Migration } from '@opengraphity/neo4j'
import { ENUM_VALUE_LABELS_IT } from './20260920_1700_enum_value_labels.js'

export const enumValueLabelsTenantCopies: Migration = {
  id:          '20260920_1710_enum_value_labels_tenant_copies',
  description: 'Etichette italiane per valore anche sulle copie dei tenant (ondata 1, seguito)',

  async up(session) {
    const now = new Date().toISOString()
    let toccati = 0
    for (const [nome, etichette] of Object.entries(ENUM_VALUE_LABELS_IT)) {
      // Le copie senza etichette, coi loro valori: le traduzioni si scelgono
      // per copia, perche due clienti possono averne valori diversi.
      const copie = await session.run(
        `MATCH (e:EnumTypeDefinition {name: $nome})
         WHERE e.tenant_id <> 'system' AND e.value_labels IS NULL
         RETURN e.id AS id, e.tenant_id AS tenant, e.values AS values`,
        { nome },
      )
      for (const rec of copie.records) {
        const values = rec.get('values')
        if (!Array.isArray(values)) continue
        const mie = Object.fromEntries(
          (values as string[]).filter((v) => v in etichette).map((v) => [v, etichette[v]!]),
        )
        if (Object.keys(mie).length === 0) continue
        await session.run(
          `MATCH (e:EnumTypeDefinition {id: $id})
           WHERE e.value_labels IS NULL
           SET e.value_labels = $etichette, e.updated_at = $now`,
          { id: rec.get('id') as string, etichette: JSON.stringify(mie), now },
        )
        toccati += 1
        console.log(
          `[20260920_1710] ${rec.get('tenant') as string}/${nome}: ` +
          `${String(Object.keys(mie).length)} etichette su ${String((values as string[]).length)} valori`,
        )
      }
    }
    console.log(`[20260920_1710] copie dei tenant aggiornate: ${toccati}`)
  },
}
