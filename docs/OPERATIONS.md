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
| `20260910_1080_service_maps_bootstrap` | Servizi monitorati: vedi §7 (*Servizi monitorati*) — completa `rules`, `node_ids` e i campi dell'ondata 1 sulle `ServiceMap` esistenti; no-op senza mappe |
| `20260910_1090_service_notification_rules` | Servizi monitorati: regole di notifica `service.health_changed` e `service.incident_opened` su ogni tenant |
| `20260910_1100_service_map_plan_limit` | Servizi monitorati: `Tenant.max_service_maps` dal piano (starter 5, pro 50, enterprise 200) dove manca |
| `20260910_1110_service_map_auto_sync` | Servizi monitorati: `ServiceMap.auto_sync = true` (mappa viva, il default dell'ondata 5) dove manca, `synced_at` lasciato a null |
| `20260910_1120_service_map_review2` | Servizi monitorati (revisione 2): recupera `ServiceMap.stale_reason` sulle mappe già `stale` (`missing_ci` se un id di `node_ids` non ha più la sua `INCLUDES`, altrimenti `over_limit`) |

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
`apps/api/src/services/events/` per responsabilità — `normalize.ts`
(payload dei connettori), `transitions.ts` (stato dell'evento e MERGE
dell'ingest), `ingest.ts` (orchestratore), `pipeline.ts` (solo l'ordine dei
passi), `suppression.ts`, `flapping.ts`, `grouping.ts`, `autoResolve.ts`,
`storm.ts` (tempeste), `passes.ts` (fine finestra e passate periodiche),
`gauges.ts`, `ciHealth.ts`, `policy.ts`, `sourceCache.ts` — con le facciate
storiche `services/eventService.ts`, `eventCorrelation.ts`, `eventStorm.ts`
che ri-esportano tutto; `eventRetention.ts` (conservazione), resolver
`graphql/resolvers/events.ts`. Per evento l'ingest fa **uno** statement
Neo4j (MERGE con transizione di stato, collegamento alla sorgente,
riconoscimento e aggancio del CI) più la pipeline, che legge la policy e la
sorgente dalle cache in memoria (vedi *Cache in memoria*).

### Code BullMQ

| Coda | Job | Cosa fa |
|---|---|---|
| `events-ingest` (concurrency 4) | `ingest` | uno per allarme normalizzato; job id `ev-<tenant>-<impronta>-<ms>` (una ri-consegna dello stesso batch non raddoppia i conteggi); 3 tentativi con backoff. Esegue `ingestEvent`: MERGE per impronta, aggancio al CI (alias → nome), pipeline di correlazione, eventi di dominio |
| `events-correlate` (concurrency 2) | `correlate` | ritardato: con `open_delay_seconds > 0` l'apertura dell'incident aspetta la scadenza; se nel frattempo l'allarme è rientrato non apre nulla. Misura il proprio ritardo dalla scadenza (`event_correlate_job_lag_seconds`) |
| | `reevaluate-change-window` | accodato dalle mutation della change quando esce dai passi di finestra con allarmi silenziati (e da `deleteChange`): rivaluta quegli eventi fuori dalla mutation |
| `events-maintenance` (concurrency 1, lock 10 min) | `events-maintenance` | ripetuto ogni 5 minuti, cinque passate paginate e indipendenti: (1) `closed_windows` — eventi `suppressed` la cui finestra di change è chiusa → tornano firing e vengono correlati; (2) `pending` — eventi firing che nessuno sta più curando → ripresi: scadenza passata, **oppure** correlazione `pending`/`none` ferma da più di 15 minuti anche SENZA scadenza (revisione 2 · B2-01: è così che nasce e riparte ogni evento, e prima nessuna passata li vedeva), **oppure** ritardo di apertura scaduto da più di 5 minuti (B2-02); il predicato è lo stesso del gauge `events_firing_uncorrelated` (`services/events/stuck.ts`), così metrica e riparazione non possono divergere; (3) `flapping` — eventi senza passaggi da `flap_stable_minutes` → stabilizzati; (4) `storms` — sorgenti in tempesta raffreddate che non ricevono più nulla → tempesta chiusa; (5) `gauges` — riallinea `events_overdue_delayed` e `events_firing_uncorrelated`. Una passata fallita non ferma le altre; il job fallisce alla fine con tutti i motivi; ogni passata è contata e misurata (`event_pass_total{pass,result}`, `event_pass_duration_seconds{pass}`) |
| `maintenance` | `purge_events` | ogni giorno alle 03:30: conservazione (vedi sotto) |

Il webhook risponde **202** appena i job sono accodati: se Redis è giù risponde
500 e lo strumento ritenta (nessun allarme accettato e perso).

### Accettazione parziale, traduzione dei valori, risorsa predefinita

(revisione, ondata 4 — A1/A3/M2–M5/M9/M10/B5/B6; codice in
`services/events/normalize.ts`, contratto in `API.md` → *Inbound webhooks*)

- **Per elemento, non per batch**: un allarme difettoso in un batch
  Alertmanager/Grafana viene scartato da solo; gli altri vengono accodati. Il
  202 porta `rejected: [{ index, error }]`, la sorgente mostra `last_error` =
  *"N di M scartati: <primo motivo>"* con `error_count += N`, la metrica
  `events_rejected_total{connector}` cresce. Solo se nessun elemento passa
  → 400. Un difetto della busta (non è un oggetto, manca `alerts`, oltre 500)
  resta un 400.
- **`value_mapping` per ogni connettore** (*Sorgenti → Modifica → Regole*, o
  nel passo "Nome e regole" della procedura guidata): traduce severità e stato
  che lo strumento manda con parole sue (`page`, `P1`, `Average`, `Muted`) PRIMA
  della tabella incorporata; un valore non tradotto e fuori vocabolario è uno
  scarto con il motivo che cita `value_mapping.severity|status`.
- **Risorsa predefinita** (`default_values.resource` + `resourceKind`, stessa
  pagina): l'oggetto a cui attribuire un allarme senza host (Watchdog, alert su
  metriche aggregate, monitor Datadog su log/APM). Senza, l'allarme è scartato
  con *"… is missing or empty and default_values.resource is not set"*. Per
  Datadog la spunta *usa alert_scope* (`default_values.resourceFrom =
  alert_scope`) vale prima della risorsa predefinita. Le chiavi ammesse per i
  preset sono solo `severity`, `resource`, `resourceKind`, `resourceFrom`: una
  configurazione con altre chiavi è rifiutata in scrittura.
- **Datadog**: l'identità dell'allarme è `$ALERT_CYCLE_KEY` (un ciclo
  trigger→resolve), non `$ALERT_ID` (l'id del monitor, uguale per tutti gli
  host di un monitor multi-alert): senza cycle key vale `alert_id@risorsa`. Il
  payload personalizzato proposto dalla procedura guidata include
  `alert_cycle_key` e `alert_scope`: le sorgenti create prima vanno aggiornate
  nello strumento, altrimenti gli host dello stesso monitor restano separati per
  risorsa ma senza la chiave di ciclo.
- **Zabbix**: `{EVENT.DATE} {EVENT.TIME}` è ora locale del server Zabbix: viene
  convertita in ISO con `Tenant.timezone` (letto nel lookup del webhook). Tenant
  senza fuso o testo non parsabile → `starts_at` vuoto e il grezzo in
  `labels.event_time` (log `Tenant has no timezone`): mai un istante inventato.
  `{HOST.ID}` è l'id della risorsa (`resource_external_id`).
- **Dynatrace**: `ImpactedEntities[0].type` HOST → hostname, altro → nome;
  `entity` (HOST-…, SERVICE-…) è `resource_external_id`. `ImpactedEntity` senza
  lista perde il prefisso di tipo solo se riconosciuto (*Host*, *Service*,
  *Application*, *Process group*, …); *"3 impacted entities"* è uno scarto.
- **Severità** (`Event.severity`) = ultimo payload (la salute del CI segue la
  sorgente, anche in discesa); `Event.max_severity` conserva la più alta del
  ciclo (`maxSeverity` in GraphQL; null sugli eventi scritti prima).
- **Residui**: al `resolved` si azzerano `suppressed_by_change_id`,
  `correlation_due_at`, `flapping_since`; al nuovo ciclo (resolved → firing)
  `correlation` torna `none` con `correlation_at`/`correlation_due_at` a null e
  la pipeline riscrive l'esito (un allarme tornato notifica di nuovo la sua
  correlazione).
- **`resolved` di un allarme mai visto** (tipico appena collegata una sorgente):
  l'Event nasce già risolto con `first_seen_at` = `starts_at` della sorgente,
  senza `event.resolved`/`event.orphan`; conta in
  `events_resolved_unknown_total{connector}`.

### Riconoscimento del CI

(revisione, ondata 4 — A2/M2; `services/events/transitions.ts#ciMatchCypher`,
dentro lo stesso statement del MERGE dell'ingest, tutto su indici)

Ordine di precedenza, il primo che trova qualcosa vince; l'esito è scritto su
`Event.match_reason` (`Event.matchReason` in GraphQL, enum `EventMatchReason`)
a ogni ingest in cui il riconoscimento gira (evento senza CI, payload non
stantio):

| `match_reason` | Regola |
|---|---|
| `alias_external_id` | alias `external_id` del CI = **id della risorsa** presso la sorgente (`Event.resource_external_id`: `entity` di Dynatrace, `host_id` di Zabbix, `resourceExternalId` del generic). Mai l'id dell'allarme (`external_id`, fingerprint/event_id) |
| `alias` | alias del tipo della risorsa (`hostname`/`ip`/`fqdn`, confronto in minuscolo; `external_id` come `resourceKind` confronta l'alias `external_id` con la risorsa stessa). Un alias è univoco per costruzione (vincolo `tenant + kind + value`) |
| `name` | `ConfigurationItem.name_key` (nome minuscolo, indice `ci_tenant_name_key`) = risorsa minuscola, porta tolta |
| `name_short` | solo con la policy `match_short_hostname = true` e solo se il nome esatto non ha trovato nulla: risorsa con un punto → `name_key` = prima etichetta (`db-01.example.local` → `db-01`); risorsa senza punto → `name_key` che inizia con `risorsa.` (`db-01` → `db-01.example.local`). Non si applica a `ip`/`external_id` né a un indirizzo IPv4/IPv6 con `resourceKind = hostname` |
| `ambiguous` | il confronto per nome (esatto o corto) trova **più di un CI**: l'evento **non** viene agganciato (prima veniva scelto in silenzio il più vecchio) e resta orfano; `event.orphan` porta `match_reason` e `candidates` (id e nome, al massimo 5); log `warn` "more than one CI matches the resource name" con i candidati; metrica `events_ambiguous_total` (oltre a `events_orphan_total`), contata a ogni payload finché l'ambiguità persiste |
| `none` | nessun CI: orfano |
| `manual` | **non** è un esito del riconoscimento: lo scrive `linkEventToCI` quando un operatore collega l'evento a un CI dalla console. L'ingest non lo produce mai; resta finché il CI è agganciato (il riconoscimento non gira su un evento con CI) |

`match_reason` è null sugli eventi scritti prima del campo e resta invariato
quando il CI è già agganciato: descrive l'ultimo riconoscimento automatico,
oppure `manual` se il CI lo ha scelto un operatore. Un evento
orfano viene riconosciuto di nuovo a ogni ripetizione: creato il CI (o
l'alias), la ripetizione successiva lo aggancia da sola. La policy arriva
dalla cache in memoria (30 s): una modifica a `match_short_hostname` fatta
direttamente nel grafo si vede dopo il TTL, quella da `updateEventPolicy`
subito.

### Protezioni del webhook in ingresso

- **Limite per sorgente** (`rate_limit_per_minute` sull'`InboundWebhook`,
  1..10000, modificabile in *Monitoraggio → Sorgenti → Modifica* e nel passo
  "Nome e regole" della procedura guidata; **100** per i webhook creati prima
  del campo, l'unico default): contatore a finestra fissa di un minuto su
  Redis, chiave `og:webhook:rate:<tenant>:<hookId>:<minuto>` (INCR+EXPIRE
  atomici, TTL 120 s), quindi **condiviso fra le repliche** dell'API. Oltre il
  limite: 429 con header `Retry-After` (secondi alla fine del minuto) che
  Alertmanager/Grafana rispettano, metrica `webhook_rate_limited_total{connector}`.
  Se cresce durante una tempesta: alzare il limite della sorgente o raggruppare
  di più nello strumento (`group_by`/`group_interval`), non è un guasto. Redis
  irraggiungibile → 500 (lo strumento ritenta), mai "limite disattivato".
- **Transform script**: al massimo **4 isolate V8 per replica** insieme
  (`TRANSFORM_SCRIPT_MAX_CONCURRENCY` in `rest/webhooks-inbound.ts`); le
  richieste in più aspettano in coda fino a 10 s, poi 503 con `Retry-After: 5`
  e codice `SERVICE_UNAVAILABLE`. Nessun allarme è scartato in silenzio: lo
  strumento ritenta. Un 503 ricorrente significa script troppo lenti (5 s di
  timeout ciascuno) o troppe sorgenti con script sulla stessa replica.
- **Corpo**: JSON fino a 2 MB (batch Alertmanager da 500 allarmi); JSON
  malformato → 400, oltre il limite → 413, sempre in JSON
  `{ error: { code, message } }`.
- **Cancellazione di un CI**: è fisica e porta via anche i suoi alias
  (`CIAlias`); gli `Event` che lo riguardavano restano, senza CI (`orfani`),
  e possono essere riagganciati a mano (`linkEventToCI`) o rivalutati.

### Migrazioni

| id | Cosa fa |
|---|---|
| `20260909_1000_event_management_bootstrap` | ondata 1: constraint/indici su `Event`/`CIAlias`, prima scrittura di `event_policy` (difettosa sui tenant senza nodo `:Tenant`, corretta dalla 1010) |
| `20260909_1010_event_management_fixup` | rimuove `status_source` dai CI (la salute vive in `ci.health`), crea i nodi `:Tenant` mancanti dai `tenant_id` degli utenti, scrive la policy predefinita dove manca |
| `20260909_1020_event_management_notification_rules` | regole di notifica `event.received/resolved/orphan`, `ci.health_changed` su ogni tenant; `max_users/max_ci` interi |
| `20260909_1030_event_management_correlation_rules` | regole `event.suppressed/correlated`; `Event.correlation = 'none'` dove assente |
| `20260909_1040_event_management_policy_v2` | ondata 4: aggiunge alla policy di ogni tenant le chiavi mancanti (`flap_stable_minutes`, `storm_threshold_per_minute`, `storm_cooldown_minutes`) senza toccare i valori esistenti; `Event.transitions = []` dove assente; regole `event.flapping/stable/storm_started/storm_ended`. Una policy con JSON corrotto **ferma** la migrazione con il tenant nel messaggio |
| `20260910_1070_event_management_tenants` | revisione A-M8/A-2: crea i nodi `:Tenant` mancanti unendo i `tenant_id` di `User`, `InboundWebhook`, `ApiKey` e `ConfigurationItem` (la 1010 guardava solo gli utenti: un tenant "solo integrazione" restava senza policy e ogni ingest falliva), con i campi predefiniti della 1010; aggiunge `match_short_hostname` (false) e ogni altra chiave mancante alla policy di ogni tenant, crea la policy intera (versionata) dove manca. Stesse regole della 1040 sul JSON corrotto |
| `20260910_1080_service_maps_bootstrap` | Servizi monitorati (ondata 1): sulle `ServiceMap` esistenti completa `rules` con le chiavi mancanti (o la crea intera dai default), ricostruisce `node_ids` dalle `INCLUDES` e scrive i campi obbligatori dell'ondata 1 dove mancano (`stale`, `version`, `built_from`, `status`, `health`, `impact_score`, `explanation`, `relationship_types`, `max_depth`); JSON corrotto ferma la migrazione con la mappa nel messaggio. Senza mappe non fa nulla. Vincoli e indici (`ServiceMap`, `ServiceHealthEntry`) sono in `init.ts` (`migrate --init-schema`) |

| `20260910_1090_service_notification_rules` | Servizi monitorati (ondata 3): semina su ogni `:Tenant` le regole di notifica `service.health_changed` (warning, in_app) e `service.incident_opened` (error, in_app + slack) con lo stesso seed dell'onboarding — MERGE per (tenant_id, event_type), le regole già presenti non si toccano |
| `20260910_1100_service_map_plan_limit` | Servizi monitorati (ondata 4): scrive `Tenant.max_service_maps` (starter 5, pro 50, enterprise 200 — `lib/tenantPlans.ts`) **solo** sui tenant che non ce l'hanno, dal loro `plan`; un limite già presente (anche cambiato a mano) non viene toccato. Un `plan` fuori vocabolario ferma la migrazione con il tenant nel messaggio. Senza questa migrazione `createServiceMap` fallisce con «run the 20260910_1100_service_map_plan_limit migration»: il limite non viene inventato a runtime |
| `20260910_1110_service_map_auto_sync` | Servizi monitorati (ondata 5): scrive `ServiceMap.auto_sync = true` — la mappa viva è il nuovo default — **solo** sulle mappe che non ce l'hanno, lasciando `synced_at` a null (nessuno l'ha ancora sincronizzata: ci pensa la prima scrittura CMDB o la passata di sicurezza). Un interruttore già spento a mano non viene riacceso. Senza questa migrazione la lettura di una mappa fallisce con «has no auto_sync — run the 20260910_1110_service_map_auto_sync migration»: la modalità non viene inventata a runtime |
| `20260910_1120_service_map_review2` | Servizi monitorati (revisione 2, ondata 1): sulle mappe già marcate `stale` **senza** motivo scrive `stale_reason` guardando il grafo — `missing_ci` se almeno un id di `node_ids` non ha più la sua `INCLUDES` (componente cancellato dalla CMDB), altrimenti `over_limit` (sincronizzazione rifiutata dal tetto dei 500). Non tocca `stale`, `health` né `version`. `health_if_active` **non** viene ricalcolata (servirebbe rifare il motore): la scrive la prima valutazione, entro 10 minuti; la migrazione si limita a contare le mappe `maintenance` che la aspettano. Idempotente |

Senza la 1070 un tenant senza nodo `:Tenant` non può nemmeno creare un webhook
di Event Management: `createInboundWebhook` con `entityType = event` verifica
la policy del tenant **alla configurazione** e risponde
`Cannot create an event webhook: tenant <id> has no usable event policy (…). Run the 20260910_1070_event_management_tenants migration`
invece di lasciare che il webhook risponda 202 e il worker fallisca ogni job.

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
| `event.received` | allarme **nuovo** o **nuovo ciclo** (resolved → firing); mai una ripetizione (Alertmanager `repeat_interval`, Zabbix); non durante soppressione, sfarfallio o tempesta | in_app, warning — **disattivata** nei tenant creati dopo la revisione (attivabile da *Notifiche → Regole*); nei tenant esistenti resta com'era |
| `event.resolved` | allarme rientrato: solo il payload che chiude il ciclo, non le ripetizioni di `resolved` | in_app, success |
| `event.orphan` | allarme senza CI riconosciuto, con la stessa regola di `event.received`/`resolved` (una volta per ciclo) | in_app, warning |
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

Dieta di rumore (revisione, 3.3): una ripetizione di un allarme già agganciato
allo stesso incident non produce `event.correlated`, audit né commento in
timeline; la chiusura automatica lascia **un** commento (con il cammino
percorso, es. *passando per Assegnato, In lavorazione*) e i passi intermedi
restano nella storia del workflow. Il seed di `event.received` è `enabled:
false` solo ON CREATE (MERGE per `tenant_id + event_type`): la migrazione
1020 sui tenant esistenti non tocca nulla, i tenant nuovi (onboarding) nascono
con la regola spenta. Per gli eventi di dominio innescati da una change
eliminata a mano (`deleteChange` → rivalutazione degli allarmi silenziati)
l'`actor_id` è l'utente che ha eliminato la change, mentre incident, commenti
e audit restano di `monitoring` (è la correlazione automatica ad agire).

### Cache in memoria

Per processo, senza Redis (come le altre cache dell'API): con più repliche
ogni replica ha la sua, e vale il TTL.

| Cosa | TTL | Invalidata da | Cosa può essere stantio |
|---|---|---|---|
| `Tenant.event_policy` (`lib/eventPolicy.ts`) | 30 s | `updateEventPolicy` (stesso processo) | un ingest su un'altra replica usa la policy precedente per al più 30 s |
| `InboundWebhook` (`services/events/sourceCache.ts`) | 10 s | ogni scrittura sulla sorgente fatta dai servizi (inizio/fine tempesta, marcatore del minuto, incident di tempesta, `last_error` dal worker) e dalle mutation `updateInboundWebhook`/`deleteInboundWebhook`/`regenerateWebhookToken` | solo lo stato di tempesta letto **fuori** dal lock: le decisioni (avvio, apertura/sostituzione dell'incident) rileggono sempre dal grafo sotto lock, e la fine per raffreddamento è una SET condizionale (`storm_since = $since`): al più un ritardo di 10 s, mai una doppia chiusura o un secondo `event.storm_ended` |

`last_error`, `secret`, `enabled` **non** passano dalla cache: il webhook in
ingresso legge la sorgente dal grafo a ogni richiesta, l'ingest la legge nel
MERGE.

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
| `auto_resolve` | `true` | risolve l'incident quando nessun allarme correlato è più **acceso** (`firing` o `flapping`): i `suppressed` (silenziati da una change in finestra) non lo tengono aperto — se ne restano, l'incident riceve un commento "N allarmi silenziati da CHG-…" insieme a quello di chiusura, una volta per risoluzione; a fine finestra vengono rivalutati e, se ancora accesi, lo riaprono. Vengono valutati **tutti** gli incident non chiusi collegati all'allarme (tempesta + per CI, manuale + automatico), non solo il più recente |
| `suppress_upstream_hops` | `1` | salti `DEPENDS_ON` a monte entro cui una change in finestra silenzia gli allarmi |
| `flap_threshold` | `4` | passaggi firing↔resolved in `flap_window_minutes` oltre i quali l'allarme è `flapping` (`0` = spento) |
| `flap_window_minutes` | `10` | finestra dello sfarfallio |
| `flap_stable_minutes` | `15` | minuti senza passaggi dopo i quali un allarme `flapping` torna allo stato dell'ultimo payload |
| `storm_threshold_per_minute` | `50` | allarmi **nuovi** al minuto dalla stessa sorgente oltre i quali la sorgente è in tempesta (`0` = spento) |
| `storm_cooldown_minutes` | `5` | minuti consecutivi sotto soglia dopo i quali la tempesta finisce |
| `retention_days` | `90` | giorni dopo `resolved_at` oltre i quali gli eventi risolti vengono eliminati (`0` = mai) |
| `match_short_hostname` | `false` | riconoscimento del CI per nome: se la risorsa dell'allarme è un FQDN (`db-01.example.local`) prova anche il nome corto (`db-01`), e viceversa. Spento per default perché nomi corti uguali in ambienti diversi renderebbero il match ambiguo (regola di policy; il confronto vive nel riconoscimento del CI dell'ingest) |
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
  gli allarmi che **aprono un ciclo** — nuovi, oppure rientrati e tornati
  accesi (revisione 2 · B2-03: contare i soli Event nuovi rendeva impossibile
  la tempesta al SECONDO guasto identico, quando gli Event esistono già) — non
  le ripetizioni né il retry dello stesso payload. Alla soglia la sorgente entra
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
(`RAISED_ON`, `FROM_SOURCE`, `CORRELATED_INTO`, `SUPPRESSED_BY`; ma vedi sotto
per gli incident/change non chiusi), in batch da
1000 (`CALL { … } IN TRANSACTIONS`, sessione auto-commit: `runQuery` usa
`session.run`, pinnato dal test `eventRetentionAutocommit.test.ts`); il
numero riportato è il `count(*)` della **stessa** query che cancella. Gli
eventi `firing`, `suppressed` e `flapping` non vengono **mai** eliminati,
qualunque sia la loro età. `retention_days = 0` = nessuna eliminazione. Log per tenant
(`Resolved events purged` con `retentionDays`, `cutoff`, `purged`), metrica
`events_purged_total`. Un tenant senza policy fa fallire il job **dopo** aver
purgato gli altri. Per lanciarla a mano: `purgeResolvedEvents()` in
`apps/api/src/services/eventRetention.ts` (non c'è ancora una voce CLI; in un
REPL `tsx` con `--env-file=.env`).

La conservazione **rispetta la storia** (revisione 2.2): un evento correlato
(`CORRELATED_INTO`) a un incident **non chiuso** — passo non terminale, oppure
`resolved`, che il monitoraggio riapre se l'allarme torna — o silenziato
(`SUPPRESSED_BY`) da una change **non chiusa** non viene mai eliminato,
qualunque sia la sua età. Quando incident/change sono chiusi e l'evento è oltre
la retention, l'evento viene eliminato ma il padre conserva il conteggio
(`Incident.correlated_events_purged`, `Change.suppressed_events_purged`, +1 per
evento, scritto nello **stesso** batch della cancellazione), esposto in GraphQL
come `Incident.correlatedEventsPurged` / `Change.suppressedEventsPurged` per
mostrare "N allarmi eliminati per conservazione" al posto di una sezione vuota.
I passi "chiusi" vengono letti dalla definizione del workflow del tenant a ogni
passata (per l'incident: i terminali diversi da `resolved`); un workflow senza
passo terminale fa fallire il purge di quel tenant.

**Fusi orari delle finestre** (revisione 1.17): ogni data di
`releaseWindow`/`validationWindow` del piano di rilascio deve avere l'offset
esplicito (`Z` o `±hh:mm`): `lib/deployWindows.ts` rifiuta con
`… must carry an explicit UTC offset` un piano scritto come `2026-09-09T22:00`,
che altrimenti verrebbe letto nel fuso del server API e non in quello del
tenant. Il web salva sempre in UTC con `Z`.

Le **voci di cronologia** dell'evento (`HAS_HISTORY` → `EventHistoryEntry`,
vedi sotto) vengono cancellate nello stesso batch dell'evento: il `DETACH
DELETE` dell'evento da solo le lascerebbe orfane.

### Cronologia dell'allarme

Ogni `Event` porta una cronologia (`(:Event)-[:HAS_HISTORY]->(:EventHistoryEntry)`,
`apps/api/src/services/events/history.ts`; in GraphQL `Event.history(limit)`
e `Event.historyCount`, tipo `EventHistoryEntry`, enum `EventHistoryKind`
generato da `lib/eventVocabularies.ts`): **una voce per ogni cambiamento di
stato o esito**, mai per le ripetizioni di un payload con lo stesso stato
(`count`/`last_seen_at` bastano) e mai per i cambi di salute del CI (sono del
CI). Nodo in snake_case: `id`, `tenant_id`, `event_id`, `at`, `kind`,
`outcome` (solo `correlated`), `actor_id` (`monitoring` o l'id dell'utente),
`incident_id`, `change_id`, `ci_id`, `note`, `severity`. Vincolo di unicità
su `id` e indice `event_history_tenant_event` su `(tenant_id, event_id, at)`
in `packages/neo4j/src/init.ts` (`migrate --init-schema`): nessuna migrazione
versionata, la cronologia parte dal deploy.

| `kind` | Quando | Campi |
|---|---|---|
| `first_seen` | creazione dell'Event (anche già `resolved`, B5: `at` = `first_seen_at`) | `severity` |
| `cycle_firing` / `cycle_resolved` | il payload cambia stato rispetto all'ultimo applicato (stessa regola di `Event.transitions`) | `severity` |
| `severity_changed` | stesso ciclo, payload `firing` con severità diversa | `severity`, `note` = severità precedente |
| `correlated` | l'esito di correlazione **cambia** (`setCorrelation`), o la relazione con l'incident è nuova; una ripetizione già agganciata non scrive nulla | `outcome`, `incident_id` se c'è |
| `suppressed` / `unsuppressed` | inizio/fine del silenzio in finestra di change | `change_id` |
| `flapping` / `stable` | inizio/fine dello sfarfallio | `note` = "N passaggi in M min" / "nessun passaggio in M min" |
| `storm` | aggancio **nuovo** all'incident di tempesta | `incident_id` |
| `auto_resolved` / `auto_resolve_skipped` | chiusura automatica dell'incident (o motivo per cui non è possibile) | `incident_id`, `note` = cammino percorso / motivo |
| `acknowledged`, `resolved_manually`, `linked_ci`, `incident_opened_manually`, `reevaluated` | mutation dell'operatore | `actor_id` = utente; `note` (risoluzione), `ci_id` (+ `note` = `alias`), `incident_id` |

**Scrittura nello stesso statement dello stato, mai fire-and-forget.**
`historyWriteCypher` è un frammento accodato al MERGE dell'ingest
(`ingestMergeCypher`: il `kind` è un CASE sui valori pre-scrittura,
`INGEST_HISTORY_KIND_CYPHER`), a `setCorrelation`, ai SET di soppressione,
sfarfallio, stabilizzazione e delle mutation: se la voce non si scrive,
fallisce l'operazione (il job ritenta). Solo la chiusura automatica e la
richiesta di rivalutazione usano `appendEventHistory` (statement a sé nella
stessa sessione, con lo stesso comportamento in caso di errore).

**Cap per evento**: al massimo `EVENT_HISTORY_MAX = 200` voci. Lo stesso
frammento che scrive la voce cancella le più vecchie oltre il limite (unit
subquery `CALL { … }` ordinata per `at`), **mai la `first_seen`**.

**Allarmi precedenti al deploy**: nessun backfill. Il resolver **sintetizza**
la voce `first_seen` da `first_seen_at` quando nessuna voce salvata di quel
tipo esiste (id `<eventId>:first_seen`, attore `monitoring`, senza severità:
quella di allora non è nota), inserita nell'ordine della lista e sempre
presente anche oltre `limit`; `historyCount` la conta. Lettura: `history`
restituisce le ultime `limit` voci (default 100, massimo 200) dalla più
recente, in una query sull'indice (a parità di istante — ingest e pipeline
scrivono con lo stesso `now` — la voce dell'ingest è la più vecchia e l'esito
della pipeline il più recente); `actor`, `incident`, `change`, `ci` sono
field resolver (null se l'entità non esiste più; la change segue la query
`change`, quindi null se eliminata). Stessi ruoli di `event(id)`.

### Metriche e pannelli

`GET /metrics` (`middleware/metrics.ts`, riga *Event Management* del
cruscotto Grafana `infra/grafana/dashboards/opengraphity-api.json`):

| Metrica | Tipo | Incrementata da |
|---|---|---|
| `events_received_total{connector}` | counter | ogni ingest (nuovo o ripetuto), etichetta = connettore della sorgente |
| `events_deduplicated_total` | counter | ingest che ha trovato l'impronta (ripetizione) |
| `events_orphan_total` | counter | ingest senza CI riconosciuto |
| `events_ambiguous_total` | counter | ingest lasciato orfano perché più CI hanno lo stesso nome (`match_reason = ambiguous`; conta anche in `events_orphan_total`) — un valore che cresce = nomi duplicati nella CMDB da disambiguare con alias o rinomina |
| `events_suppressed_total` | counter | prima soppressione per finestra di change (non le ripetizioni) |
| `events_flapping_total` | counter | ingresso in sfarfallio |
| `incidents_auto_opened_total` | counter | incident aperti dalla correlazione e incident di tempesta (non `createIncidentFromEvent`) |
| `incidents_auto_resolved_total` | counter | chiusure automatiche |
| `incidents_reopened_total` | counter | riaperture per allarme tornato |
| `events_purged_total` | counter | eventi eliminati dalla conservazione |
| `events_rejected_total{connector}` | counter | elementi di un payload scartati dalla normalizzazione (accettazione parziale del batch, o intero payload rifiutato con 400); il motivo è in `last_error` della sorgente |
| `events_resolved_unknown_total{connector}` | counter | payload `resolved` di allarmi mai visti: Event creato già risolto, nessun avviso |
| `event_storms_active` | gauge | sorgenti in tempesta (riallineato a ogni inizio/fine e dal job periodico) |
| `events_correlated_total{outcome}` | counter | ogni passata della pipeline con l'esito finale: `opened`, `attached`, `reopened`, `skipped_severity`, `skipped_orphan`, `delayed`, `none`, `suppressed`, `flapping`, `storm`, `storm_no_ci`, `auto_resolved`, `auto_resolve_skipped`, `error` (la pipeline ha lanciato: il job ritenta) |
| `event_pipeline_duration_seconds{mode}` | histogram | durata della pipeline per evento (`ingest`, `reevaluate`, `resume`) |
| `event_pass_total{pass,result}` | counter | passate del job `events-maintenance` (`closed_windows`, `pending`, `flapping`, `storms`, `gauges`) per esito (`ok`, `failed`) |
| `event_pass_duration_seconds{pass}` | histogram | durata di ogni passata (una passata oltre i minuti = 2.1: troppi eventi in stato di attesa) |
| `events_overdue_delayed` | gauge | eventi `delayed` con `correlation_due_at` scaduta da più di 5 minuti: il job `correlate` non è arrivato (coda ferma o job id già usato) — riallineato dal job periodico |
| `events_firing_uncorrelated` | gauge | eventi firing con correlazione `none`/`pending` da più di 15 minuti: pipeline fallita a ogni tentativo e mai ripresa — riallineato dal job periodico. Dalla revisione 2 la passata `pending` usa lo STESSO predicato e li riprende: se il gauge resta > 0 per due giri, è la passata a fallire (vedi `event_pass_total{pass="pending",result="failed"}`) |
| `events_out_of_order_total{connector}` | counter | payload più vecchio dell'ultimo applicato alla stessa impronta ma con uno stato DIVERSO: **applicato** lo stesso e loggato a `warn` con i due istanti (revisione 2 · B2-06). Uno più vecchio con lo stesso stato è innocuo e conta come `duplicate`. Se cresce: orologi delle repliche API non sincronizzati (NTP) o riordino della coda |
| `event_correlate_job_lag_seconds` | histogram | ritardo del job `correlate` rispetto alla scadenza del ritardo (processedAt − dueAt) |

Pannelli: *Eventi/s per esito* (ricevuti, deduplicati, soppressi, sfarfallio),
*Incident automatici al minuto* (aperti/risolti/riaperti), *Tempeste di allarmi
attive*. Allarmi consigliati: `event_storms_active >= 1` per più di 10 minuti;
`rate(events_orphan_total[15m]) / rate(events_received_total[15m]) > 0.2`
(alias/nomi dei CI non allineati con il monitoraggio);
`bullmq_queue_depth{queue="events-ingest",status="failed"} > 0`;
`events_overdue_delayed > 0` o `events_firing_uncorrelated > 0` per più di 15
minuti (allarmi attivi senza incident: guardare i job falliti e il log
`re-evaluation failed`); `rate(events_correlated_total{outcome="error"}[15m]) > 0`;
`histogram_quantile(0.95, rate(event_correlate_job_lag_seconds_bucket[15m])) > 60`
(coda `events-correlate` in ritardo). I log della pipeline portano
`fingerprint` (ritrova l'allarme sullo strumento) e `jobId` (ritrova il job in
coda) oltre a tenant, evento, incident, change e sorgente.

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

**Evento orfano** (`event.orphan`, contatore *Orfani*): guardare
`Event.matchReason` (vedi *Riconoscimento del CI*). `none` = nessun CI con
quel nome né alias `hostname/ip/fqdn` con quel valore né alias `external_id`
uguale a `resourceExternalId` (confronto in minuscolo, porta tolta da
`host:porta`); tipico FQDN dell'allarme contro nome corto in CMDB (o viceversa):
accendere `match_short_hostname` nella policy, oppure creare l'alias.
`ambiguous` = più CI con lo stesso nome (i candidati sono nel payload di
`event.orphan` e nel log `more than one CI matches the resource name`):
l'evento non viene agganciato finché non lo si collega a mano o non si
disambiguano i CI (alias `hostname`/`external_id` sul CI giusto, rinomina);
`events_ambiguous_total` cresce a ogni payload. Dal dettaglio evento
**Collega a un CI** con *crea alias*: da quel momento la sorgente viene
riconosciuta da sola e l'evento viene rivalutato (salute, correlazione). Molti
orfani dalla stessa sorgente → allineare il campo risorsa del connettore (es.
`labels.host` invece di `instance`) o creare gli alias in blocco
(`createCIAlias`).

**Sorgente con errori** (`last_error`, `error_count` sul webhook, log
`webhook-inbound`): il payload è stato rifiutato con 400 e il motivo indica il
campo (`alerts[0].labels.severity must be one of: …`, `event_value must be
"1" (problem) or "0" (recovery)`, `resourceKind is missing: set
default_values.resourceKind`). Sistemare `value_mapping`/`default_values` o la
regola nello strumento; `last_error` resta finché un nuovo payload scartato non
lo sostituisce (un job riuscito azzera solo gli errori `ingest:` del worker). 401 =
token sbagliato (solo header `Authorization: Bearer`), 404 = webhook
disabilitato o id errato, 429 = più richieste/min del limite della sorgente
(`rate_limit_per_minute`, 100 se mai impostato; header `Retry-After` — alzare
il limite o mandare batch più grandi, fino a 500 allarmi), 503 = tutti gli
isolate del transform script occupati (`Retry-After: 5`, lo strumento
ritenta), 500 = Redis giù (lo strumento ritenta).

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

**Evento resta `suppressed` a finestra chiusa**: la passata `closed_windows`
del job `events-maintenance` gira ogni 5 minuti; se la change è uscita dal
passo `deployment`/`scheduled` da più tempo, guardare i job falliti delle code
`events-correlate`/`events-maintenance` (`bullmq_queue_depth{status="failed"}`,
`event_pass_total{result="failed"}`) e il log `Suppressed event
re-evaluation failed`; `reevaluateEvent` dal dettaglio lo sblocca subito.

**Salute del CI che non cambia**: `health_source = manual` (forzatura
manuale: togliere l'override dal dettaglio CI) o `ci.status = maintenance`
(ciclo di vita: il monitoraggio non tocca un CI in manutenzione). All'USCITA
dalla manutenzione la salute viene ricalcolata dalla mutation stessa
(revisione 2 · B2-14) e solo dopo i servizi vengono avvisati: prima restava
quella di prima della finestra finché lo strumento non rimandava un payload.

**Sorgente eliminata**: `deleteInboundWebhook` chiude i suoi allarmi ancora
accesi nella stessa transazione (voce di cronologia `resolved_manually` con il
motivo), poi ricalcola la salute dei CI toccati e li fa ripassare dalla
pipeline, così gli incident si chiudono per la via normale (revisione 2 ·
D4.1). La mutation risponde con `resolvedEvents`/`affectedCIs`. Se la
riconciliazione fallisce dopo il commit l'errore è esplicito (la sorgente resta
eliminata): rimediare con `reevaluateEvent` sugli allarmi elencati nel log.

### Servizi monitorati (mappa del servizio e albero d'impatto)

Progetto: artifact "Servizi monitorati" (10 set 2026), ondate 1–4. Un
**servizio monitorato** è una `BusinessApplication` con una `ServiceMap`
(`(:BusinessApplication)-[:HAS_SERVICE_MAP]->(:ServiceMap)`, una per
servizio): i componenti che la reggono sono `INCLUDES {level, role, propagate,
weight, critical, via, added_by, added_at}` verso i CI (livello 1 = le
applicazioni raggiunte con `REALIZES`, 2.. = i fornitori seguendo IN USCITA
`DEPENDS_ON`/`HOSTED_ON`/`INSTALLED_ON`/`USES_CERTIFICATE` fino a `max_depth`,
default 4, massimo 8, tetto 500 nodi: oltre è un `BAD_USER_INPUT` con il
conteggio, mai un taglio silenzioso); la mappa è **viva** per default
(`auto_sync = true`, ondata 5: si aggiorna da sola appena cambia la CMDB, vedi
*Mappa viva o congelata* più sotto) e conserva `node_ids` per accorgersi
di un CI cancellato. Codice: `apps/api/src/services/serviceImpact/`
(`rules.ts` funzione pura, `build.ts` costruzione con
`apoc.path.expandConfig` BFS/`NODE_GLOBAL`, `engine.ts` valutazione,
`history.ts` cronologia, `config.ts` configurazione da interfaccia,
`sync.ts` sincronizzazione con la CMDB), `jobs/serviceImpactWorker.ts`,
`consumers/serviceImpactConsumer.ts`, resolver `graphql/resolvers/services.ts`,
vocabolari `lib/serviceVocabularies.ts`.

**Salute e punteggio** (`ServiceMap.health`, `impact_score` 0–100,
`explanation` JSON con le cause e il percorso `via` fino al livello 1), dalle
regole per mappa (`rules` JSON, default `down_share_pct 50`,
`degraded_share_pct 1`, `min_nodes 1`, `unknown_nodes operational`,
`open_incident_from down`): contano i nodi con `propagate ≠ never`, non in
finestra di change e non in manutenzione di ciclo di vita; i nodi senza salute contano come operativi nel denominatore (`unknown_nodes = operational`, default: una copertura parziale non gonfia l'impatto) o sono esclusi (`ignore`); nessun nodo con salute nota → `unknown`;
`impact_score = round(100 · (Σ peso giù + 0,5 · Σ peso degradati) / Σ peso)`;
`down` se un critico che conta è giù o la quota ponderata dei giù ≥
`down_share_pct`, poi `maintenance` se un nodo critico è in **finestra di
change** (stessa regola della soppressione degli allarmi, `deployment` sempre /
`scheduled` dentro una finestra del piano, hops 0), `degraded` se il punteggio ≥
`degraded_share_pct` e i non operativi ≥ `min_nodes`, `unknown` se nessun
nodo conta, altrimenti `operational`.

**Le due manutenzioni sono cose diverse** (revisione 2 · R1) e vanno tenute
distinte quando si legge una mappa:

| Condizione | Il nodo conta? | Il servizio va in `maintenance`? | Dove si vede |
|---|---|---|---|
| `ci.status = 'maintenance'` (ciclo di vita del CI) | **no** (come `propagate: never`: fuori dal denominatore, mai fra le cause) | **no** — è uno stato che nessuno «chiude» | `ServiceMapNode.ci.status`, `excludedReason = lifecycle_maintenance` |
| change in finestra sul CI | **no** | **sì, se il nodo è critico** | `ServiceMapNode.inMaintenance`, `excludedReason = change_window` |

**`down` vince su `maintenance`**: un critico che conta e sta giù è un guasto
vero e va detto anche mentre un altro componente è in finestra. Quando la salute
è `maintenance`, `ServiceMap.healthIfActive` porta la salute che il servizio
avrebbe **senza** quella finestra («in manutenzione, sarebbe: giù»); è `null` in
tutti gli altri casi. Fino alla revisione 2 un solo CI critico messo in
manutenzione di ciclo di vita spegneva il servizio per sempre, nascondendo ogni
guasto e impedendo qualunque incident. `always` e `weighted` pesano allo stesso
modo in ondata 1. Pesi proposti: 8 al livello 1 (critico), 3 ai certificati
(`propagate never`), 5 al resto.

| Coda / consumer | Job | Cosa fa |
|---|---|---|
| `service-impact-consumer` (BaseConsumer, fan-out di `packages/events`) | `ci.health_changed` | trova le mappe del tenant che includono il CI (`status ≠ paused`) e accoda un job per mappa |
| `services-impact` (concurrency 2, lock 10 min) | `evaluate` | dedup a **finestra** (revisione 2 · Q1): `deduplication: {id: svc-<tenant>-<mapId>, ttl: 2 s}` con `jobId` libero, e ritardo di 2 s — 40 CI dello stesso servizio in raffica = **una** valutazione, ma un cambio che arriva MENTRE il job gira ne accoda una nuova (con il vecchio `jobId` fisso quel cambio si perdeva fino alla passata periodica, ~15 min); 5 tentativi con backoff 5 s; rimosso a completamento **e** a fallimento definitivo (il fallimento resta nel log e in `service_evaluations_total{result="error"}`). Innescato da `ci.health_changed`, dalle mutation e dai **segnali di manutenzione** (`notifyCIMaintenanceChanged`, trigger `maintenance`) |
| | `services-periodic` | ogni 5 minuti: mappe attive con `evaluated_at` più vecchio di 10 minuti (o mai valutate) o `stale`, paginate (`runPagedPass`), rivalutate con trigger `periodic`; riallinea il gauge `services_health{health}` |
| | `sync` | sincronizzazione di UNA mappa viva con la CMDB (ondata 5): stessa dedup a finestra con id `svcsync-<tenant>-<mapId>` (diverso da quello della valutazione: le due code di lavoro non si deduplicano a vicenda), stesso ritardo di 2 s e stessi tentativi — un import che tocca 500 relazioni produce **una** sincronizzazione per mappa, non 500. Accodato da `notifyCIGraphChanged` (che trova le mappe anche quando il CI è appena stato **cancellato**, via `node_ids`) e dalla mutation `syncServiceMap` |
| | `services-sync-periodic` | ogni **30 minuti**: rete di sicurezza della sincronizzazione — mappe con `auto_sync = true`, `status ≠ paused` e `synced_at` più vecchio di 30 minuti (o mai sincronizzate), paginate. Rada di proposito: l'immediatezza la dà `notifyCIGraphChanged`, questa passata recupera solo ciò che è stato scritto fuori dalle mutation (script, migrazioni, Cypher a mano, coda giù) |

**Una valutazione** = una query (mappa + `INCLUDES` con `ci.health` + change
in finestra per ogni CI) + le regole + **uno statement** di scrittura, con la
**guardia di versione** `WHERE m.version = toInteger($version)` (revisione 2 ·
E1: se una sincronizzazione ha cambiato la composizione nel frattempo, non si
scrive nulla — si rilegge e si ricalcola UNA volta, alla seconda è un errore).
La decisione «salute cambiata» è nel Cypher (`previous IS NULL OR previous <>
$health`), così due valutazioni concorrenti non scrivono due voci; a salute
cambiata `health_since`, voce `ServiceHealthEntry` (`HAS_HEALTH_HISTORY`,
trigger `created | ci_health | manual | periodic | …`, cap **500** voci mai la
`created`), evento di dominio `service.health_changed` (`{map_id, service_id,
name, previous_health, new_health, impact_score}`, nessuna regola di notifica
in ondata 1) e audit; a salute invariata solo `evaluated_at` (punteggio e
spiegazione vengono comunque aggiornati). Un CI incluso che **non esiste più**
(`DETACH DELETE` porta via la `INCLUDES`) marca la mappa `stale`, scrive una
voce `map_changed` con gli id mancanti (una volta) e viene loggato con
`warn`; la valutazione prosegue sui nodi rimasti e la passata periodica la
riprende finché resta stale.

**GraphQL** (`schema-services.ts`; ruoli in `lib/authorization.ts`, tabella in
`authorization.test.ts`): letture `serviceMaps` (contatori + pagina per
gravità), `serviceMap`, `servicesImpactedByCI` per lo staff;
`serviceMapCandidates`, `serviceMapProposal`, `serviceImpactPreview` e le
mutation `createServiceMap` (costruzione automatica + valutazione immediata,
status `active` o `draft`), `reevaluateServiceMap`, `setServiceMapStatus` (con
`expectedVersion`: rimettere in servizio una mappa — da `paused` o da `draft` —
la rivaluta subito),
`updateServiceImpactRules`, `updateServiceMapNodes`,
`applyServiceMapProposal`, `removeServiceMapExclusion`,
`setServiceMapAutoSync` (interruttore mappa viva/congelata, con
`expectedVersion`), `syncServiceMap` (sincronizza ora: restituisce
`ServiceMapSyncResult` — mappa aggiornata, `added`/`removed`/`moved`,
`skipped` + `reason` quando il tetto dei 500 ha rifiutato tutto), `deleteServiceMap`
(mappa e cronologia; il servizio e i CI restano) solo admin.

**Cosa fa il motore quando…** (una riga per caso; il dettaglio è nelle
sottosezioni che seguono):

| Caso | Valutazione | Cronologia / evento | Incident del servizio |
|---|---|---|---|
| la **salute cambia** | scrive salute, punteggio, spiegazione, `health_since`, `evaluated_at` | voce `ServiceHealthEntry` con il trigger + evento `service.health_changed` + audit | riconciliato: apre, riapre, aggiorna o chiude secondo `open_incident_from` |
| la salute **non cambia** ma cambiano le **cause** | scrive punteggio e spiegazione (un punteggio stantio sarebbe un dato falso) | nessuna voce, nessun evento | riconciliato: se un incident è aperto riceve **un** commento «Causa aggiornata» |
| la salute **non cambia** e le cause **nemmeno** | solo `evaluated_at`, punteggio e spiegazione | nulla | non riconciliato: non prende nemmeno il lock |
| il servizio va in **manutenzione** (change in finestra su un componente **critico**) | salute `maintenance`, più `health_if_active` = la salute che avrebbe senza quella finestra | voce + evento se la salute cambia | né apertura né chiusura; un incident aperto riceve **una** nota (`maintenance_noted_at`), rimossa all'uscita dalla manutenzione |
| un componente ha `ci.status = maintenance` (ciclo di vita) | il nodo **non conta** (fuori dal denominatore, mai fra le cause): la salute segue gli altri componenti, `maintenance` **no** | come sempre | come sempre: se il servizio è giù l'incident si apre |
| una change **entra** o **esce** dai passi di finestra (`deployment`/`scheduled`), viene eliminata, oppure un CI entra/esce da `status = maintenance` | le mappe che includono quei CI si rivalutano entro pochi secondi (`notifyCIMaintenanceChanged`, trigger `maintenance`) | voce + evento se la salute cambia | riconciliato dalla rivalutazione |
| il servizio non raggiunge più la soglia ma **non è operativo** (degradato sotto soglia, `unknown`, regola passata a `never`) | salute scritta normalmente | come sempre | l'incident **resta aperto** con UN commento onesto (`kept_open_noted_at`, azzerato quando si torna sopra soglia): mai chiuso con «tornato operativo» |
| la mappa è in **pausa** (`paused`) | nessuna valutazione automatica: il consumer la salta, la passata periodica prende solo le `active` e le scritture di configurazione non la rivalutano — la salute mostrata resta l'ultima nota. `reevaluateServiceMap` la valuta comunque a mano; rimetterla in servizio (da `paused` o da `draft`) la rivaluta subito | nulla, finché non viene valutata | nessuna apertura né riapertura; un incident già aperto può comunque essere **chiuso** |
| la mappa è una **bozza** (`draft`) | valutata dal consumer e dalle scritture di configurazione come le attive, **non** dalla passata periodica (che filtra `status: 'active'`) | voce + evento come le attive | nessuna apertura né riapertura; chiusura sì |
| `open_incident_from = never` | valutata normalmente | voce + evento come sempre | nessun incident nuovo; quello aperto prima del cambio di regola viene comunque **chiuso** al rientro |
| un componente **non esiste più** nella CMDB | mappa `stale = true` con `stale_reason = 'missing_ci'`, valutazione sui nodi rimasti | voce `map_changed` con gli id mancanti, **una** volta, + `warn` | nessun effetto diretto (cambiano le cause: vedi sopra) |
| la **CMDB cambia** (relazione fra CI creata o cancellata, CI cancellato) | le mappe **vive** che toccano quei CI si sincronizzano entro pochi secondi (`notifyCIGraphChanged` → job `sync`), poi si rivalutano se la composizione è cambiata | voce `map_changed` «Sincronizzazione automatica: +N, −M, ~K spostati» solo se qualcosa è cambiato | riconciliato dalla rivalutazione che segue |
| la composizione **non cambia** dopo una sincronizzazione | solo `synced_at` | nulla: nessuna versione nuova, nessuna voce | non riconciliato (nessuna rivalutazione) |
| la mappa è **congelata** (`auto_sync = false`) | la CMDB non la tocca: il diff resta da applicare a mano (`serviceMapProposal` + `applyServiceMapProposal`) | nulla finché non si applica | invariato |
| la proposta supera i **500 componenti** | **niente** viene applicato, la mappa è marcata `stale` con `stale_reason = 'over_limit'` (che la valutazione non spegne: solo una sincronizzazione riuscita lo fa) | voce `map_changed` con il motivo, **una** volta, + `warn` + `service_map_syncs_total{result="skipped_limit"}` | invariato |

**Metriche** (`middleware/metrics.ts`, esposte dal registro custom su
`GET /metrics`):

| Metrica | Tipo | Dove si incrementa |
|---|---|---|
| `service_evaluations_total{result}` | contatore (`changed \| unchanged \| error`) | `serviceImpact/engine.ts#evaluateServiceMap`, alla fine (una riconciliazione fallita conta solo come `error`) |
| `service_evaluation_duration_seconds` | istogramma | idem, lettura + regole + scrittura + riconciliazione |
| `service_evaluation_lag_seconds` | istogramma | `jobs/serviceImpactWorker.ts`: secondi fra l'istante in cui il job `evaluate` era atteso (accodamento + 2 s di dedup) e l'inizio della valutazione — cresce quando la coda `services-impact` è in affanno, non quando la valutazione è lenta |
| `service_incidents_opened_total` | contatore | `serviceImpact/incident.ts`: apertura **e riapertura** (un servizio che ricade è di nuovo fuori servizio). Attenzione: `opened − resolved` è il saldo delle transizioni, non il numero di incident aperti |
| `service_incidents_resolved_total` | contatore | `serviceImpact/incident.ts`: solo la chiusura automatica riuscita; un `resolve_skipped` (nessun cammino verso «risolto» dal passo corrente) **non** conta |
| `services_health{health}` | gauge | passata periodica `services-periodic` (`engine.ts#refreshServiceGauges`), mappe per salute su tutti i tenant |
| `service_maps_stale` | gauge | stessa passata e stessa lettura: mappe con `stale = true` |
| `service_map_syncs_total{result}` | contatore (`changed \| unchanged \| skipped_limit \| error`) | `serviceImpact/sync.ts#syncServiceMap`: `changed` = composizione cambiata (versione, cronologia, rivalutazione), `unchanged` = solo `synced_at`, `skipped_limit` = proposta oltre i 500 componenti (nulla applicato, mappa `stale`), `error` = il job ritenta |

Cruscotto Grafana: riga «Servizi monitorati» in
`infra/grafana/dashboards/opengraphity-api.json` (mappe per salute,
valutazioni per esito, durata e ritardo p95, incident aperti/risolti, mappe da
rivedere). Allarmi consigliati:
`rate(service_evaluations_total{result="error"}[15m]) > 0`;
`bullmq_queue_depth{queue="services-impact",status="failed"} > 0`;
`histogram_quantile(0.95, rate(service_evaluation_lag_seconds_bucket[5m])) > 60`
(coda in affanno); `service_maps_stale > 0` da più di un giorno (mappe da
sistemare a mano).

**Seed demo**: `seed:service-maps -- --tenant=<slug>` (`dist/scripts/seed-service-maps.js`
nel container, con `NODE_ENV` diverso da `production` come ogni seed;
opzioni `--max-depth`, `--relationships`) crea una mappa per ogni
`BusinessApplication` senza mappa; idempotente.

**Risoluzione dei problemi**: *servizio `unknown`* = nessun componente con
salute (mai toccato da un allarme) o mappa vuota (`BusinessApplication` senza
`REALIZES`: warning `has no REALIZES` alla creazione); *salute che non cambia
dopo un allarme* = mappa in `paused` (il consumer la salta), CI non incluso
nella mappa (`servicesImpactedByCI`), oppure job fallito (log `Service impact
job failed`, `service_evaluations_total{result="error"}`) — `reevaluateServiceMap`
dal dettaglio la rivaluta subito, la passata periodica entro 10 minuti;
*`stale`* = la mappa è da rivedere, e `staleReason` dice perché:
`missing_ci` (un componente è stato cancellato dalla CMDB: aprire «Aggiorna
mappa» e togliere gli id spariti — `serviceMapProposal` +
`applyServiceMapProposal` — oppure ricreare la mappa con `deleteServiceMap` +
`createServiceMap`) oppure `over_limit` (la mappa supera il tetto dei 500
componenti: ridurre `max_depth` o escludere dei componenti — sincronizzare non
serve, viene rifiutata di nuovo). Una mappa marcata prima della migrazione
`20260910_1120_service_map_review2` può avere `staleReason` a null: la
migrazione lo recupera;
*servizio «in manutenzione» che non torna a posto* = fino alla revisione 2
bastava un CI critico con `ci.status = 'maintenance'`; ora solo una change in
finestra lo fa, e `healthIfActive` dice quale sarebbe la salute vera. Se resta
`maintenance` senza change, controllare `ServiceMapNode.inMaintenance` e
`excludedReason` nel dettaglio;
*incident di servizio che resta aperto con il commento «l'incident resta
aperto»* = il servizio non è tornato **operativo**, è solo sceso sotto la soglia
(o la regola è passata a `never`, o la salute è `unknown`): il monitoraggio non
lo chiude più con una causa falsa, va chiuso a mano quando è giusto; *`has no node_ids`/`has no rules`* = eseguire la migrazione
`20260910_1080_service_maps_bootstrap`; *`has no auto_sync`* = eseguire la
`20260910_1110_service_map_auto_sync`; *un componente nuovo non compare nella
mappa* = mappa congelata (interruttore «Aggiorna automaticamente i componenti»
spento) o in pausa, CI escluso (`ServiceMap.excluded`), relazione scritta da un
percorso non strumentato (arriva con la passata delle 30 minuti — «Sincronizza
ora» non fa aspettare), oppure sincronizzazione saltata per il tetto dei 500
(`service_map_syncs_total{result="skipped_limit"}`, log «would exceed the node
cap»: ridurre `max_depth` o escludere).

#### Configurazione (ondata 2: tutto da interfaccia)

Codice: `apps/api/src/services/serviceImpact/config.ts` (validazione,
transazione, cronologia, rivalutazione); i resolver mettono solo ruolo, audit
e rilettura della mappa.

**Cosa può cambiare l'amministratore** (nessuna di queste cose richiede un
deploy): le **regole** della mappa (`updateServiceImpactRules` — soglia giù,
soglia degradato, minimo di componenti, come contano i componenti senza salute,
da che salute aprire un incident); le **impostazioni dei componenti**
(`updateServiceMapNodes` — solo `propagate`, `weight` 1..10 e `critical`:
livello, ruolo e `via` restano della mappa, li decide la costruzione); la
**composizione** (`applyServiceMapProposal`: aggiunge i CI nuovi con le
impostazioni proposte e `added_by = 'manual'`, esclude, toglie) e le
**esclusioni** (`removeServiceMapExclusion`). `serviceImpactPreview` calcola
«con queste impostazioni adesso» senza scrivere nulla.

**Limiti di coerenza** (`BAD_USER_INPUT`, mai un valore corretto in silenzio):
`degraded_share_pct ≤ down_share_pct` (altrimenti «degradato» non si raggiunge
mai prima di «giù»); `min_nodes ≤` numero di componenti della mappa (almeno 1);
peso intero 1..10; regole identiche a quelle salvate o elenco di componenti
vuoto → errore (una scrittura a vuoto alzerebbe la versione e lascerebbe una
voce di cronologia senza contenuto); un `ciId` che non è nella mappa (o un id
che non appartiene alla proposta) → errore con l'id.

**Versione e conflitti**: `ServiceMap.version` parte da 1 e cresce di 1 a ogni
scrittura riuscita (stato compreso). Ogni mutation di configurazione vuole
`expectedVersion` = la `version` letta dal client; se non combacia →
`BAD_USER_INPUT` «was modified by someone else (expected version N, current is
M…)» e **niente** viene scritto (la guardia è nel Cypher,
`WHERE version = toInteger($expectedVersion)`, dentro la stessa transazione
della lettura di controllo). La UI in quel caso invita a ricaricare. Ogni
scrittura riuscita aggiorna `updated_at`/`updated_by`, scrive **una** voce di
cronologia con nota leggibile (`rules_changed` per il calcolo — «Regole
aggiornate: soglia giù 50 → 70» —, `map_changed` per la composizione —
«Mappa aggiornata: +2, −1, esclusi 3») nello stesso statement, un audit
(`service_map.rules_changed`, `.nodes_changed`, `.proposal_applied`,
`.exclusion_removed`) e **rivaluta subito** la mappa con lo stesso trigger.
Le mappe `paused` non vengono rivalutate: la salute mostrata resta l'ultima
nota (`reevaluated: false` nell'audit).

**Diff con il grafo** (`serviceMapProposal`): ricostruisce la proposta con
`buildServiceMap` usando `max_depth` e `relationship_types` **della mappa** e
la confronta con le `INCLUDES` di adesso — `added` (nel grafo, non nella mappa,
non esclusi), `removed` (nella mappa e non più raggiungibili; un CI cancellato
dalla CMDB compare con livello 0, ruolo `component` e `addedBy = 'gone'`
perché della mappa resta solo l'id in `node_ids`), `moved` (livello o `via`
cambiati), `excluded`, `totalProposed` (per il tetto di 500). Applicando il
diff, `node_ids` viene ricalcolato dalle `INCLUDES` rimaste **più** gli id
spariti che non sono stati tolti: togliere gli ultimi id spariti spegne
`stale` senza dover ricreare la mappa.

**Esclusioni**: `(:ServiceMap)-[:EXCLUDES {reason: 'escluso a mano',
excluded_by, at}]->(ci)`. Un CI escluso non viene più riproposto dal diff
(e, se era incluso, viene tolto dalla mappa nello stesso apply);
`ServiceMap.excluded` li elenca nel dettaglio e `removeServiceMapExclusion` lo
riammette (tornerà nella prossima proposta). Le esclusioni non hanno effetto
sulla salute finché la proposta non viene applicata.

#### Mappa viva o congelata (ondata 5)

Codice: `apps/api/src/services/serviceImpact/sync.ts`. La mappa nasce **viva**
(`ServiceMap.auto_sync = true`): i componenti seguono la CMDB da soli.
L'interruttore per mappa (`setServiceMapAutoSync`, «Aggiorna automaticamente i
componenti» nel dettaglio del servizio) la **congela**, riportandola al
comportamento delle ondate 1–4.

| | Mappa **viva** (`auto_sync = true`, default) | Mappa **congelata** (`auto_sync = false`) |
|---|---|---|
| componente nuovo nel grafo | aggiunto da solo, con le impostazioni proposte e `added_by = 'auto'` | proposto nel diff, aggiunto quando l'amministratore applica |
| componente non più raggiungibile | tolto **solo** se `added_by = 'auto'` | proposto fra le rimozioni |
| componente spostato (livello o `via`) | `level` e `via` aggiornati | proposto fra gli spostamenti |
| componente aggiunto a mano (`added_by = 'manual'`) | **mai** tolto: lo toglie una persona | mai tolto |
| esclusioni (`EXCLUDES`) | **mai** riproposte | mai riproposte |
| `propagate`, `weight`, `critical` | **mai** toccati: sono decisioni dell'amministratore | mai toccati |
| pulsante nel dettaglio | «Sincronizza ora» (`syncServiceMap`) | «Aggiorna mappa» (dialogo del diff) |

**Quando succede.** Subito, non ogni tot minuti: **ogni scrittura che crea o
cancella una relazione fra CI, o cancella un CI, chiama
`notifyCIGraphChanged(tenantId, ciIds, motivo)`** dopo il commit. L'helper
trova le mappe vive (`auto_sync = true`, `status ≠ paused`) che includono uno
di quei CI **o** il cui servizio è uno di essi (una `REALIZES` nuova sulla
`BusinessApplication` non tocca nessun componente incluso) e accoda **un** job
`sync` per mappa. Punti strumentati: `addCIRelationship` e
`removeCIRelationship` (`resolvers/ciRelationships.ts`), la cancellazione di un
CI (`resolvers/ciMutations.ts`), la riconciliazione della discovery (una
chiamata per **lotto** con tutti gli id toccati, `discovery/reconciliationEngine.ts`)
e `resolveConflict` con esito `linked` (`resolvers/sync.ts`). La notifica **non
lancia mai**: la scrittura CMDB è già committata e non si annulla perché la
coda non risponde — l'errore è loggato con `error` («could NOT be enqueued») e
la passata `services-sync-periodic` recupera entro 30 minuti. Quella passata è
la **rete di sicurezza**, non il meccanismo: serve alle scritture fatte da
script, migrazioni o Cypher a mano.

**Cosa scrive una sincronizzazione.** Ricostruisce la proposta con
`buildServiceMap` (stessi `max_depth` e `relationship_types` della mappa),
calcola il diff con `computeServiceMapDiff` (che già toglie gli `EXCLUDES`) e
applica tutto in **una** transazione, con la stessa guardia di versione delle
altre scritture di configurazione. Se qualcosa è cambiato: `version + 1`,
`updated_by = 'monitoring'` (o l'utente, per la sincronizzazione manuale),
`synced_at`, voce di cronologia `map_changed` («Sincronizzazione automatica:
+2, −1, ~3 spostati» / «Sincronizzazione richiesta da …»), audit
`service_map.synced` e **rivalutazione** immediata (trigger `map_changed`), che
può aprire o chiudere l'incident del servizio come sempre. Se **non** è
cambiato nulla: solo `synced_at` — nessuna versione nuova (i client che hanno
già letto la mappa non si ritrovano in conflitto), nessuna voce, nessun evento,
nessuna rivalutazione. Gli id di CI spariti dalla CMDB escono da `node_ids`
(la loro `INCLUDES` se n'era già andata con il `DETACH DELETE`, quindi non c'è
più nessun `added_by` da rispettare) e la mappa smette di essere `stale`.

**Tetto dei 500 componenti**: se la proposta lo supera, la sincronizzazione
**non tronca e non applica nulla** — marca la mappa `stale`, scrive **una**
voce di cronologia con il motivo (solo la prima volta: una mappa troppo grande
non deve riempire la cronologia di una voce ogni mezz'ora), logga `warn` e
conta `service_map_syncs_total{result="skipped_limit"}`. L'amministratore deve
ridurre `max_depth` o escludere dei componenti.

**Mappe in pausa**: mai sincronizzate, nemmeno a mano — `syncServiceMap` su una
mappa `paused` è un `BAD_USER_INPUT` che invita a riattivarla. È la stessa
regola della valutazione: una mappa che l'amministratore ha fermato resta
ferma. Le mappe **congelate**, invece, si sincronizzano a mano senza problemi:
è un'azione esplicita.

#### Incident del servizio (ondata 3) e incident tecnici (ondata 4)

Codice: `apps/api/src/services/serviceImpact/incident.ts`. Dopo ogni
valutazione **rilevante** (salute cambiata, oppure insieme delle cause
cambiato) il motore chiama `reconcileServiceIncident`, tutto sotto il lock
Redis `og:services:incident:<tenant>:<mapId>` (TTL 30 s, attesa 5 s: il worker
ha concurrency 2 e la stessa mappa può essere valutata da un job e da una
mutation nello stesso istante). **Un solo** incident non chiuso per mappa,
collegato con `(:Incident)-[:IMPACTS_SERVICE {opened_by, at, cause_ids,
maintenance_noted_at}]->(:ServiceMap)`; un incident in `resolved` non è chiuso:
si **riapre**, non si affianca. Ogni scrittura passa da `incidentService` /
`workflowEngine` con l'attore `monitoring` (mai Cypher diretto sull'incident).

Priorità dell'incident = **impatto × urgenza**: impatto dalla criticità del
servizio (`BusinessApplication.criticality`: `mission_critical` e
`business_critical` → alto, gli altri → medio; criticità assente o ignota →
medio **con un warning**), urgenza dalla salute (giù → alta, degradato →
media). CI impattati = i CI delle cause (al più `SERVICE_MAX_CAUSES`). Alla
chiusura il monitoraggio percorre i passi intermedi trovati nella definizione
(`findAutoResolvePath`, la stessa degli allarmi rientrati) e chiude con causa
«Servizio tornato operativo»; se da quel passo non c'è cammino verso «risolto»
scrive **solo** un commento: mai una transizione forzata.

**Due incident, nessuna soppressione** (ondata 4, decisione presa): un allarme
critico su un CI incluso in una mappa apre l'incident del CI (Event Management)
**e** quello del servizio, e continua a farlo — sono due ticket con due
proprietari diversi. All'apertura dell'incident di servizio, però, la
descrizione elenca gli **incident tecnici già aperti** sui CI delle cause
(numero e titolo, al più 10, riga introduttiva «Incident tecnici già aperti sui
componenti:»; se non ce ne sono, nessuna riga). È **una** query in più, solo
all'apertura, scopata per tenant: sono gli incident non terminali che hanno fra
i CI impattati un componente delle cause, esclusi gli incident di servizio
(`IMPACTS_SERVICE`). I numeri finiscono anche nell'audit
`service.incident_opened` (`technicalIncidents`).

Dal dettaglio: `ServiceMap.openIncident` (l'incident aperto del servizio) e
`Incident.impactedServices` (i servizi che hanno aperto quell'incident).

#### Limiti di piano, pulizia e conservazione (ondata 4)

**Limite di piano**: `TenantSettings.max_service_maps` (`packages/types`,
appiattito su `:Tenant`) — **starter 5, pro 50, enterprise 200**
(`lib/tenantPlans.ts`, unica sorgente per l'onboarding e per la migrazione).
`createServiceMap` conta le mappe del tenant **prima** di espandere il grafo e
rifiuta con `BAD_USER_INPUT` «piano starter: massimo 5 mappe di servizio, ne
esistono già 5». Un tenant senza nodo `:Tenant` o senza `max_service_maps` è un
**errore** che nomina la migrazione da eseguire (`20260910_1100_service_map_plan_limit`
/ `20260910_1070_event_management_tenants`): il limite non viene mai inventato
a runtime. Alzare il limite di un singolo tenant è un `SET t.max_service_maps`
a mano (la migrazione non lo riscrive). Due creazioni simultanee sull'ultimo
posto possono superare il limite di una (Neo4j non blocca un conteggio): la
successiva viene comunque rifiutata.

**Cancellazione di una `BusinessApplication`** (`graphql/resolvers/ciMutations.ts`,
stessa scrittura che porta via i `CIAlias`): vanno via anche la sua
`ServiceMap`, la cronologia (`ServiceHealthEntry`) e — con il `DETACH DELETE`
della mappa — le relazioni `INCLUDES`, `EXCLUDES` e `IMPACTS_SERVICE`.
L'incident del servizio eventualmente aperto **non** si cancella: è storia del
ticket e resta senza servizio collegato — ma dalla revisione 2 (D4.3) riceve
**un commento** PRIMA che la mappa sparisca («il servizio non è più
monitorato: la mappa è stata eliminata»), perché senza mappa nessuno potrà più
chiuderlo automaticamente e per l'operatore sarebbe un incident critico senza
motivo. Lo stesso vale per `deleteServiceMap`. Un commento che fallisce viene
loggato e non ferma la cancellazione. Un job `evaluate` già in coda
per quella mappa fallisce con `NOT_FOUND` (5 tentativi, log `Service impact job
failed`, `service_evaluations_total{result="error"}`) e poi sparisce
(`removeOnFail`): rumore atteso, non un guasto — a differenza di
`deleteServiceMap`, che il job in coda lo toglie subito.

**Cancellazione di un CI con allarmi o incident** (revisione 2 · D4.3): gli
Event `RAISED_ON` restano come orfani coerenti (il CI di un Event vive solo
nella relazione), ma l'incident non terminale il cui **unico** CI impattato era
quello cancellato riceve un commento («Il CI X è stato eliminato dalla CMDB»):
resta aperto, e chi lo legge sa perché il rientro degli allarmi non lo chiuderà
più (senza CI diventano `skipped_orphan`).

**Cancellazione di un CI incluso in una mappa**: la mappa **resta**. Perde la
`INCLUDES` (cade con il CI) e alla prima valutazione diventa `stale`, con una
voce `map_changed` che elenca gli id mancanti; la valutazione prosegue sui nodi
rimasti. Si sistema da «Aggiorna mappa» (vedi *Risoluzione dei problemi*).

**Conservazione della cronologia**: `ServiceHealthEntry` ha **solo** il cap di
`SERVICE_HISTORY_MAX` = 500 voci per mappa, applicato dallo stesso statement
che scrive la voce (la prima voce `created` non viene mai cancellata). **Non**
c'è retention temporale e nessun job di purge: una mappa che cambia salute due
volte al giorno conserva quasi un anno di storia, una che sfarfalla ne conserva
molto meno. Se serve conservare di più, la voce va portata fuori (export /
report), non allungando il cap.
