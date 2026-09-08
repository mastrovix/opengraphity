# Script operativi (`apps/api/src/scripts`)

Tutti gli script si lanciano dall'host con
`pnpm --filter @opengraphity/api <script-npm> -- <argomenti>` (le variabili
`NEO4J_URI`, `NEO4J_USER`, `NEO4J_PASSWORD` devono puntare allo stack).
Quelli senza script npm: `pnpm --filter @opengraphity/api exec tsx src/scripts/<file>.ts <argomenti>`.

Regole comuni (`lib/scriptArgs.ts`, `lib/runScript.ts`):

- **Tenant sempre esplicito**: `--tenant=<slug>` (= `Tenant.id`), nessun default.
- **Cancellazioni solo con conferma**: gli script marcati *distruttivo* richiedono `--yes-delete`.
- **Seed demo rifiutati in produzione** (`NODE_ENV=production`).
- **Password mai in argv**: `--password-stdin` oppure password temporanea generata e stampata una volta.
- Exit code 1 su qualsiasi errore; il driver Neo4j viene chiuso dal runner (niente `process.exit(0)` nei `finally`).

## Amministrazione tenant / utenti

| Script | Scopo | Invocazione | Distruttivo |
|---|---|---|---|
| `onboard-tenant` | Crea realm Keycloak, client, ruoli, admin, nodo `Tenant`, dashboard, enum, notifiche e tutti i workflow. Idempotente. | `onboard-tenant -- --slug acme --admin-email a@acme.com --admin-first-name A --admin-last-name B [--password-stdin] [--plan starter] [--timezone Europe/Rome]` — env: `KEYCLOAK_ADMIN_PASSWORD` obbligatoria | no |
| `add-user` | Aggiunge/aggiorna un utente in un realm esistente (+ nodo `User`). Password reimpostata su utente esistente solo con `--password-stdin`. | `add-user -- --slug acme --email m@acme.com [--role user] [--password-stdin]` — env: `KEYCLOAK_ADMIN_PASSWORD` | no |
| `gen-token` | JWT HS256 di sviluppo (24h), accettato solo fuori produzione. | `JWT_SECRET=… gen-token -- --tenant=<slug> --user-id=<id> --email=<email> --role=admin` | no |

## Import / migrazioni

| Script | Scopo | Invocazione | Distruttivo |
|---|---|---|---|
| `import:incidents` | Import incident da CSV (idempotente su `external_id`). | `import:incidents -- --file f.csv --tenant-id <slug> [--dry-run]` | no |
| `import:kb` | Import articoli KB da CSV. | `import:kb -- --file f.csv --tenant-id <slug> [--dry-run]` | no |
| `backup:neo4j` | Dump JSONL + tar.gz dell'intero DB. | `backup:neo4j -- [--output-dir ./backups]` | no |
| `restore:neo4j` | Restore additivo da archivio (non cancella nulla). | `restore:neo4j -- --input backup.tar.gz [--dry-run]` | no |
| `migrate:workflow-metadata` | Popola `isInitial/isTerminal/isOpen/category` sugli `WorkflowStep` privi. | `migrate:workflow-metadata` | no |
| `migrate-enum-references.ts` | Collega `CIFieldDefinition` con enum inline alle `EnumTypeDefinition` (`USES_ENUM`). | `exec tsx … --tenant=<slug> [--include-shared]` | no |
| `backfill-embeddings.ts` | Calcola gli embedding mancanti/obsoleti di incident e KB. Fail-fast. | `node dist/scripts/backfill-embeddings.js` (nel container api) | no |
| `export-schema.ts` | Esporta l'SDL GraphQL statico in `docs/`. | `exec tsx src/scripts/export-schema.ts` | no |
| `revert-problem` | One-off: riporta un problem a `under_investigation` via engine. | `revert-problem -- --tenant=<slug> PRB00000001` | no |
| `scan:anomalies` | Esegue una volta lo scanner anomalie (senza coda). Una regola rotta fa fallire lo scan. | `scan:anomalies -- --tenant=<slug>` | no |

## Seed di configurazione (idempotenti, MERGE per chiave naturale)

| Script | Scopo | Invocazione | Distruttivo |
|---|---|---|---|
| `seed:metamodel` | Metamodello CI base (scope `base`, tenant `system`). Rimuove solo edge `HAS_FIELD` obsoleti dei campi base. | `seed:metamodel` | no |
| `seed-itil-metamodel.ts` | Definizioni ITIL (scope `itil`). | `exec tsx … [--slug system]` | no |
| `seed-enum-types.ts` | Enum di sistema del tenant. | `exec tsx … --tenant <slug>` | no |
| `seed-notification-rules.ts` | Regole di notifica di default. | `exec tsx … --slug <slug>` | no |
| `seed-dashboards.ts` | 3 dashboard di ruolo. | `exec tsx … --tenant-id <slug>` | no |
| `seed-itil-ci-rules.ts` | Regole di relazione ITIL↔CI. | `exec tsx … --tenant-id <slug>` | no |
| `seed:field-rules` | Regole visibilità/obbligatorietà campi. | `seed:field-rules -- --tenant=<slug>` | no |
| `seed:assessment-questions` | Domande di assessment change. | `seed:assessment-questions` | no |
| `seed:automation` | SLA policy, trigger e business rule di esempio. | `seed:automation -- --tenant=<slug>` | no |
| `seed:incident-workflow` / `seed:problem-workflow` / `seed:kb-workflow` / `seed:change-workflow` / `seed:sr-workflow` | Definizioni workflow (step esistenti conservati). | `<script> -- --tenant=<slug>` | no |
| `seed:ci-chain` | Popola il campo `chain` sui CI in base alle chain family. | `seed:ci-chain -- --slug <slug>` | no |

## Seed di dati demo (casuali; rifiutati con `NODE_ENV=production`)

Ordine consigliato: teams → users → servers → databases → dbinstances → apps → certificates → relations.

| Script | Scopo | Invocazione | Distruttivo |
|---|---|---|---|
| `seed:teams` | 70 team `TEA-nnn`. | `seed:teams -- --tenant=<slug>` | no |
| `seed:users` | 10 utenti demo con `MEMBER_OF` (richiede i team). `created_at` solo alla creazione. | `seed:users -- --tenant=<slug>` | no |
| `seed:users-bulk` | 700 utenti `USR-nnn` con 1–3 team. | `seed:users-bulk -- --tenant=<slug>` | no |
| `seed:servers` / `seed:servers-with-teams` | Server `SRV-nnn` (con owner/support team). | `… -- --tenant=<slug>` | no |
| `seed:databases` / `seed:databases-with-teams` | Database `DB-nnn`. | `… -- --tenant=<slug>` | no |
| `seed:dbinstances` / `seed:dbinstances-with-teams` | Istanze DB `DBINST-nnn`. | `… -- --tenant=<slug>` | no |
| `seed:apps` / `seed:apps-with-teams` | Applicazioni `APP-nnn`. | `… -- --tenant=<slug>` | no |
| `seed:certificates` | Certificati collegati ad app/server. | `seed:certificates -- --tenant=<slug>` | no |
| `seed:business-applications` | BusinessApplication (`REALIZES`, `OWNED_BY`). | `seed:business-applications -- --tenant=<slug>` | no |
| `seed:business-capabilities` | BusinessCapability a due livelli (`PARENT_OF`, `ENABLED_BY`). | `seed:business-capabilities -- --tenant=<slug>` | no |
| `seed:dynamic-ci-groups` | Gruppi CI dinamici/manuali di esempio. | `seed:dynamic-ci-groups -- --tenant=<slug>` | no |
| `seed:ci-relations` | Catena DB→istanza→server, app→server/db/app (solo MERGE). | `seed:ci-relations -- --tenant=<slug>` | no |
| `seed:app-relations` | Dipendenze app→app (solo MERGE). | `seed:app-relations -- --tenant=<slug>` | no |
| `seed:relations` | Ricrea le relazioni `DEPENDS_ON`/`HOSTED_ON` di `APP-*`, `DB-*`, `DBINST-*` **cancellando prima quelle esistenti**. | `seed:relations -- --tenant=<slug> --yes-delete` | **sì** |
| `seed:demo-incidents` | Cancella tutti gli incident del tenant e ne ricrea 1500 seguendo il workflow. | `seed:demo-incidents -- --tenant=<slug> --yes-delete` | **sì** |
| `seed:anomaly-scenarios` | Cancella `Anomaly`/`AnomalyConfig` del tenant e crea scenari anomali sul grafo. | `seed:anomaly-scenarios -- --tenant=<slug> --yes-delete` | **sì** |

## Librerie condivise (`lib/`)

| Modulo | Contenuto |
|---|---|
| `scriptArgs.ts` | `resolveTenantArg`, `requireConfirmFlag`, `refuseInProduction`, `readOptionValue`, `hasFlag` |
| `runScript.ts` | Runner: esegue `main`, chiude il driver, exit code 1 su errore |
| `keycloakAdmin.ts` | Client Keycloak Admin REST (`getAdminToken/get/exists/post/put/setPassword`, `findUserIdByEmail`, `assignRealmRole`) |
| `password.ts` | `--password-stdin`, generazione password temporanea, stampa una tantum |
| `importSummary.ts` | Riepilogo a console degli import CSV |
| `workflowDefinitions.ts` | Definizioni dei workflow Change RFC e Service Request |
