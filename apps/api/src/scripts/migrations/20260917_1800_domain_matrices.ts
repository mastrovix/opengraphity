/**
 * Personalizzazioni, ondata 7 (B-14 / C-7 / C-8 / D-16) — le matrici di
 * dominio diventano dato del cliente, e i vocabolari che presuppongono
 * diventano vocabolari veri.
 *
 * ## Perché serve, e perché serve PRIMA del codice nuovo
 * Da quest'ondata il codice non traduce più un valore di dominio in un altro
 * con una tabella scritta dentro di sé: chiede la matrice del cliente
 * (`lib/domainMatrix.ts`). Una matrice mancante non è un ripiego silenzioso —
 * il nucleo usa il seme e lo DICE — ma i **vocabolari** sì: `domainVocabulary`
 * lancia se il nome non esiste né per il cliente né di sistema, e dal vivo
 * (12 set 2026) di quei nomi ne esistevano soltanto quattro su nove. Senza
 * questa migrazione l'apertura di un incident fallirebbe con «Vocabolario
 * "urgency" inesistente».
 *
 * ## Cosa fa
 *  1. `seedSystemEnumTypes`: MERGE dei vocabolari spediti su
 *     `tenant_id = 'system'` — fonte unica `lib/seedEnumTypes.ts`, a cui
 *     l'ondata 7 aggiunge `urgency`, `risk_band`, `event_severity`,
 *     `service_criticality`, `import_severity`. Idempotente per costruzione
 *     (è la stessa chiamata dell'onboarding).
 *  2. Aggancia il campo `criticality` della BusinessApplication al
 *     vocabolario `service_criticality`. Quel campo aveva i valori inline
 *     (`enum_values`), con una copia in `lib/serviceVocabularies.ts` e una
 *     terza in `IMPACT_BY_CRITICALITY`: tre posti da tenere allineati a mano,
 *     e il difetto C-7. Ora il campo punta al vocabolario, e il cliente lo
 *     personalizza come tutti gli altri (`customizeEnumType`, la sua copia
 *     omonima vince in lettura). I valori sono gli stessi, quindi nella UI non
 *     cambia niente.
 *  3. `seedDomainMatrices` per ogni tenant: MERGE del nodo `DomainMatrix` con
 *     il seme (`lib/domainMatrixSeed.ts`, che è il seme del nucleo più i 17
 *     sinonimi storici dell'import dei ticket). **Non tocca** una matrice già
 *     salvata: quella è la scelta dell'admin, e una migrazione che gira due
 *     volte non deve riportarla al seme.
 *
 * Idempotente: alla seconda esecuzione i vocabolari ci sono, il legame c'è e
 * `seedDomainMatrices` crea zero matrici, e lo dice.
 */
import type { Migration } from '@opengraphity/neo4j'
import { seedSystemEnumTypes } from '../../lib/seedEnumTypes.js'
import { seedDomainMatrices } from '../../lib/domainMatrixSeed.js'
import { SYSTEM_TENANT } from '../../lib/enumScope.js'

export const domainMatrices: Migration = {
  id: '20260917_1800_domain_matrices',
  description: 'Personalizzazioni (ondata 7, B-14/C-7/C-8/D-16): seed the vocabularies the domain matrices need (urgency, risk_band, event_severity, service_criticality, import_severity), point BusinessApplication.criticality at service_criticality, and seed one DomainMatrix per tenant per kind',
  async up(session) {
    // ── 1. I vocabolari spediti (fonte unica: SYSTEM_ENUMS) ─────────────────
    await seedSystemEnumTypes(session)
    const vocab = await session.run(`
      MATCH (e:EnumTypeDefinition {tenant_id: $systemTenant})
      WHERE e.name IN ['urgency', 'risk_band', 'event_severity', 'service_criticality', 'import_severity']
      RETURN e.name AS name, size(e.values) AS n ORDER BY name
    `, { systemTenant: SYSTEM_TENANT })
    console.log(
      `[${domainMatrices.id}] vocabolari dell'ondata 7 su '${SYSTEM_TENANT}': ` +
      vocab.records.map((r) => `${String(r.get('name'))} (${String(r.get('n'))} valori)`).join(', '),
    )

    // ── 2. criticality → vocabolario service_criticality ────────────────────
    // Solo se il campo non è già agganciato a un vocabolario: un legame
    // esistente è una scelta (o una personalizzazione) e non si sovrascrive.
    const link = await session.run(`
      MATCH (t:CITypeDefinition {name: 'business_application'})-[:HAS_FIELD]->(f:CIFieldDefinition {name: 'criticality'})
      WHERE NOT EXISTS { (f)-[:USES_ENUM]->() }
      MATCH (e:EnumTypeDefinition {tenant_id: $systemTenant, name: 'service_criticality'})
      MERGE (f)-[:USES_ENUM]->(e)
      RETURN t.tenant_id AS tenantId, f.id AS fieldId
    `, { systemTenant: SYSTEM_TENANT })
    if (link.records.length === 0) {
      console.log(`[${domainMatrices.id}] il campo criticality era già agganciato a un vocabolario (o non esiste): niente da fare.`)
    } else {
      console.log(
        `[${domainMatrices.id}] campo criticality agganciato a service_criticality su ${String(link.records.length)} tipo/i: ` +
        link.records.map((r) => String(r.get('tenantId'))).join(', '),
      )
    }

    // ── 3. Le matrici, un nodo per (tenant, tipo) ───────────────────────────
    const tenants = await session.run(`MATCH (t:Tenant) RETURN t.id AS id ORDER BY id`)
    const ids = tenants.records.map((r) => String(r.get('id')))
    if (ids.length === 0) {
      console.log(`[${domainMatrices.id}] nessun tenant sul grafo: nessuna matrice da seminare.`)
      return
    }
    for (const tenantId of ids) {
      const created = await seedDomainMatrices(session, tenantId)
      console.log(
        created.length === 0
          ? `[${domainMatrices.id}] ${tenantId}: tutte le matrici erano già presenti (nessuna toccata).`
          : `[${domainMatrices.id}] ${tenantId}: matrici create → ${created.join(', ')}.`,
      )
    }
  },
}
