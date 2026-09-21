/**
 * QUALI CAMPI SONO DAVVERO CONDIVISI (18 set 2026).
 *
 * Da oggi un campo nasce DENTRO un modulo e resta suo: compare fra i campi da
 * riusare solo se qualcuno lo dice (`shared`). È la scelta del proprietario,
 * che nella barra degli attrezzi si ritrovava gli scarti di ogni prova.
 *
 * I campi nati prima non hanno quella proprietà, e leggerli come «non
 * condivisi» sarebbe una bugia per quelli che DUE moduli usano davvero: quelli
 * sono condivisi nei fatti, comunque siano nati, e toglierli dalla libreria
 * vorrebbe dire che il prossimo modulo rifà la stessa domanda con un nome
 * diverso — cioè due colonne per la stessa cosa in ogni report.
 *
 * Quindi: `shared = true` per i campi usati da più di un modulo, `false` per
 * tutti gli altri. Il conto dei moduli si fa sul documento pubblicato di ogni
 * voce di catalogo, che è dove il campo viene citato per nome.
 *
 * Idempotente: scrive un valore, non lo accumula.
 */
import type { Migration } from '@opengraphity/neo4j'

export const formFieldsShared: Migration = {
  id: '20261005_1080_form_fields_shared',
  description: 'Mark form fields shared when more than one catalog form uses them; the others become private to their form',

  async up(session) {
    /*
     * I nomi citati dai moduli si leggono dal JSON della definizione: il
     * modello non ha una relazione campo→modulo (il modulo cita il campo per
     * NOME, ed è quello che rende una domanda una colonna sola nei report).
     */
    const moduli = await session.run(`
      MATCH (i:ServiceCatalogItem)
      WHERE i.form IS NOT NULL AND i.form <> ''
      RETURN i.tenant_id AS tenantId, i.form AS form
    `)

    /** tenant → nome del campo → quanti moduli lo citano. */
    const usi = new Map<string, Map<string, number>>()
    for (const rec of moduli.records) {
      const tenantId = rec.get('tenantId') as string
      let definizione: { sections?: { items?: { field?: string }[] }[] }
      try { definizione = JSON.parse(rec.get('form') as string) as typeof definizione } catch { continue }
      const nomi = new Set(
        (definizione.sections ?? []).flatMap((s) => (s.items ?? []).map((i) => i.field).filter((f): f is string => typeof f === 'string')),
      )
      const perTenant = usi.get(tenantId) ?? new Map<string, number>()
      for (const n of nomi) perTenant.set(n, (perTenant.get(n) ?? 0) + 1)
      usi.set(tenantId, perTenant)
    }

    const condivisi: { tenantId: string; name: string }[] = []
    for (const [tenantId, perTenant] of usi) {
      for (const [name, quanti] of perTenant) if (quanti > 1) condivisi.push({ tenantId, name })
    }

    // Prima tutti privati, poi si accendono quelli che lo sono nei fatti: due
    // scritture invece di una perché la seconda è l'eccezione, e si legge.
    const tutti = await session.run(`
      MATCH (f:FormField) SET f.shared = false RETURN count(f) AS n
    `)
    const n = tutti.records[0]?.get('n') as { toNumber?: () => number } | number | undefined
    console.log(`[${formFieldsShared.id}] ${String(typeof n === 'number' ? n : (n?.toNumber?.() ?? 0))} fields set private`)

    if (condivisi.length === 0) {
      console.log(`[${formFieldsShared.id}] no field is used by more than one form: nothing to share`)
      return
    }
    const esito = await session.run(`
      UNWIND $condivisi AS c
      MATCH (f:FormField {tenant_id: c.tenantId, name: c.name})
      SET f.shared = true
      RETURN count(f) AS n
    `, { condivisi })
    const m = esito.records[0]?.get('n') as { toNumber?: () => number } | number | undefined
    console.log(`[${formFieldsShared.id}] ${String(typeof m === 'number' ? m : (m?.toNumber?.() ?? 0))} fields marked shared (used by more than one form)`)
  },
}
