/**
 * Personalizzazioni, ondata 6 (A-10 / C-3) — il ruolo nella mappa e il
 * proprietario delle relazioni, scritti sul metamodello.
 *
 * ## Perché serve, e perché serve PRIMA del codice nuovo
 * Il ruolo di un nodo nella mappa di un servizio era una tabella per etichetta
 * nel codice (`ROLE_BY_CI_LABEL`), e `roleOfLabels` lanciava su tutto il
 * resto. Non si vedeva, perché il filtro delle etichette — statico anche lui —
 * scartava i CI di un tipo del cliente ancora prima: quel tipo non entrava in
 * NESSUNA mappa, in silenzio. Aperto il filtro al metamodello del tenant, un
 * tipo senza ruolo farebbe **fallire la costruzione della mappa**: le due metà
 * vanno insieme, e questa migrazione è la prima.
 *
 * `service_role` diventa una proprietà del tipo (`component | infrastructure |
 * certificate`), impostabile dal disegnatore. Qui la si scrive sui tipi che
 * esistono già, senza inventare niente:
 *  1. dal **seme** dei tipi spediti (la stessa tabella, ora solo seme);
 *  2. altrimenti dalle **famiglie di catena**: solo `Application` →
 *     `component` (è software: soffre, non ospita), altrimenti
 *     `infrastructure`, il ruolo più conservativo.
 * Un `service_role` già presente NON viene toccato: è la scelta dell'admin.
 *
 * ## La seconda metà: di chi è una relazione
 * `addCIRelation` creava la `CIRelationDefinition` **senza `tenant_id`**.
 * `allowedRelTypes` (resolvers/ciRelationships.ts) filtra
 * `tenant_id = 'system' OR tenant_id = $tenantId`, quindi una relazione appena
 * definita nel disegnatore non era di nessuno e veniva **rifiutata** con
 * «Invalid relation type» — e dall'ondata 6 quella stessa lista dice anche
 * quali relazioni le mappe dei servizi possono percorrere. Il codice ora
 * scrive `tenant_id` e `scope`; qui si bonificano le definizioni già sul
 * grafo, prendendo il proprietario dal tipo che le possiede.
 *
 * Dal vivo (12 set 2026): 13 tipi CI (9 base + 4 ITIL, nessuno con
 * `service_role`) e 24 definizioni di relazione, tutte già
 * `tenant_id = 'system'` — la seconda parte non trova niente da fare e lo
 * dice. Idempotente: la seconda esecuzione conta 0 in entrambe le parti.
 */
import type { Migration } from '@opengraphity/neo4j'
import { ROLE_BY_CI_LABEL } from '../../lib/serviceVocabularies.js'

export const serviceRoleAndRelationScope: Migration = {
  id: '20260916_1710_service_role_and_relation_scope',
  description: 'Personalizzazioni (ondata 6, A-10/C-3): CITypeDefinition.service_role from the shipped seed or the chain families, and tenant_id/scope on the CIRelationDefinition nodes that had none',
  async up(session) {
    // ── 1. service_role sui tipi che non lo dichiarano ──────────────────────
    // I tipi ITIL (incident, change, …) non sono CI e non entrano nelle mappe;
    // `__base__` non è un tipo ma il contenitore dei campi comuni.
    const roles = await session.run(`
      MATCH (t:CITypeDefinition)
      WHERE t.service_role IS NULL
        AND t.name <> '__base__'
        AND coalesce(t.scope, 'base') <> 'itil'
      WITH t, $seed[coalesce(t.neo4j_label, '')] AS seeded
      SET t.service_role = CASE
            WHEN seeded IS NOT NULL THEN seeded
            WHEN t.chain_families = '["Application"]' THEN 'component'
            ELSE 'infrastructure'
          END
      RETURN t.name AS name, t.tenant_id AS tenantId, t.service_role AS role, seeded IS NOT NULL AS fromSeed
      ORDER BY name
    `, { seed: ROLE_BY_CI_LABEL })

    if (roles.records.length === 0) {
      console.log(`[${serviceRoleAndRelationScope.id}] nessun tipo CI senza service_role: niente da scrivere.`)
    } else {
      const lines = roles.records.map((r) =>
        `${String(r.get('name'))} (${String(r.get('tenantId'))}) → ${String(r.get('role'))}` +
        `${r.get('fromSeed') === true ? ' [seme dei tipi spediti]' : ' [dalle famiglie di catena]'}`)
      console.log(`[${serviceRoleAndRelationScope.id}] service_role scritto su ${String(lines.length)} tipi CI:\n  ` + lines.join('\n  '))
    }

    // ── 2. tenant_id / scope sulle definizioni di relazione ─────────────────
    // Il proprietario è quello del TIPO che possiede la relazione: una
    // definizione appesa a un tipo del cliente è sua, una appesa a un tipo
    // spedito è di sistema. Una definizione orfana (nessun tipo la possiede)
    // non si indovina: si conta e si dice.
    const rels = await session.run(`
      MATCH (t:CITypeDefinition)-[:HAS_RELATION]->(r:CIRelationDefinition)
      WHERE r.tenant_id IS NULL OR r.scope IS NULL
      SET r.tenant_id = coalesce(r.tenant_id, t.tenant_id),
          r.scope     = coalesce(r.scope, CASE WHEN t.scope = 'tenant' THEN 'tenant' ELSE 'base' END)
      RETURN t.name AS typeName, r.name AS relName, r.relationship_type AS relType, r.tenant_id AS tenantId
      ORDER BY typeName, relName
    `)

    const orphans = await session.run(`
      MATCH (r:CIRelationDefinition)
      WHERE r.tenant_id IS NULL AND NOT EXISTS { (:CITypeDefinition)-[:HAS_RELATION]->(r) }
      RETURN count(r) AS n
    `)
    const orphanCount = Number(orphans.records[0]?.get('n') ?? 0)

    if (rels.records.length === 0) {
      console.log(`[${serviceRoleAndRelationScope.id}] nessuna definizione di relazione senza proprietario: niente da bonificare.`)
    } else {
      const lines = rels.records.map((r) =>
        `${String(r.get('typeName'))}.${String(r.get('relName'))} (${String(r.get('relType'))}) → tenant ${String(r.get('tenantId'))}`)
      console.log(`[${serviceRoleAndRelationScope.id}] proprietario scritto su ${String(lines.length)} definizioni di relazione:\n  ` + lines.join('\n  '))
    }
    if (orphanCount > 0) {
      console.log(
        `[${serviceRoleAndRelationScope.id}] ATTENZIONE: ${String(orphanCount)} CIRelationDefinition senza tenant_id e senza un tipo ` +
        `che le possieda. Non si indovina di chi sono: restano fuori dalle relazioni ammesse e dalle mappe, ` +
        `e vanno guardate a mano (nessun tipo le mostra nel disegnatore).`,
      )
    }
  },
}
