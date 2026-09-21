/**
 * Le etichette inglesi che mancavano perche' IDENTICHE all'italiano.
 *
 * La `1730` ha scritto l'inglese per i vocabolari spediti, ma nella sua lista
 * congelata avevo omesso i valori il cui inglese e' la stessa parola —
 * «Hardware» resta «Hardware», «Software» resta «Software». Sembrava
 * un'economia sensata ed era un difetto: l'etichetta va SCRITTA in entrambe le
 * lingue, altrimenti il controllo `value_labels_partial` segnala «una lingua
 * sola» per sempre. Un banner che si lamenta di cio' che va bene diventa
 * invisibile in una settimana, e allora non segnala piu' nemmeno cio' che non
 * va.
 *
 * Non si modifica la `1730`, che e' gia' applicata (il runner segnalerebbe la
 * deriva del checksum): questa e' una migrazione nuova.
 *
 * Idempotente: scrive solo dove l'inglese manca.
 */
import type { Migration } from '@opengraphity/neo4j'

/** Valore → etichetta inglese, per i casi in cui coincide con l'italiano. */
const IDENTICHE: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  category: { hardware: 'Hardware', software: 'Software' },
}

export const enumValueLabelsIdentiche: Migration = {
  id:          '20260920_1740_enum_value_labels_identiche',
  description: 'Etichette inglesi identiche all\'italiano, che la 1730 aveva omesso',

  async up(session) {
    let scritte = 0
    const r = await session.run(
      `MATCH (e:EnumTypeDefinition) WHERE e.value_labels IS NOT NULL AND e.name IN $nomi
       RETURN e.id AS id, e.tenant_id AS tenant, e.name AS nome, e.value_labels AS et`,
      { nomi: Object.keys(IDENTICHE) },
    )
    for (const rec of r.records) {
      const nome = rec.get('nome') as string
      let mappa: Record<string, Record<string, string>>
      try { mappa = JSON.parse(rec.get('et') as string) as Record<string, Record<string, string>> } catch { continue }
      let cambiato = false
      for (const [valore, en] of Object.entries(IDENTICHE[nome]!)) {
        const per = mappa[valore]
        if (per && typeof per === 'object' && per['en'] === undefined) { per['en'] = en; cambiato = true; scritte += 1 }
      }
      if (!cambiato) continue
      await session.run(
        `MATCH (e:EnumTypeDefinition {id: $id}) SET e.value_labels = $et, e.updated_at = $now`,
        { id: rec.get('id') as string, et: JSON.stringify(mappa), now: new Date().toISOString() },
      )
      console.log(`[20260920_1740] ${rec.get('tenant') as string}/${nome}: etichette inglesi completate`)
    }
    console.log(`[20260920_1740] etichette inglesi scritte: ${scritte}`)
  },
}
