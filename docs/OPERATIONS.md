# Operazioni — OpenGraphity

Guida operativa: backup e restore, migrazioni dei dati, script, rotazione dei
segreti, checklist per gli incidenti operativi, Event Management (§7). Il
deploy è in `DEPLOY.md`; il catalogo degli script in `apps/api/src/scripts/README.md`.

Convenzione per i comandi: tutti gli script dell'API si lanciano da
`apps/api` con `pnpm exec tsx --env-file=.env src/scripts/<file>.ts …` (in
sviluppo) oppure, nel container `api`, con `node dist/scripts/<file>.js …`.
Dove esiste uno script npm è indicato (`pnpm --filter @opengraphity/api <script> -- …`).

---

## 1. Backup

### Cosa include

Un backup è un unico `backup_<stamp>.tar.gz` (stamp UTC `YYYY-MM-DD_HHMM`)
con dentro una directory `backup_<stamp>/`:

| File | Contenuto |
|---|---|
| `manifest.json` | timestamp, versione dell'app (`apps/api/package.json`), versione Neo4j, conteggio nodi/relazioni **totali e per label/tipo**, `SHOW CONSTRAINTS` e `SHOW INDEXES`, cosa è incluso (allegati, realm) e perché no |
| `nodes.jsonl` | una riga per nodo: `{id: elementId, labels, props}` |
| `rels.jsonl` | una riga per relazione: nodo di partenza/arrivo (elementId, label, proprietà), tipo e proprietà |
| `attachments.tar` | la directory `ATTACHMENT_DIR` (tar semplice, dentro il tar.gz) |
| `keycloak/<realm>.json` | `partial-export` (client, gruppi, ruoli) del realm di **ogni** `(:Tenant)` — non contiene gli utenti né le password |

Garanzie (D-08):

- **Consistenza**: nodi e relazioni sono letti in streaming da **una sola
  transazione read** (niente `SKIP/LIMIT` su sessioni separate, che sotto
  scritture concorrenti saltava o duplicava righe senza errori).
- **Pubblicazione fail-loud**: l'archivio è scritto come
  `backup_<stamp>.tar.gz.partial` e rinominato in `.tar.gz` solo se le righe
  scritte coincidono con i conteggi letti nella stessa transazione. Un
  `.partial` non è mai un backup valido.
- **Keycloak**: se non risponde o l'autenticazione admin fallisce il backup
  **fallisce**. Per saltarlo consapevolmente: `--skip-keycloak` (CLI) o
  `BACKUP_SKIP_KEYCLOAK=true` (worker); il manifest lo registra.
- Allegati: directory assente → non inclusi (registrato nel manifest, warning
  nel log), non è un errore. `--skip-attachments` per escluderli.

### Backup schedulato

Il maintenance worker dell'API (`workers/maintenance.worker.ts`, coda BullMQ
`maintenance`) esegue ogni notte alle 00:00 (`0 0 * * *`):

1. `runBackup` in `BACKUP_DIR` (env obbligatoria in produzione; deve essere un
   volume persistente del container `api`);
2. **verifica** dell'archivio (vedi sotto). Se fallisce: `logger.error` con i
   problemi, archivio rinominato in `.tar.gz.invalid`, job fallito (visibile
   nella coda), contatore `opengrafo_backup_runs_total{result="verify_failed"}`;
3. **rotazione**: conserva gli ultimi `BACKUP_RETENTION` archivi (default
   **14**), contando anche `.partial`/`.invalid`. Gira anche se il backup è
   fallito, così il disco viene comunque liberato.

Metriche (`GET /metrics`): `opengrafo_backup_runs_total{result=ok|backup_failed|verify_failed}`
e `opengrafo_backup_last_success_timestamp_seconds`. Allarme consigliato:
`time() - opengrafo_backup_last_success_timestamp_seconds > 25*3600` oppure
un incremento di `verify_failed`/`backup_failed`.

Variabili: `BACKUP_DIR`, `ATTACHMENT_DIR`, `BACKUP_RETENTION` (default 14),
`BACKUP_SKIP_KEYCLOAK` (default false), e per l'export dei realm
`KEYCLOAK_URL`, `KEYCLOAK_ADMIN_USER`, `KEYCLOAK_ADMIN_PASSWORD` (se manca e
`BACKUP_SKIP_KEYCLOAK` non è `true`, il backup notturno fallisce: è voluto).

### Backup manuale

```bash
cd apps/api
pnpm exec tsx --env-file=.env src/scripts/backup-neo4j.ts --output-dir ./backups            # completo
pnpm exec tsx --env-file=.env src/scripts/backup-neo4j.ts --output-dir ./backups --skip-keycloak
```

È read-only sul DB; può girare con l'applicazione attiva. Nel container:
`node dist/scripts/backup-neo4j.js --output-dir /backups`.

### Verifica

```bash
pnpm exec tsx --env-file=.env src/scripts/verify-backup.ts --input ./backups/backup_<stamp>.tar.gz
```

Controlla: manifest valido; `nodes.jsonl`/`rels.jsonl` parseabili riga per
riga, forma delle righe, conteggio totale e per label/tipo uguale al
manifest; `attachments.tar` leggibile con il numero di file dichiarato;
ogni `keycloak/<realm>.json` presente e del realm giusto; infine il
**restore in `--dry-run` in-process** (stesse funzioni di `restore-neo4j`:
label/tipi validati, piano dei MERGE). Stampa un riepilogo; **exit ≠ 0 su
qualsiasi incoerenza**. Le relazioni fra nodi senza `id` (che il restore non
può ricostruire) sono un AVVISO, non un errore: sono una proprietà dei dati.
Richiede `NEO4J_*` raggiungibili (il pacchetto driver si connette all'import).

### Copia off-host (consigliata)

`BACKUP_DIR` è sullo stesso host del DB: un guasto del disco perde dati e
backup insieme. Copiare ogni archivio verificato fuori dall'host, ad esempio:

```bash
# cron sull'host, dopo le 00:30
rsync -a --include='backup_*.tar.gz' --exclude='*' /srv/opengraphity/backups/ backup@offsite:/srv/og-backups/
# oppure su object storage (MinIO/S3)
mc mirror --exclude '*.partial' --exclude '*.invalid' /srv/opengraphity/backups/ minio/og-backups/
```

Copiare solo `.tar.gz` (mai `.partial`/`.invalid`). Conservare off-host più a
lungo della rotazione locale (es. 90 giorni) e provare un restore su un
ambiente di staging almeno una volta al mese.

---

## 2. Restore

```bash
cd apps/api
pnpm exec tsx --env-file=.env src/scripts/verify-backup.ts  --input ./backups/backup_<stamp>.tar.gz   # 1. verifica
pnpm exec tsx --env-file=.env src/scripts/restore-neo4j.ts  --input ./backups/backup_<stamp>.tar.gz --dry-run   # 2. piano
pnpm exec tsx --env-file=.env src/scripts/restore-neo4j.ts  --input ./backups/backup_<stamp>.tar.gz --yes-restore # 3. restore
```

Procedura consigliata per un ripristino completo:

1. Fermare l'API (`docker compose stop api`) così nessun worker scrive durante il restore.
2. Verificare l'archivio (`verify-backup`).
3. Per un ripristino **da zero** svuotare il DB esplicitamente (il restore è
   additivo e non cancella nulla): `MATCH (n) DETACH DELETE n` in batch, o
   ricreare il volume Neo4j.
4. `pnpm neo4j:init` (constraint e indici: il restore non li ricrea).
5. `restore-neo4j --dry-run`, poi `--yes-restore`. Il comando termina con
   **exit ≠ 0 se il restore è parziale** (relazioni saltate perché un nodo di
   testa manca o non ha `id`): leggere il riepilogo prima di riaprire il servizio.
6. `migrate.ts --status`: le migrazioni applicate sono nel backup
   (nodi `:Migration`), quindi lo stato torna coerente con il codice.
7. Allegati: `tar -xf attachments.tar -C $ATTACHMENT_DIR` (estrarre prima
   `attachments.tar` dall'archivio: `tar -xzf backup_<stamp>.tar.gz backup_<stamp>/attachments.tar`).
8. Keycloak: importare `keycloak/<realm>.json` da console admin
   (Realm settings → Action → Partial import) o via Admin API
   (`POST /admin/realms/{realm}/partialImport`). Gli **utenti non sono nel
   backup**: Keycloak va salvato a parte (dump del suo database Postgres).
9. Riavviare l'API; il worker embedding ricrea l'indice vettoriale e ricalcola
   gli embedding mancanti (`backfill-embeddings` se serve).

Cosa il restore **NON** ripristina: allegati e realm (passi 7–8), constraint e
indici (passo 4), utenti Keycloak, la cache Redis (si rigenera), le code
BullMQ (job in volo persi: i job ripetibili vengono ri-registrati all'avvio).
Semantica sui nodi: MERGE per `(prima label, id)`; senza `id` MERGE per chiave
naturale (`Counter`) o creazione solo se non esiste un nodo identico. Le
proprietà temporali native di Neo4j vengono ripristinate come stringhe ISO
(l'applicazione usa stringhe ISO ovunque).

---

## 3. Migrazioni dei dati

Le migrazioni versionate vivono in `apps/api/src/scripts/migrations/` e sono
eseguite dal runner di `packages/neo4j` (`migrations.ts`).

```bash
cd apps/api
pnpm exec tsx --env-file=.env src/scripts/migrate.ts --status     # stato
pnpm exec tsx --env-file=.env src/scripts/migrate.ts --dry-run    # cosa verrebbe applicato
pnpm exec tsx --env-file=.env src/scripts/migrate.ts              # applica le pendenti
pnpm exec tsx --env-file=.env src/scripts/migrate.ts --to 20260908_1000_workflow_step_metadata
pnpm exec tsx --env-file=.env src/scripts/migrate.ts --init-schema   # neo4j:init + migrazioni, in un colpo
```

Come funziona:

- ordine = ordine degli id `YYYYMMDD_HHMM_nome`; ogni migrazione viene
  applicata **una volta** e registrata in `(:Migration {id, applied_at, checksum, description})`
  (constraint UNIQUE su `id`, creato da `neo4j:init`);
- **lock**: `(:MigrationLock {id:'global', owner, locked_at})` con scadenza di
  10 minuti. Un secondo processo che trova il lock **fallisce subito**
  (`MigrationLockError`), non aspetta. Un lock scaduto (processo morto) viene
  preso in carico;
- ogni migrazione gira nella sua transazione **insieme al marker**: se
  fallisce non resta traccia, il runner si ferma lì con l'id della migrazione
  fallita (exit ≠ 0) e le successive non vengono toccate;
- `autocommit: true` (obbligatorio per `CALL { … } IN TRANSACTIONS`, che Neo4j
  rifiuta dentro una transazione esplicita): `up` gira sulla sessione e il
  marker è scritto dopo. Deve essere idempotente: un crash fra i due la lascia
  non marcata e verrà rieseguita;
- `checksum` = sha256 del sorgente normalizzato di `up`. `--status` segnala
  il *drift* (codice cambiato dopo l'applicazione): informativo, non rieseguito.

**Aggiungere una migrazione**

1. Creare `migrations/YYYYMMDD_HHMM_nome.ts` che esporta un `Migration`
   (`{ id, description, up(session), autocommit? }`); `session.run(cypher, params)`
   è tutto ciò che serve. Usare `MERGE`/filtri `WHERE … IS NULL` così da
   essere idempotente anche quando non obbligatorio.
2. Registrarla in `migrations/index.ts` (`MIGRATIONS`).
3. `migrate.ts --dry-run` in sviluppo, poi `migrate.ts`. Il test
   `scripts/__tests__/migrationsRegistry.test.ts` controlla id validi e
   univoci e che chi usa `IN TRANSACTIONS` dichiari `autocommit`.
4. In deploy: `migrate.ts` (o `--init-schema`) **prima** di avviare la nuova
   versione dell'API. L'avvio dell'API non migra da solo.

**Rollback** = nuova migrazione che inverte la precedente (mai modificare
una migrazione applicata: verrebbe ignorata e segnalata come drift).

Migrazioni presenti:

| id | Cosa fa |
|---|---|
| `20260908_1000_workflow_step_metadata` | `is_initial/is_terminal/is_open/category/step_order` sugli `WorkflowStep` (ex `migrate-workflow-metadata`) |
| `20260908_1010_ci_configuration_item_label` | aggiunge `:ConfigurationItem` ai nodi con una label registrata in `CITypeDefinition.neo4j_label` (B-08; batch da 5000, autocommit) |
| `20260909_1000` … `20260909_1040` | Event Management: vedi §7 (policy per tenant, regole di notifica, `Event.correlation`, chiavi dell'ondata 4) |

Wrapper per singola migrazione: `migrate:workflow-metadata -- [--force]`,
`migrate-ci-labels.ts [--force]` (`--force` riapplica una migrazione già
marcata; entrambe sono idempotenti). `migrate-enum-references.ts` **non** è
una migrazione versionata (è per tenant, richiede `--tenant`): resta manuale.

---

## 4. Script operativi

Catalogo, regole comuni (tenant sempre esplicito, `--yes-delete` per le
cancellazioni, seed demo rifiutati in produzione, exit 1 su errore) e
invocazioni: `apps/api/src/scripts/README.md`.

**Utenti demo e notifiche**: `User.notifications_enabled` è un flag di
*opt-out*: il dispatcher delle notifiche e il digest email trattano il flag
**assente come `true`** (`coalesce(u.notifications_enabled, true)`). Gli utenti
demo dei seed (`seed:users`, `seed:users-bulk`, email fittizie `USR-nnn@…`)
non hanno il flag, quindi in un ambiente con `RESEND_API_KEY`/`SLACK_BOT_TOKEN`
reali riceverebbero email e digest. Prima di collegare un provider reale a un
ambiente con dati demo:

```cypher
MATCH (u:User {tenant_id: $tenant}) WHERE u.email ENDS WITH '@example.com' OR u.id STARTS WITH 'USR-'
SET u.notifications_enabled = false
```

e verificare chi resta abilitato:
`MATCH (u:User) WHERE coalesce(u.notifications_enabled, true) RETURN u.tenant_id, u.email`.

**Onboarding di un tenant** (`onboard-tenant`, idempotente):

```bash
KEYCLOAK_ADMIN_PASSWORD=… pnpm --filter @opengraphity/api onboard-tenant -- \
  --slug acme --admin-email admin@acme.com --admin-first-name A --admin-last-name B --password-stdin
```

Crea realm Keycloak (= slug = `Tenant.id`), client, ruoli, utente admin, nodo
`Tenant`, dashboard, enum, regole di notifica e tutti i workflow. Poi:
`seed:metamodel` (una volta per stack), `seed:field-rules`, `seed:automation`
se servono, e aggiungere `https://<host-del-tenant>` a `KEYCLOAK_PUBLIC_URL`/`CORS_ORIGIN`
se il tenant ha un hostname proprio. Dal secondo giorno il tenant è nel backup
notturno (realm compreso).

---

## 5. Rotazione dei segreti

| Segreto | Chi lo usa | Cosa succede ruotandolo |
|---|---|---|
| `JWT_SECRET` | solo i token HS256 di sviluppo (`ALLOW_LEGACY_JWT=true`, `gen-token`) | I token legacy emessi con il vecchio segreto diventano 401. In produzione `ALLOW_LEGACY_JWT` è off: la rotazione non ha effetti. Basta riavviare l'API. |
| `REDIS_PASSWORD` | API e worker (BullMQ, cache, SSE) | Cambiarla su Redis **e** in tutti i container nello stesso deploy; fino al riavvio i worker loggano `worker error` e continuano a ritentare (nessun job perso: sono in Redis). Ordine: aggiornare `.env` → `docker compose up -d redis api worker`. |
| `KEYCLOAK_ADMIN_PASSWORD` | `onboard-tenant`, `add-user`, `createUser` GraphQL, export realm nel backup | Cambiarla in Keycloak (utente admin del realm `master`) e nell'env dell'API. Fino ad allora: creazione utenti 500 e **backup notturno fallito** (Keycloak auth fallita) — voluto. Le sessioni degli utenti finali non sono toccate. |
| `DISCOVERY_ENCRYPTION_KEY` (64 hex = 32 byte) | credenziali dei connettori discovery cifrate at rest (`packages/discovery/src/encryption.ts`) | **Non ruotabile a caldo**: le credenziali salvate con la vecchia chiave non sono più decifrabili (sync in errore `Decryption failed: invalid key or corrupted data`). Procedura: annotare le credenziali di ogni `SyncSource` (dalle console dei provider, non sono esportabili in chiaro), cambiare chiave, reinserirle dall'UI. Non perderla: il backup contiene solo il cifrato. |
| `NEO4J_PASSWORD` | tutto | `ALTER CURRENT USER SET PASSWORD` in Neo4j, poi env di API/worker e riavvio. Con la password vecchia l'API non parte (fail-fast del driver). |
| `KEYCLOAK_CLIENT_SECRET` (portal) | portale self-service | Rigenerare in Keycloak → client `opengrafo-portal` e aggiornare l'env del portale. |
| `METRICS_TOKEN` | `GET /metrics` da Prometheus | Aggiornare lo scrape config; senza token l'endpoint resta accessibile solo da reti private. |

Regola generale: i segreti si cambiano in un solo deploy (env + servizio),
mai "prima uno e poi l'altro" a distanza di ore.

---

## 6. Checklist incidenti operativi

**Sintomo: `GET /health` → 503** (`rest/health.ts`: `RETURN 1` su Neo4j e
`PING` su Redis, 2 s di timeout ciascuno). Il corpo
`{"status":"degraded","services":{"neo4j":"ok|error","redis":"ok|error"}}`
dice quale dipendenza è giù.

**Redis giù**
- API: le query GraphQL funzionano (la cache è solo un acceleratore); le
  mutazioni che pubblicano eventi di dominio (`publish` → `queue.add`)
  falliscono o restano in attesa fino al timeout della connessione; `/health` 503.
- Worker BullMQ (SLA, notifiche, webhook, discovery, backup): loggano
  `[bullmq] worker error … worker keeps running` e riprendono da soli quando
  Redis torna; i job già accodati sono in Redis (persistiti se AOF/RDB attivi).
  Un backup schedulato mancato **non** viene recuperato: lanciarlo a mano.
- Da fare: `docker compose up -d redis`, poi controllare `/metrics`
  (`bullmq_queue_depth`) e i log per code bloccate.

**Neo4j giù**
- API e worker si fermano (fail-fast del driver all'avvio; a runtime ogni
  query fallisce con `QueryError` `retryable`), `/health` 503, il container
  viene riavviato dall'orchestratore e riparte quando Neo4j risponde.
- Da fare: `docker compose logs neo4j`; se il `neo4j.conf` è corrotto seguire
  la nota in memoria del progetto (force-recreate del container, **mai** `rm`
  dei volumi). Dopo il ripristino, `neo4j:init` è idempotente e sicuro.

**Keycloak giù**
- Tutte le richieste autenticate → 401 (JWKS non scaricabile / token non
  verificabili); gli utenti già loggati falliscono al refresh del token.
- API key REST (`X-API-Key`) continuano a funzionare (non passano da Keycloak).
- Backup notturno: fallisce sull'export dei realm (voluto, vedi §1).
- Da fare: `docker compose up -d keycloak`; verificare
  `KEYCLOAK_URL` interno e `KEYCLOAK_PUBLIC_URL` (issuer) se il 401 persiste.

**Backup notturno fallito** (log `Backup verification FAILED` o job fallito)
- Guardare i `problems` nel log; l'archivio è rinominato `.invalid`
  (verifica fallita) o lasciato `.partial` (conteggi non tornano, tipico se
  un import massivo girava a mezzanotte).
- Rilanciare a mano `backup-neo4j` + `verify-backup`; se il problema è
  Keycloak, risolverlo o `--skip-keycloak` per non restare senza backup del grafo.

**Disco pieno in `BACKUP_DIR`**
- Ridurre `BACKUP_RETENTION` o spostare gli archivi off-host; la rotazione
  gira a ogni backup, anche fallito. Cancellare a mano solo `.partial`/`.invalid`
  e gli archivi già copiati off-host.

**Migrazione bloccata (`MigrationLockError`)**
- Un altro processo sta migrando, oppure è morto meno di 10 minuti fa.
  Aspettare la scadenza o, se si è certi che non gira nulla:
  `MATCH (l:MigrationLock {id:'global'}) SET l.locked_at = null, l.owner = null`.

---

## 7. Event Management

Gli allarmi dei sistemi di monitoraggio (Alertmanager, Grafana, Zabbix,
Datadog, Dynatrace, o un JSON qualunque con il connettore `generic`) entrano
dal webhook in ingresso (`POST /api/webhooks/inbound/:hookId`, vedi
`API.md`), diventano nodi `Event` deduplicati per impronta, aggiornano la
**salute** dei CI (`ci.health`: operational/degraded/down — separata dal ciclo
di vita `ci.status`) e vengono correlati in incident. Codice:
`apps/api/src/services/eventService.ts` (normalizzazione, deduplica, salute),
`eventCorrelation.ts` (pipeline), `eventStorm.ts` (tempeste),
`eventRetention.ts` (conservazione), resolver `graphql/resolvers/events.ts`.

### Code BullMQ

| Coda | Job | Cosa fa |
|---|---|---|
| `events-ingest` (concurrency 4) | `ingest` | uno per allarme normalizzato; job id `ev-<tenant>-<impronta>-<ms>` (una ri-consegna dello stesso batch non raddoppia i conteggi); 3 tentativi con backoff. Esegue `ingestEvent`: MERGE per impronta, aggancio al CI (alias → nome), pipeline di correlazione, eventi di dominio |
| `events-correlate` (concurrency 2) | `correlate` | ritardato: con `open_delay_seconds > 0` l'apertura dell'incident aspetta la scadenza; se nel frattempo l'allarme è rientrato non apre nulla |
| | `reevaluate-windows` | ripetuto ogni 5 minuti, tre passate indipendenti: (1) eventi `suppressed` la cui finestra di change è chiusa → tornano firing e vengono correlati; (2) eventi `flapping` senza passaggi da `flap_stable_minutes` → stabilizzati; (3) sorgenti in tempesta raffreddate che non ricevono più nulla → tempesta chiusa. Una passata fallita non ferma le altre; il job fallisce alla fine con tutti i motivi |
| `maintenance` | `purge_events` | ogni giorno alle 03:30: conservazione (vedi sotto) |

Il webhook risponde **202** appena i job sono accodati: se Redis è giù risponde
500 e lo strumento ritenta (nessun allarme accettato e perso).

### Migrazioni

| id | Cosa fa |
|---|---|
| `20260909_1000_event_management_bootstrap` | ondata 1: constraint/indici su `Event`/`CIAlias`, prima scrittura di `event_policy` (difettosa sui tenant senza nodo `:Tenant`, corretta dalla 1010) |
| `20260909_1010_event_management_fixup` | rimuove `status_source` dai CI (la salute vive in `ci.health`), crea i nodi `:Tenant` mancanti dai `tenant_id` degli utenti, scrive la policy predefinita dove manca |
| `20260909_1020_event_management_notification_rules` | regole di notifica `event.received/resolved/orphan`, `ci.health_changed` su ogni tenant; `max_users/max_ci` interi |
| `20260909_1030_event_management_correlation_rules` | regole `event.suppressed/correlated`; `Event.correlation = 'none'` dove assente |
| `20260909_1040_event_management_policy_v2` | ondata 4: aggiunge alla policy di ogni tenant le chiavi mancanti (`flap_stable_minutes`, `storm_threshold_per_minute`, `storm_cooldown_minutes`) senza toccare i valori esistenti; `Event.transitions = []` dove assente; regole `event.flapping/stable/storm_started/storm_ended`. Una policy con JSON corrotto **ferma** la migrazione con il tenant nel messaggio |

Senza la 1040 ogni ingest fallisce con
`Tenant <id> event_policy is invalid: … missing flap_stable_minutes, … run the 20260909_1040_event_management_policy_v2 migration`
(voluto: mai un valore inventato). Come per tutte le migrazioni: `migrate.ts`
**prima** di avviare la nuova versione dell'API.

### Regole di notifica

Seminate per tenant (`lib/seedNotificationRules.ts`, MERGE per
`tenant_id + event_type`: l'amministratore può disabilitarle o cambiare
canali senza che una migrazione le riscriva):

| Evento di dominio | Quando | Predefinito |
|---|---|---|
| `event.received` | allarme nuovo o ripetuto (non durante soppressione, sfarfallio o tempesta) | in_app, warning |
| `event.resolved` | allarme rientrato | in_app, success |
| `event.orphan` | allarme senza CI riconosciuto | in_app, warning |
| `ci.health_changed` | la salute derivata di un CI cambia | in_app, warning |
| `event.suppressed` | allarme silenziato da una change in finestra (una volta per finestra) | in_app, info |
| `event.correlated` | incident aperto / agganciato / riaperto / risolto automaticamente | in_app, warning |
| `event.flapping` | l'allarme entra in sfarfallio (una volta per episodio) | in_app, warning |
| `event.stable` | l'allarme si è stabilizzato | in_app, info |
| `event.storm_started` | una sorgente entra in tempesta (una volta per tempesta) | in_app + slack, error |
| `event.storm_ended` | la tempesta è finita | in_app, success |

Durante una tempesta **non** vengono pubblicati `event.received`/`event.orphan`
per i singoli allarmi (sarebbero centinaia al minuto): l'avviso è
`event.storm_started`. Anche gli outbound webhook seguono gli stessi tipi.

### Policy per tenant

`Tenant.event_policy` (JSON), visibile e modificabile da *Amministrazione →
Event Management → Policy* (`eventPolicy` / `updateEventPolicy`, solo admin).
La policy è sempre completa: un campo mancante o fuori dai valori ammessi è un
errore, mai un default silenzioso.

| Chiave | Iniziale | Significato |
|---|---|---|
| `open_incident_from` | `critical` | severità minima (`info`/`warning`/`critical`) da cui un allarme apre un incident; `never` = mai automaticamente |
| `group_by` | `ci` | raggruppamento: `ci` (un incident per CI) o `fingerprint` (uno per allarme) |
| `open_delay_seconds` | `0` | attesa prima di aprire (job `correlate`); un allarme che rientra nell'attesa non apre nulla |
| `auto_resolve` | `true` | risolve l'incident quando TUTTI gli allarmi correlati sono rientrati |
| `suppress_upstream_hops` | `1` | salti `DEPENDS_ON` a monte entro cui una change in finestra silenzia gli allarmi |
| `flap_threshold` | `4` | passaggi firing↔resolved in `flap_window_minutes` oltre i quali l'allarme è `flapping` (`0` = spento) |
| `flap_window_minutes` | `10` | finestra dello sfarfallio |
| `flap_stable_minutes` | `15` | minuti senza passaggi dopo i quali un allarme `flapping` torna allo stato dell'ultimo payload |
| `storm_threshold_per_minute` | `50` | allarmi **nuovi** al minuto dalla stessa sorgente oltre i quali la sorgente è in tempesta (`0` = spento) |
| `storm_cooldown_minutes` | `5` | minuti consecutivi sotto soglia dopo i quali la tempesta finisce |
| `retention_days` | `90` | giorni dopo `resolved_at` oltre i quali gli eventi risolti vengono eliminati (`0` = mai) |
| `severity_map` | critical→high/high, warning→medium/medium, info→low/low | severità dell'allarme → impatto/urgenza dell'incident aperto |

### Sfarfallio (flapping)

Un allarme che va e viene (firing → resolved → firing …) non deve aprire e
chiudere un incident a ogni oscillazione. Ogni passaggio viene registrato in
`Event.transitions` (ultimi 50 istanti) insieme a `last_payload_status`.

- **Come si riconosce**: status `flapping` nella console eventi (filtro
  `status = flapping`, contatore *Sfarfallio* in `eventStats.flapping`), campo
  `flappingSince`, `transitions24h` (passaggi nelle ultime 24 h),
  `correlation = flapping`; notifica `event.flapping`; sull'incident già
  correlato un commento *"Allarme instabile: N passaggi in M minuti,
  correlazione sospesa"*. Il CI vale **degraded** finché sfarfalla (instabilità,
  non guasto pieno): con un altro allarme `critical` firing resta `down`.
- **Cosa succede**: nessun incident viene aperto, agganciato, riaperto o
  risolto da quell'allarme; i payload successivi aggiornano `last_seen_at`,
  `last_payload_status` e la lista senza cambiare stato. Dopo
  `flap_stable_minutes` senza passaggi il job periodico lo riporta allo stato
  dell'ultimo payload (`event.stable`) e lo ripassa dalla pipeline: se è
  firing viene correlato, se è resolved si valuta la chiusura automatica.
- **Cosa fare**: è il sintomo di una soglia di monitoraggio troppo vicina al
  valore normale o di un servizio che oscilla. Guardare `transitions24h` nel
  dettaglio evento; sistemare la soglia nello strumento di monitoraggio (o
  isteresi/`for:` in Prometheus). Per un tenant con molti allarmi legittimamente
  oscillanti alzare `flap_threshold` o ridurre `flap_window_minutes`;
  `flap_threshold = 0` spegne il rilevamento.

### Tempeste di allarmi

Un guasto di rete o un problema nello strumento di monitoraggio può generare
centinaia di allarmi al minuto: aprire un incident per ogni CI seppellirebbe
gli operatori.

- **Come si riconosce**: `eventStats.stormSources` (console eventi, riquadro
  *Tempeste in corso*: sorgente, allarmi al minuto, da quando, incident);
  `InboundWebhook.storm_since`/`storm_incident_id`; metrica
  `event_storms_active` (pannello Grafana, rosso ≥ 1); notifica
  `event.storm_started` (in_app + Slack); un incident **critical** dal titolo
  *"Tempesta di allarmi da <sorgente>: N allarmi al minuto"* con i primi CI
  coinvolti nella descrizione; gli eventi hanno `correlation = storm`.
- **Cosa succede**: il contatore al minuto per (tenant, sorgente) vive su
  Redis (`og:events:storm:<tenant>:<sorgente>:<minuto>`, TTL 120 s) e conta
  solo gli allarmi **nuovi** (le ripetizioni no). Alla soglia la sorgente entra
  in tempesta; gli allarmi vengono ingeriti e deduplicati normalmente e la
  salute dei CI si aggiorna, ma la correlazione **non** apre né aggancia
  incident per CI: tutti si agganciano all'unico incident di tempesta della
  sorgente. L'incident richiede un CI: lo apre il primo allarme con un CI
  riconosciuto (fino ad allora `correlation = storm_no_ci`). La soppressione
  per finestra di change vince sulla tempesta. La tempesta finisce quando per
  `storm_cooldown_minutes` consecutivi nessun minuto ha raggiunto la soglia
  (verificato a ogni ingest e dal job periodico): `event.storm_ended`,
  commento *"Tempesta terminata: N eventi in T minuti"* sull'incident; gli
  allarmi ancora attivi **restano** agganciati all'incident di tempesta (non
  vengono redistribuiti). Un allarme rientrato durante la tempesta aggiorna
  solo la salute; finita la tempesta la chiusura automatica torna a valere.
- **Cosa fare**: aprire l'incident di tempesta e verificare la causa comune
  (rete, DNS, lo strumento stesso, una regola di alerting errata). Se la
  sorgente continua a inviare spazzatura disabilitare il webhook
  (*Amministrazione → Integrazioni*: risponde 404, lo strumento ritenta o
  scarta) finché non è sistemata. Alla fine risolvere l'incident di tempesta a
  mano se non si risolve da solo (lo fa quando l'ultimo allarme agganciato
  rientra, se `auto_resolve` è attivo). Se le tempeste sono false (sorgente
  legittimamente prolifica) alzare `storm_threshold_per_minute` per quel
  tenant; `0` spegne il rilevamento. Redis giù durante una tempesta → l'ingest
  fallisce e ritenta (nessun fallback), `/health` 503.

### Conservazione

Il job `purge_events` (coda `maintenance`, ogni giorno alle 03:30) elimina, per
ogni tenant, gli `Event` in stato **`resolved`** con `resolved_at` più vecchio
di `retention_days` della policy del tenant, con le loro relazioni
(`RAISED_ON`, `FROM_SOURCE`, `CORRELATED_INTO`, `SUPPRESSED_BY`), in batch da
1000 (`CALL { … } IN TRANSACTIONS`). Gli eventi `firing`, `suppressed` e
`flapping` non vengono **mai** eliminati, qualunque sia la loro età.
`retention_days = 0` = nessuna eliminazione. Log per tenant
(`Resolved events purged` con `retentionDays`, `cutoff`, `purged`), metrica
`events_purged_total`. Un tenant senza policy fa fallire il job **dopo** aver
purgato gli altri. Per lanciarla a mano: `purgeResolvedEvents()` in
`apps/api/src/services/eventRetention.ts` (non c'è ancora una voce CLI; in un
REPL `tsx` con `--env-file=.env`). Gli incident aperti dalla correlazione non
sono toccati: perdono solo il riferimento all'allarme (`correlatedEvents`).

### Metriche e pannelli

`GET /metrics` (`middleware/metrics.ts`, riga *Event Management* del
cruscotto Grafana `infra/grafana/dashboards/opengraphity-api.json`):

| Metrica | Tipo | Incrementata da |
|---|---|---|
| `events_received_total{connector}` | counter | ogni ingest (nuovo o ripetuto), etichetta = connettore della sorgente |
| `events_deduplicated_total` | counter | ingest che ha trovato l'impronta (ripetizione) |
| `events_orphan_total` | counter | ingest senza CI riconosciuto |
| `events_suppressed_total` | counter | prima soppressione per finestra di change (non le ripetizioni) |
| `events_flapping_total` | counter | ingresso in sfarfallio |
| `incidents_auto_opened_total` | counter | incident aperti dalla correlazione e incident di tempesta (non `createIncidentFromEvent`) |
| `incidents_auto_resolved_total` | counter | chiusure automatiche |
| `incidents_reopened_total` | counter | riaperture per allarme tornato |
| `events_purged_total` | counter | eventi eliminati dalla conservazione |
| `event_storms_active` | gauge | sorgenti in tempesta (riallineato a ogni inizio/fine e dal job periodico) |

Pannelli: *Eventi/s per esito* (ricevuti, deduplicati, soppressi, sfarfallio),
*Incident automatici al minuto* (aperti/risolti/riaperti), *Tempeste di allarmi
attive*. Allarmi consigliati: `event_storms_active >= 1` per più di 10 minuti;
`rate(events_orphan_total[15m]) / rate(events_received_total[15m]) > 0.2`
(alias/nomi dei CI non allineati con il monitoraggio);
`bullmq_queue_depth{queue="events-ingest",status="failed"} > 0`.

### Provare una sorgente

1. *Amministrazione → Integrazioni → Webhook in ingresso*: crearne uno con
   *Tipo entità = Evento* e il connettore dello strumento; copiare URL e token
   (il token si vede solo alla creazione).
2. Dal dettaglio della sorgente, **Invia evento di prova** (`sendSampleEvent`):
   il payload di esempio del connettore passa dalla pipeline reale e compare
   nella console eventi entro pochi secondi (job `events-ingest`); la sorgente
   mostra `last_received_at` e `receive_count`. L'evento di prova ha risorsa
   `db-01.example.local` (o simile): sarà **orfano** a meno che non esista un
   CI o un alias con quel nome — è atteso, serve a verificare la catena
   webhook → coda → console.
3. Per il connettore `generic`: *Anteprima* (`previewInboundEvents`) incollando
   un payload reale mostra cosa diventerebbe senza ingerirlo; il mappatore
   propone le chiavi del payload (`payloadKeys`).
4. Dallo strumento: `curl -X POST <url> -H "Authorization: Bearer <token>" -H
   "Content-Type: application/json" -d @payload.json` → `202 {"accepted": N}`.

### Risoluzione dei problemi

**Evento orfano** (`event.orphan`, contatore *Orfani*): nessun CI con quel
nome né alias `hostname/ip/fqdn/external_id` con quel valore (confronto in
minuscolo, porta tolta da `host:porta`). Dal dettaglio evento **Collega a un
CI** con *crea alias*: da quel momento la sorgente viene riconosciuta da sola e
l'evento viene rivalutato (salute, correlazione). Molti orfani dalla stessa
sorgente → allineare il campo risorsa del connettore (es. `labels.host` invece
di `instance`) o creare gli alias in blocco (`createCIAlias`).

**Sorgente con errori** (`last_error`, `error_count` sul webhook, log
`webhook-inbound`): il payload è stato rifiutato con 400 e il motivo indica il
campo (`alerts[0].labels.severity must be one of: …`, `event_value must be
"1" (problem) or "0" (recovery)`, `resourceKind is missing: set
default_values.resourceKind`). Sistemare `value_mapping`/`default_values` o la
regola nello strumento; il primo batch accettato azzera `last_error`. 401 =
token sbagliato (solo header `Authorization: Bearer`), 404 = webhook
disabilitato o id errato, 429 = più di 100 richieste/min per webhook (batch
più grandi, fino a 500 allarmi), 500 = Redis giù (lo strumento ritenta).

**Policy mancante o di versione precedente** (ingest che falliscono con
`Tenant <id> has no event_policy` o `… missing flap_stable_minutes …`): eseguire
`migrate.ts` (1010 crea la policy, 1040 la completa). Un tenant creato con
`onboard-tenant` la riceve già completa. Policy corrotta (`is corrupt JSON`):
`MATCH (t:Tenant {id: $id}) RETURN t.event_policy` e correggerla, oppure
`SET t.event_policy = null` e rieseguire `migrate.ts --force --to 20260909_1040_event_management_policy_v2`.

**Incident non aperto** anche se l'allarme è `critical`: controllare
`Event.correlation` — `skipped_severity` (soglia `open_incident_from`),
`skipped_orphan` (nessun CI), `delayed` (attesa `open_delay_seconds`),
`suppressed` (change in finestra: `suppressedBy`), `flapping`, `storm`
(agganciato all'incident di tempesta). `reevaluateEvent` rilancia la pipeline
per un evento soppresso, in attesa o orfano appena collegato.

**Evento resta `suppressed` a finestra chiusa**: il job `reevaluate-windows`
gira ogni 5 minuti; se la change è uscita dal passo `deployment`/`scheduled`
da più tempo, guardare i job falliti della coda `events-correlate`
(`bullmq_queue_depth{status="failed"}`) e il log `Suppressed event
re-evaluation failed`; `reevaluateEvent` dal dettaglio lo sblocca subito.

**Salute del CI che non cambia**: `health_source = manual` (forzatura
manuale: togliere l'override dal dettaglio CI) o `ci.status = maintenance`
(ciclo di vita: il monitoraggio non tocca un CI in manutenzione).
