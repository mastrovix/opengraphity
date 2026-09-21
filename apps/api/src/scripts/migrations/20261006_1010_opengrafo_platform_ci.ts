/**
 * L'INFRASTRUTTURA DI OPENGRAFO, CENSITA IN `opengrafo` (20 set 2026, ondata 3).
 *
 * ## Perché serve
 * L'area D del programma dice «il prodotto apre incident su sé stesso». Un
 * incident si apre su un CI: senza i CI della piattaforma, un errore del
 * server diventa un evento ORFANO — `match_reason: 'none'`, `correlation:
 * 'skipped_orphan'` — e la pipeline si ferma al passo 4 senza aprire niente.
 * Era il primo dei tre prerequisiti mancanti.
 *
 * ## Come i nomi si incontrano
 * Il riconoscimento del CI (`services/events/transitions.ts#ciMatchCypher`)
 * prova, in ordine: alias per `external_id`, alias per tipo, `name_key`
 * esatto, nome corto. Il connettore dei log (`lib/serverLogEvents.ts`) manda
 * come `resource` il campo `service` della riga di log — cioè esattamente i
 * tre nomi che `lib/serviceName.ts` sa produrre. Quindi il CI si chiama come
 * il processo, e il match avviene per `name_key` senza bisogno di alias.
 *
 * Gli alias ci sono lo stesso, e sono i nomi dei CONTENITORI: sono quelli che
 * compaiono nelle etichette delle metriche di Prometheus e nei log di Docker,
 * cioè l'altra strada da cui un evento può arrivare domani.
 *
 * ## Nulla di cablato, nemmeno qui
 * Lo stato iniziale NON è il letterale `'active'`: si legge dal Dizionario di
 * questo tenant (`EnumTypeDefinition`, il suo vince su quello spedito), con la
 * stessa precedenza di `initialCIStatus`. Su un'installazione che ha
 * rinominato `active` → `attivo`, scrivere il letterale creerebbe CI fuori
 * vocabolario — è il difetto A-13, e ripeterlo in una migrazione sarebbe
 * stato ironico. Stessa regola per `environment`: se nessuno ha dichiarato un
 * default, resta vuoto invece di inventarne uno.
 *
 * Idempotente: `MERGE` su `(tenant_id, name)`.
 */
import type { Migration } from '@opengraphity/neo4j'

const TENANT = 'opengrafo'

/**
 * Il censimento. `label` è il tipo CI spedito col metamodello — non se ne
 * inventano di nuovi: `application`, `database` e `server` bastano a dire che
 * cos'è ciascun pezzo.
 *
 * Redis e Keycloak sono `Application` e non un tipo «cache» o «identità»,
 * perché quei tipi non esistono nel metamodello spedito e aggiungerli è una
 * decisione sul prodotto, non un dettaglio di questa migrazione.
 */
const PEZZI: ReadonlyArray<{
  name: string; label: 'Application' | 'Database' | 'Server'
  description: string; alias: string[]; dipendeDa: string[]
}> = [
  {
    name: 'opengrafo-api', label: 'Application',
    description: 'API GraphQL e REST. Serve le richieste del web, del portale e delle integrazioni.',
    alias: ['infra-api-1'], dipendeDa: ['opengrafo-neo4j', 'opengrafo-redis', 'opengrafo-keycloak'],
  },
  {
    name: 'opengrafo-worker', label: 'Application',
    description: 'Worker generale: code BullMQ, notifiche, sincronizzazioni, embedding.',
    alias: ['infra-worker-1'], dipendeDa: ['opengrafo-neo4j', 'opengrafo-redis'],
  },
  {
    name: 'opengrafo-events-worker', label: 'Application',
    description: 'Worker degli eventi: ingestione degli allarmi, correlazione, impatto sui servizi.',
    alias: ['infra-events-worker-1'], dipendeDa: ['opengrafo-neo4j', 'opengrafo-redis'],
  },
  {
    name: 'opengrafo-neo4j', label: 'Database',
    description: 'Neo4j: il grafo. Tutti i dati di tutti i tenant.',
    alias: ['infra-neo4j-1', 'neo4j'], dipendeDa: [],
  },
  {
    name: 'opengrafo-redis', label: 'Application',
    description: 'Redis: code BullMQ, cache, lock dei gruppi di eventi, rate limit.',
    alias: ['infra-redis-1', 'redis'], dipendeDa: [],
  },
  {
    name: 'opengrafo-keycloak', label: 'Application',
    description: 'Keycloak: un realm per tenant, più il realm della console di piattaforma.',
    alias: ['opengrafo-keycloak'], dipendeDa: [],
  },
  {
    name: 'opengrafo-nginx', label: 'Application',
    description: 'Nginx: il front door. Decide il tenant dall\'host e inoltra a web, portale e API.',
    alias: ['opengrafo-nginx'], dipendeDa: ['opengrafo-api'],
  },
  {
    name: 'opengrafo-web', label: 'Application',
    description: 'Il bundle dell\'applicazione web, servito statico.',
    alias: ['infra-web-1'], dipendeDa: ['opengrafo-api'],
  },
]

/**
 * La sorgente di monitoraggio interna.
 *
 * È un `:InboundWebhook` vero, perché la pipeline degli eventi lega ogni
 * evento alla sua sorgente (`Event.source_id`, `-[:FROM_SOURCE]->`) e da lì
 * passano tempeste, conteggi e la console delle sorgenti. Non si duplica
 * quella struttura: la si usa.
 *
 * **Dalla rete non ci si arriva.** Il `secret` è l'impronta di un segreto
 * generato e buttato via nello stesso istante: nessuno conosce il token, e
 * `rest/webhooks-inbound.ts` confronta l'impronta. Il connettore non passa da
 * HTTP — chiama `enqueueEvents` da dentro il processo — quindi non gli serve.
 * Chi volesse riaprire la porta rigenera il token dalla console, e allora è
 * una decisione visibile.
 */
const SORGENTE_ID = 'opengrafo-platform-logs'

export const opengrafoPlatformCI: Migration = {
  id: '20261006_1010_opengrafo_platform_ci',
  description: 'OpenGrafo infrastructure CIs, aliases and the internal log event source in the platform tenant',

  async up(session) {
    const now = new Date().toISOString()

    // Il tenant di piattaforma può non esistere su un'installazione qualunque:
    // in quel caso la migrazione non ha niente da fare e lo dice tornando 0.
    const esiste = await session.run('MATCH (t:Tenant {id: $tenant}) RETURN count(t) AS n', { tenant: TENANT })
    if ((esiste.records[0]?.get('n') as { toNumber?: () => number })?.toNumber?.() === 0) return

    /*
     * Lo stato e l'ambiente dal Dizionario, col vocabolario del cliente che
     * vince su quello spedito (stessa precedenza di `domainVocabulary`).
     * `default_value` se dichiarato, altrimenti il primo valore per lo stato
     * — come `initialCIStatus` — e NIENTE per l'ambiente, che un default non
     * ce l'ha e non lo si inventa.
     */
    const voc = await session.run(`
      MATCH (e:EnumTypeDefinition {name: 'ci_status'}) WHERE e.tenant_id IN [$tenant, 'system']
      WITH e ORDER BY CASE WHEN e.tenant_id = $tenant THEN 0 ELSE 1 END LIMIT 1
      WITH coalesce(e.default_value, e.values[0]) AS stato
      OPTIONAL MATCH (a:EnumTypeDefinition {name: 'environment'}) WHERE a.tenant_id IN [$tenant, 'system']
      WITH stato, a ORDER BY CASE WHEN a.tenant_id = $tenant THEN 0 ELSE 1 END LIMIT 1
      RETURN stato, a.default_value AS ambiente
    `, { tenant: TENANT })
    const stato    = voc.records[0]?.get('stato') as string | null
    const ambiente = voc.records[0]?.get('ambiente') as string | null
    if (!stato) {
      throw new Error(
        `Il Dizionario "ci_status" del tenant ${TENANT} è vuoto: non c'è uno stato con cui creare un CI. `
        + 'Aggiungi almeno un valore nel Dizionario e rilancia la migrazione.',
      )
    }

    for (const pezzo of PEZZI) {
      await session.run(`
        MATCH (t:Tenant {id: $tenant})
        MERGE (ci:ConfigurationItem {tenant_id: $tenant, name: $name})
          ON CREATE SET ci.id = randomUUID(), ci.created_at = $now, ci.status = $stato,
                        ci.environment = $ambiente
        SET ci:${pezzo.label},
            ci.name_key = toLower($name),
            ci.description = $description,
            ci.updated_at = $now
        WITH ci
        UNWIND $alias AS valore
          MERGE (a:CIAlias {tenant_id: $tenant, kind: 'hostname', value: toLower(valore)})
            ON CREATE SET a.id = randomUUID(), a.source = 'manual', a.created_at = $now
          MERGE (a)-[:ALIAS_OF]->(ci)
      `, { tenant: TENANT, name: pezzo.name, description: pezzo.description, alias: pezzo.alias, now, stato, ambiente })
    }

    // Le dipendenze in un secondo giro: tutti i CI devono esistere prima.
    for (const pezzo of PEZZI) {
      if (pezzo.dipendeDa.length === 0) continue
      await session.run(`
        MATCH (da:ConfigurationItem {tenant_id: $tenant, name: $name})
        UNWIND $verso AS nome
          MATCH (a:ConfigurationItem {tenant_id: $tenant, name: nome})
          MERGE (da)-[:DEPENDS_ON]->(a)
      `, { tenant: TENANT, name: pezzo.name, verso: pezzo.dipendeDa })
    }

    /*
     * Il segreto irraggiungibile: due valori casuali concatenati e passati
     * subito a sha256. Il preimage non esiste da nessuna parte — né qui, né
     * nei log, né nel grafo.
     */
    await session.run(`
      MATCH (t:Tenant {id: $tenant})
      MERGE (w:InboundWebhook {tenant_id: $tenant, id: $id})
        ON CREATE SET
          w.created_at = $now,
          w.secret = apoc.util.sha256([randomUUID() + randomUUID()])
      SET w.name = 'Log del server di OpenGrafo',
          w.entity_type = 'event',
          w.connector_kind = 'generic',
          w.enabled = true,
          w.field_mapping = '{}',
          w.default_values = '{}',
          w.value_mapping = '{}',
          w.rate_limit_per_minute = 0,
          w.updated_at = $now
    `, { tenant: TENANT, id: SORGENTE_ID, now })
  },
}
