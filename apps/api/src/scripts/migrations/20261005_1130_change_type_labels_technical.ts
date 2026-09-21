/**
 * «STANDARD, NORMAL, EMERGENCY» ANCHE IN ITALIANO (20 set 2026, decisione del
 * proprietario: «usa l'inglese per i vocaboli tecnici»).
 *
 * È la regola che il prodotto ha già scritta: si traduce ciò che DESCRIVE,
 * resta inglese ciò che NOMINA. «Audit Log», «Dry-run», «Incident»,
 * «Problem», «Change» sono le parole che chi fa ITSM usa parlando italiano, e
 * i tre tipi di change sono della stessa famiglia: una *normal change* la si
 * chiama così anche in una riunione in italiano. «Normale» ed «Emergenza»
 * erano una traduzione di troppo — la 1700 aveva seminato l'italiano per
 * tutti i vocabolari spediti, e questi tre ci erano finiti dentro insieme
 * agli altri.
 *
 * Si tocca solo l'etichetta ITALIANA, e SOLO dove è ancora quella seminata:
 * se il cliente l'ha rinominata, l'etichetta è sua e resta com'è — il
 * disegnatore vince sempre sul prodotto (F-22). Il VALORE (`normal`) non si
 * tocca mai: lo scrivono i record, le condizioni delle regole e le matrici.
 *
 * Vale sui nodi di sistema e sulle copie dei tenant che hanno personalizzato
 * il vocabolario (la 1710 ci aveva copiato le stesse etichette).
 *
 * Idempotente: alla seconda esecuzione l'italiano è già l'inglese e non trova
 * più niente da cambiare.
 */
import type { Migration } from '@opengraphity/neo4j'

/** Il valore → l'italiano SEMINATO dalla 1700, che qui si sostituisce. */
const SEMINATE = { standard: 'Standard', normal: 'Normale', emergency: 'Emergenza' } as const

interface Etichetta { it?: string; en?: string }

export const changeTypeLabelsTechnical: Migration = {
  id: '20261005_1130_change_type_labels_technical',
  description: 'change_type: the Italian label goes back to the technical English (Standard, Normal, Emergency)',

  async up(session) {
    const righe = await session.run(
      `MATCH (e:EnumTypeDefinition {name: 'change_type'})
       WHERE e.value_labels IS NOT NULL
       RETURN e.tenant_id AS tenantId, e.value_labels AS etichette`,
    )

    let cambiati = 0
    for (const rec of righe.records) {
      const tenantId = String(rec.get('tenantId'))
      const grezzo = rec.get('etichette') as string
      let mappa: Record<string, Etichetta>
      try {
        mappa = JSON.parse(grezzo) as Record<string, Etichetta>
      } catch {
        /*
         * Un `value_labels` illeggibile non si riscrive a indovinare: si dice
         * e si lascia stare. Riscriverlo vorrebbe dire buttare le etichette
         * di un cliente senza sapere cosa c'era.
         */
        console.log(`[${changeTypeLabelsTechnical.id}] ${tenantId}: value_labels illeggibile, non toccato`)
        continue
      }

      let toccato = false
      for (const [valore, seminata] of Object.entries(SEMINATE)) {
        const voce = mappa[valore]
        if (voce == null) continue
        // Solo se è ANCORA quella seminata: una rinomina del cliente resta.
        if (voce.it !== seminata) continue
        const tecnico = voce.en
        if (tecnico == null || tecnico === voce.it) continue
        voce.it = tecnico
        toccato = true
      }
      if (!toccato) continue

      await session.run(
        `MATCH (e:EnumTypeDefinition {tenant_id: $tenantId, name: 'change_type'})
         SET e.value_labels = $etichette, e.updated_at = $now`,
        { tenantId, etichette: JSON.stringify(mappa), now: new Date().toISOString() },
      )
      cambiati += 1
      console.log(`[${changeTypeLabelsTechnical.id}] ${tenantId}: etichette italiane allineate al tecnico`)
    }

    console.log(`[${changeTypeLabelsTechnical.id}] ${cambiati} vocabolari change_type aggiornati`)
  },
}
