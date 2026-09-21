/**
 * LA LINGUA PREDEFINITA DIVENTA CONFIGURAZIONE — e i clienti che ci sono già
 * non devono accorgersene.
 *
 * Fino a ieri la lingua era una costante nel codice (`LINGUA_PREDEFINITA`), e
 * valeva `it`: chi apre il prodotto oggi legge italiano. Da adesso la decide il
 * cliente, e la costante non c'è più — quindi senza questa migrazione ogni
 * tenant esistente si troverebbe «non configurato», cioè leggerebbe la prima
 * lingua dell'elenco (inglese) da un giorno all'altro, senza che nessuno abbia
 * deciso niente.
 *
 * Questa migrazione NON sceglie un default: **conserva lo stato di fatto**.
 * Scrive `it` dove non c'è niente, perché `it` è ciò che quei clienti stanno
 * leggendo in questo momento. Da qui in poi si cambia dall'interfaccia
 * (Impostazioni → Organizzazione), e i tenant NUOVI nascono senza lingua: la
 * diagnostica chiede all'admin di scegliere, invece di indovinare per lui.
 *
 * Idempotente: non toccа un tenant che ha già una lingua.
 */
import type { Migration } from '@opengraphity/neo4j'

/** Lo stato di fatto al momento del cambiamento, non una preferenza. */
const LINGUA_DI_ALLORA = 'it'

export const tenantDefaultLanguage: Migration = {
  id:          '20260920_1750_tenant_default_language',
  description: 'Tenant.default_language: conserva l\'italiano che i clienti esistenti stanno già leggendo',

  async up(session) {
    const r = await session.run(
      `MATCH (t:Tenant)
       WHERE t.default_language IS NULL OR t.default_language = ''
       SET t.default_language = $lingua, t.updated_at = $now
       RETURN t.id AS id`,
      { lingua: LINGUA_DI_ALLORA, now: new Date().toISOString() },
    )
    for (const rec of r.records) {
      console.log(`[20260920_1750] ${rec.get('id') as string}: lingua predefinita = ${LINGUA_DI_ALLORA} (quella che legge oggi)`)
    }
    console.log(`[20260920_1750] tenant allineati: ${r.records.length}`)
  },
}
