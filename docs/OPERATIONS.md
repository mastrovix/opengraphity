# Operazioni — OpenGraphity

Guida operativa: backup e restore, migrazioni dei dati, script, rotazione dei
segreti, checklist per gli incidenti operativi. Il deploy è in `DEPLOY.md`;
il catalogo degli script in `apps/api/src/scripts/README.md`.

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
