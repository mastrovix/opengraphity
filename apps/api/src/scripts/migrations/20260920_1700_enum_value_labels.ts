/**
 * Ondata 1 delle quattro decise il 13 set 2026 — **le etichette per valore**
 * dei vocabolari spediti.
 *
 * Il valore resta quello che e (`high`): lo scrivono i record, le condizioni
 * delle regole, le matrici di dominio. L'etichetta e come si legge a schermo.
 * Prima non esisteva, e i valori spediti sono parole inglesi in un'interfaccia
 * italiana: il dettaglio di un incident mostrava «high / high».
 *
 * Il proprietario del prodotto ha scelto che la migrazione **semini
 * l'italiano** per i vocabolari spediti, invece di lasciare l'etichetta vuota
 * con ripiego sul valore: cosi il giorno dopo l'interfaccia e in italiano da
 * se, e l'admin puo cambiare ogni etichetta dal Dizionario. Non e la promessa
 * «il primo giorno non cambia niente» delle altre migrazioni, ed e voluto: qui
 * il primo giorno DEVE cambiare, perche l'inglese a schermo era il difetto.
 *
 * ## Perche una lista per vocabolario e non una per valore
 *
 * Lo stesso valore vuole italiani diversi in vocabolari diversi, per concordanza:
 * `low` e **Basso** per l'impatto e il rischio (impatto basso, rischio basso) e
 * **Bassa** per urgenza, priorita e severita. Una tabella `low → Bassa`
 * condivisa avrebbe scritto «impatto Bassa».
 *
 * ## CONGELATA
 *
 * Come `POLICY_17_SET` nella 1810: la lista sta qui, non viene letta da un
 * modulo che domani cambia. Se un domani si aggiunge un valore spedito, questa
 * migrazione non lo conosce — e giusto, perche descrive il 20 set 2026. Il
 * valore nuovo lo segnala la diagnostica della configurazione, dove c'e un
 * admin a cui dirlo.
 *
 * Scritta sui nodi di SISTEMA (`tenant_id = 'system'`): un vocabolario spedito
 * e un nodo per tutti i clienti, quindi l'italiano arriva a tutti senza
 * personalizzare. Chi vuole «Elevato» invece di «Alto» usa «Personalizza», che
 * copia anche le etichette.
 *
 * Idempotente: scrive solo dove `value_labels` e assente.
 */
import type { Migration } from '@opengraphity/neo4j'
import { VOCABULARIES_WITHOUT_LABELS } from '../../lib/enumValueLabels.js'

/**
 * LE ETICHETTE DI QUESTO GIORNO, CONGELATE.
 *
 * `os` e `instance_type` hanno l'etichetta UGUALE al valore, per scelta del
 * proprietario: sono nomi di prodotto (Windows, PostgreSQL) e non si
 * traducono, ma avere la colonna piena evita che nel Dizionario sembrino una
 * dimenticanza.
 *
 * `service_criticality` resta nei termini del settore, che gli operatori
 * italiani usano in inglese: se un cliente li vuole tradotti ora puo farlo dal
 * Dizionario, che e il punto di questa ondata.
 */
export const ENUM_VALUE_LABELS_IT: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  category: {
    hardware: 'Hardware', software: 'Software', network: 'Rete',
    access: 'Accessi', security: 'Sicurezza', other: 'Altro',
  },
  certificate_type: { public: 'Pubblico', external: 'Esterno' },
  change_type:      { standard: 'Standard', normal: 'Normale', emergency: 'Emergenza' },
  ci_chain:         { Application: 'Applicativa', Infrastructure: 'Infrastrutturale' },
  ci_status: {
    active: 'Attivo', inactive: 'Inattivo', maintenance: 'In manutenzione',
    decommissioned: 'Dismesso', expired: 'Scaduto', revoked: 'Revocato',
  },
  environment: {
    production: 'Produzione', staging: 'Collaudo', development: 'Sviluppo',
    testing: 'Test', dr: 'Disaster recovery',
  },
  event_severity: { info: 'Informativo', warning: 'Avviso', critical: 'Critico' },
  // Concordanza: impatto e rischio sono maschili, urgenza/priorita/severita femminili.
  impact:         { low: 'Basso', medium: 'Medio', high: 'Alto' },
  risk:           { low: 'Basso', medium: 'Medio', high: 'Alto' },
  urgency:        { low: 'Bassa', medium: 'Media', high: 'Alta' },
  risk_band:      { low: 'Bassa', medium: 'Media', high: 'Alta' },
  priority:       { low: 'Bassa', medium: 'Media', high: 'Alta', critical: 'Critica' },
  severity:       { low: 'Bassa', medium: 'Media', high: 'Alta', critical: 'Critica' },
  service_criticality: {
    mission_critical:     'Mission critical',
    business_critical:    'Business critical',
    business_operational: 'Business operational',
    office_productivity:  'Produttivita d\'ufficio',
  },
  // Nomi di prodotto: etichetta = valore.
  os:            { Windows: 'Windows', Linux: 'Linux' },
  instance_type: { PostgreSQL: 'PostgreSQL', Oracle: 'Oracle', 'SQL Server': 'SQL Server' },
}

export const enumValueLabelsSeed: Migration = {
  id:          '20260920_1700_enum_value_labels',
  description: 'Etichette italiane per valore sui vocabolari spediti (ondata 1)',

  async up(session) {
    let scritti = 0
    let saltati = 0
    for (const [nome, etichette] of Object.entries(ENUM_VALUE_LABELS_IT)) {
      if (nome in VOCABULARIES_WITHOUT_LABELS) {
        throw new Error(
          `[20260920_1700] "${nome}" e in ENUM_VALUE_LABELS_IT e in VOCABULARIES_WITHOUT_LABELS: ` +
          `una delle due liste va corretta, non si semina un vocabolario dichiarato senza etichette`,
        )
      }
      const r = await session.run(
        `MATCH (e:EnumTypeDefinition {tenant_id: 'system', name: $nome})
         WHERE e.value_labels IS NULL
         SET e.value_labels = $etichette, e.updated_at = $now
         RETURN count(e) AS n`,
        { nome, etichette: JSON.stringify(etichette), now: new Date().toISOString() },
      )
      const n = Number(r.records[0]?.get('n') ?? 0)
      if (n > 0) scritti += n; else saltati += 1
    }
    console.log(
      `[20260920_1700] etichette scritte su ${scritti} vocabolari spediti, ${saltati} gia a posto o assenti. ` +
      `Senza etichette per scelta: ${Object.keys(VOCABULARIES_WITHOUT_LABELS).join(', ')}`,
    )
  },
}
