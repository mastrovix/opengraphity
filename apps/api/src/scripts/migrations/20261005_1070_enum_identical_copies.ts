/**
 * LE COPIE IDENTICHE CHE LA MIGRAZIONE DI PRIMA NON AVEVA VISTO (18 set 2026).
 *
 * `20261005_1040` toglieva le copie di un vocabolario spedito identiche in
 * tutto. Ne ha lasciate tre su `c-one` — `priority`, `severity`, `ci_status` —
 * e il suo commento dice perché: «hanno colori diversi».
 *
 * NON È VERO, e l'errore è nel confronto: i colori (e le etichette) per valore
 * sono JSON in una proprietà, e quella migrazione li confrontava come STRINGHE.
 * Le mappe sono le stesse — `{"critical":"danger","high":"orange",…}` contro
 * `{"high":"orange","critical":"danger",…}` — cambia l'ordine delle chiavi,
 * che in una mappa non vuol dire niente. Verificato sui dati veri: le tre
 * mappe sono uguali coppia per coppia.
 *
 * ## Perché una copia identica non è innocua
 * In lettura VINCE la copia del tenant (`loadVocabularyEntries`: cerca la riga
 * del tenant, ripiega sulla spedita). Quindi una copia identica non cambia
 * niente oggi e fa una cosa sola: **scherma dagli aggiornamenti del prodotto**.
 * Un valore aggiunto domani alla lista spedita non arriva a quel tenant; gli
 * arriva come «deriva» da accettare a mano, mentre un tenant nato oggi ce l'ha
 * subito. Il proprietario, vedendo la stessa etichetta due volte nella tendina
 * dei vocabolari: «se la copia non aggiunge nulla allora non ha senso:
 * cancellale».
 *
 * ## Cosa si cancella, e cosa NO
 * Solo una copia uguale allo spedito in tutto: valori NELLO STESSO ORDINE
 * (l'ordine è quello che si vede nelle tendine), etichetta del vocabolario,
 * valore predefinito, e le mappe di etichette e colori per valore confrontate
 * COME MAPPE. E senza nessuna relazione addosso.
 *
 * Su `c-one` restano quindi, ognuna con la sua ragione: `status_change` e
 * `status_incident` (ordine dei valori diverso — sono i passi del workflow di
 * quel cliente), `os` (si chiama «Os» invece di «OS»: una scelta, o una svista
 * che solo il cliente può decidere di correggere), `status` (non esiste
 * spedito con quel nome: è suo). Su `c-test`: `impact` e `change_outcome`.
 *
 * Idempotente: alla seconda esecuzione non trova più niente.
 */
import type { Migration } from '@opengraphity/neo4j'

/** Due mappe JSON sono uguali se hanno le stesse coppie: l'ordine delle chiavi non conta. */
function stessaMappa(a: unknown, b: unknown): boolean {
  const leggi = (v: unknown): Record<string, unknown> => {
    if (v == null || v === '' || v === '{}') return {}
    try { return JSON.parse(String(v)) as Record<string, unknown> } catch { return { __unreadable: String(v) } }
  }
  const x = leggi(a)
  const y = leggi(b)
  const chiavi = Object.keys(x)
  if (chiavi.length !== Object.keys(y).length) return false
  return chiavi.every((k) => JSON.stringify(x[k]) === JSON.stringify(y[k]))
}

export const enumIdenticalCopies: Migration = {
  id: '20261005_1070_enum_identical_copies',
  description: 'Remove tenant vocabulary copies identical to the shipped one, comparing per-value labels and colours as maps',

  async up(session) {
    /*
     * Il confronto delle MAPPE si fa qui e non in Cypher: in Cypher sono
     * stringhe, ed è l'errore che ha lasciato in piedi tre copie. Cypher filtra
     * quello che sa confrontare davvero — i valori in ordine, i testi, le
     * relazioni — e il resto lo decide questo codice.
     */
    const candidati = await session.run(`
      MATCH (c:EnumTypeDefinition)
      WHERE c.tenant_id <> 'system'
      MATCH (s:EnumTypeDefinition {tenant_id: 'system', name: c.name})
      WHERE c.values = s.values
        AND coalesce(c.default_value, '') = coalesce(s.default_value, '')
        AND coalesce(c.label,         '') = coalesce(s.label,         '')
        AND NOT (c)--()
      RETURN c.id AS id, c.tenant_id AS tenantId, c.name AS name,
             c.value_labels AS labels, s.value_labels AS shippedLabels,
             c.value_colors AS colors, s.value_colors AS shippedColors
      ORDER BY tenantId, name
    `)

    const daCancellare = candidati.records.filter((r) =>
      stessaMappa(r.get('labels'), r.get('shippedLabels'))
      && stessaMappa(r.get('colors'), r.get('shippedColors')))

    if (daCancellare.length === 0) {
      console.log(`[${enumIdenticalCopies.id}] nothing to remove: no tenant copy identical to a shipped vocabulary`)
      return
    }

    /*
     * Prima si DICE cosa si cancella, poi si cancella: di una cancellazione sui
     * dati di un cliente si deve poter rispondere «questi, e nessun altro»
     * anche sei mesi dopo, leggendo un log.
     */
    const perTenant = new Map<string, string[]>()
    for (const rec of daCancellare) {
      const tenantId = rec.get('tenantId') as string
      perTenant.set(tenantId, [...(perTenant.get(tenantId) ?? []), rec.get('name') as string])
    }
    for (const [tenantId, nomi] of perTenant) {
      console.log(`[${enumIdenticalCopies.id}] ${tenantId}: removing ${String(nomi.length)} identical copies — ${nomi.join(', ')}`)
    }

    const ids = daCancellare.map((r) => r.get('id') as string)
    /*
     * `DELETE` e non `DETACH DELETE`: la condizione pretende zero relazioni, e
     * se una comparisse fra la lettura e la scrittura Neo4j deve FERMARSI.
     * `DETACH` la staccherebbe in silenzio, e su un vocabolario vuol dire
     * scollegare un campo dal suo elenco di valori senza che nessuno lo sappia.
     */
    const esito = await session.run(`
      MATCH (c:EnumTypeDefinition) WHERE c.id IN $ids AND NOT (c)--()
      DELETE c
      RETURN count(c) AS removed
    `, { ids })
    const tolti = esito.records[0]?.get('removed') as { toNumber?: () => number } | number | undefined
    const quanti = typeof tolti === 'number' ? tolti : (tolti?.toNumber?.() ?? 0)
    console.log(`[${enumIdenticalCopies.id}] removed ${String(quanti)} identical vocabulary copies`)
  },
}
