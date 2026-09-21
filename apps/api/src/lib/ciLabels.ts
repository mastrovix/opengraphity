/**
 * I tipi CI **spediti col prodotto**: il seme, non la verità (ondata 6).
 *
 * ## Com'era
 * Questo file si dichiarava «single source of truth» e il suo commento
 * ammetteva il difetto: «aggiungere un tipo di CI vuol dire toccare QUESTO
 * file». Diciassette consumatori ne derivavano un predicato
 * `(ci:Application OR ci:Server OR …)`, quindi un tipo creato dal cliente
 * esisteva nel grafo e **non contava in nessuno di quei posti** — impatto,
 * topologia, ricerca, gruppi dinamici, allegati, REST, assistente, catene —
 * quasi sempre in silenzio.
 *
 * ## Com'è
 * Le etichette dei CI si chiedono al metamodello del tenant:
 * `lib/ciLabelsForTenant.ts` (`ciLabelPredicateForTenant`,
 * `apocLabelFilterForTenant`) e, per il verso nome → etichetta,
 * `lib/ciTypeNameToLabel.ts`. Qui restano soltanto:
 *  - `TYPE_TO_LABEL`: i tipi spediti col prodotto, con i loro **alias** REST
 *    storici (`db_instance`), usato come seme dell'unione per tenant;
 *  - `ALL_CI_LABELS`: quel seme come elenco di etichette.
 *
 * Anche `IMPACT_REL_TYPES` (i sei tipi di relazione del blast radius) è
 * sparito: i tipi percorribili vengono dal metamodello del cliente
 * (`lib/ciMetamodelForTenant.ts#impactRelPatternForTenant`).
 *
 * `ciLabelPredicate(alias)` **non esiste più**: chi ne avesse bisogno sta
 * costruendo un predicato che ignora i tipi del cliente, e il compilatore
 * deve dirlo.
 *
 * ## Sette voci di questa tabella non sono tipi veri (stato al 16 set 2026)
 * `SslCertificate`, `VirtualMachine`, `NetworkDevice`, `Storage`,
 * `CloudService`, `ApiEndpoint`, `Microservice` **non hanno una
 * `CITypeDefinition`**: non sono nello schema, non hanno pagine, e dal vivo
 * nessun CI le porta (le etichette in uso sono nove, tutte con il loro tipo).
 * Erano voci aspirazionali di questa tabella.
 *
 * Conseguenza voluta dell'ondata 6 (A-11): la discovery non può più creare un
 * CI con una di quelle etichette — prima lo faceva, e il CI risultava
 * invisibile in tutto il prodotto, che è il difetto che l'ondata chiude. Ora
 * il run produce un conflitto `unknown_ci_type` che dice cosa fare.
 *
 * Resta una **decisione di prodotto**, non un difetto da correggere di
 * nascosto: o quei sette diventano tipi base veri (campi, icona, famiglie di
 * catena, pagine), o si togliano da qui perché il prodotto smetta di
 * promettere tipi che non ha. Finché la decisione non è presa, restano nel
 * seme: toglierli cambierebbe i predicati di tutti i tenant senza che nessuno
 * l'abbia chiesto.
 */

// Whitelist: type string → Neo4j label (prevents Cypher injection)
export const TYPE_TO_LABEL: Record<string, string> = {
  business_capability:  'BusinessCapability',
  business_application: 'BusinessApplication',
  application:          'Application',
  database:             'Database',
  database_instance:    'DatabaseInstance',
  db_instance:          'DatabaseInstance',
  server:               'Server',
  certificate:          'Certificate',
  ssl_certificate:      'SslCertificate',
  virtual_machine:      'VirtualMachine',
  network_device:       'NetworkDevice',
  storage:              'Storage',
  cloud_service:        'CloudService',
  api_endpoint:         'ApiEndpoint',
  microservice:         'Microservice',
  dynamic_ci_group:     'DynamicCIGroup',
}

/** Il seme: le etichette dei tipi spediti col prodotto (non l'elenco del cliente). */
export const ALL_CI_LABELS: string[] = [...new Set(Object.values(TYPE_TO_LABEL))]
