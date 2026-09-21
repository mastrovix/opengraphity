/**
 * LE ETICHETTE del vocabolario `team_type`, appena nato.
 *
 * Perché una migrazione a parte e non due righe in quella di dieci minuti
 * prima: le migrazioni applicate non si modificano, e la 1000 l'ho già
 * applicata. Ma soprattutto la cosa è arrivata dal posto giusto — appena il
 * vocabolario è esistito, la **diagnostica della configurazione** l'ha detto
 * da sé, in cima alla pagina Team: «questi valori non hanno etichetta in
 * nessuna lingua, quindi a schermo si leggono col nome interno: team_type:
 * owner, support». Era il comportamento previsto (la 1700 è congelata al 20
 * set 2026 di proposito, e un valore spedito nuovo lo segnala la diagnostica),
 * e questa migrazione è la risposta.
 *
 * Il formato è quello della 1730: `{ valore: { it, en } }` serializzato in
 * `value_labels`, sul nodo di SISTEMA — un vocabolario spedito è un nodo per
 * tutti i clienti, quindi le etichette arrivano a tutti senza personalizzare.
 *
 * Idempotente e conservativa: scrive solo se `value_labels` è assente. Un
 * cliente che ha già personalizzato il vocabolario ha una copia sua, e quella
 * non si tocca.
 */
import type { Migration } from '@opengraphity/neo4j'
import { TEAM_TYPE_VOCABULARY } from '../../lib/teamVocabularies.js'

/**
 * «Owner» e «Support» come li chiama chi ci lavora: il team che POSSIEDE un CI
 * e quello che lo SUPPORTA — sono i due lati di `OWNED_BY` / `SUPPORTED_BY`,
 * e in italiano si dicono «Proprietario» e «Supporto».
 */
const ETICHETTE: Readonly<Record<string, { it: string; en: string }>> = {
  owner:   { it: 'Proprietario', en: 'Owner' },
  support: { it: 'Supporto',     en: 'Support' },
}

export const teamTypeEtichette: Migration = {
  id:          '20260921_1010_team_type_etichette',
  description: 'Etichette it/en per i valori di team_type (owner → Proprietario, support → Supporto)',

  async up(session) {
    const r = await session.run(
      `MATCH (e:EnumTypeDefinition {tenant_id: 'system', name: $nome})
       WHERE e.value_labels IS NULL
       SET e.value_labels = $etichette, e.updated_at = $now
       RETURN count(e) AS n`,
      { nome: TEAM_TYPE_VOCABULARY, etichette: JSON.stringify(ETICHETTE), now: new Date().toISOString() },
    )
    const n = Number(r.records[0]?.get('n') ?? 0)
    console.log(n > 0
      ? `[20260921_1010] etichette scritte su ${TEAM_TYPE_VOCABULARY}: ${Object.entries(ETICHETTE).map(([v, l]) => `${v} → ${l.it}/${l.en}`).join(', ')}`
      : `[20260921_1010] ${TEAM_TYPE_VOCABULARY} ha già le etichette (o non esiste): niente da fare`)
  },
}
