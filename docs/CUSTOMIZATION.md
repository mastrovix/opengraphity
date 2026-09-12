# Cosa il cliente può personalizzare, e cosa resta di fabbrica

Questa pagina nasce dal difetto **D-19**: la documentazione prometteva cose che
il codice non fa, e non diceva affatto dove finisce la personalizzazione. Serve
a chi installa, a chi assiste un cliente e a chi scrive codice nuovo.

Una regola sopra tutte: **il nome non decide niente**. I passi di un workflow, i
valori di un vocabolario e i tipi CI si rinominano dall'interfaccia, quindi
nessuna logica di prodotto può riconoscerli dal nome. Decidono i metadati
(`purpose`, `category`, `is_terminal`, `scope`), che il cliente vede e modifica.

---

## 1. La tabella

| Cosa | Chi lo possiede | Si può rinominare? | Note |
|---|---|---|---|
| **Tipi CI base e ITIL** (`server`, `application`, `incident`, `change`, …) | prodotto, un nodo per tutti (`tenant_id = 'system'`, `scope = 'base' \| 'itil'`) | l'**etichetta** sì (è per tenant), il **nome** no | Il nome è la chiave con cui l'SDL costruisce il tipo GraphQL: cambiarlo romperebbe le query di tutti |
| **Campi dei tipi base/ITIL spediti** | prodotto, condivisi | no | In sola lettura: togliere un campo da qui lo toglierebbe a ogni cliente. L'API lo rifiuta dicendolo |
| **Campi aggiunti a un tipo ITIL** | il cliente (`tenant_id` del cliente) | sì | Nascono suoi anche su un tipo condiviso. `(tipo, nome)` è unico: un omonimo è rifiutato |
| **Tipi CI creati dal cliente** | il cliente (`scope = 'tenant'`) | sì | `(tenant_id, nome)` è unico (vincolo nel database). Il nome è `camelCase` senza trattino basso: `costCenter`, non `cost_center` — altrimenti due nomi finirebbero sulla stessa proprietà Neo4j |
| **Relazioni di un tipo del cliente** | il cliente | sì | `(tipo, nome)` unico; `relationship_type` deve essere un identificatore Neo4j valido |
| **Vocabolari spediti** (`severity`, `urgency`, `risk_band`, …) | prodotto, **un nodo per tutti** (`tenant_id = 'system'`, `is_system = true`) | no direttamente | Si personalizzano con `customizeEnumType`, che ne fa una **copia del cliente**: la copia omonima vince in lettura. L'originale resta intatto per gli altri |
| **Vocabolari del cliente** | il cliente | sì | `(tenant_id, nome)` unico (vincolo nel database) |
| **Matrici di dominio** (priorità = impatto × urgenza, criticità → impatto, severità dell'allarme, tipo × rischio della change, severità dell'import) | il cliente | — | Nascono col seme del prodotto e si modificano in Impostazioni → Matrici di dominio |
| **Definizioni di workflow, passi, transizioni** | il cliente | sì | Il seed non riallinea una definizione esistente. Ciò che conta sono `purpose`/`category`/`is_terminal`, non il nome |
| **Regole di notifica, canali, webhook, chiavi API** | il cliente | sì | I permessi di una chiave sono un elenco chiuso (§4) |
| **Vocabolari del portale** (le schede «Aperti/In corso/Risolti/Chiusi») | prodotto | — | Sono **classi di stato**, dedotte dai metadati dei passi, non nomi di passo |

---

## 2. Nomi riservati

- `__base__` — il tipo CI condiviso che porta i campi comuni a tutti i tipi.
- `system` — il `tenant_id` dei nodi spediti col prodotto. Non è un cliente: non
  ha ticket, non ha dashboard, ed è escluso dalle migrazioni per tenant.
- I nomi dei tipi ITIL (`incident`, `change`, `problem`, `service_request`) e dei
  tipi base: un tipo del cliente non può chiamarsi così.
- `tenant_id`, `id` e le altre proprietà di sistema: un campo che dopo la
  conversione in snake_case collidesse con una di queste è rifiutato (un campo
  chiamato `tenantId` diventerebbe `tenant_id` e scriverebbe il CI nel cliente
  scelto da chi chiama l'API).

---

## 3. Rinominare un passo di workflow

Si può, ed è previsto. Ciò che il prodotto guarda **non** è il nome:

| Serve a | Dato che decide |
|---|---|
| stato aperto / risolto / chiuso, schede e contatori del portale | `category` + `is_terminal` + `is_open` |
| transizioni automatiche, approvazioni, soppressione in finestra di change | `purpose` del passo |
| tipo dell'evento di dominio e azione di audit | il `purpose`, non il nome |

Restano due punti in cui il **nome** conta ancora, e sono dichiarati:

- `FieldRequirementRule.workflow_step` cita il passo per nome. Il pannello e il
  seed verificano che il passo esista **al momento della scrittura**, ma una
  rinomina successiva spegne la regola senza avvisare.
- Le automazioni e i timer (`transition_workflow.to_step`, `timer_wait.toStep`)
  nominano il passo di destinazione; la scrittura lo valida contro i passi veri.

## 4. Elenchi chiusi (l'interfaccia offre ciò che il server applica)

Tre vocabolari sono **chiusi** per costruzione, e vivono in un posto solo
(`@opengraphity/types`) perché li leggono sia l'API sia il web:

| Elenco | Dove | Chi lo applica |
|---|---|---|
| Permessi di una chiave API | `API_KEY_PERMISSIONS` | `createApiKey`/`updateApiKey` rifiutano il resto; un lint statico li confronta coi `requirePermission` delle rotte |
| Bersagli della mappa di un webhook di ticket | `INBOUND_TICKET_FIELDS` | il salvataggio rifiuta un bersaglio che la consegna non scriverebbe (prima lo accettava e poi lo scartava con un `201 Created`) |
| Campi scrivibili da un'azione `update_field` | `UPDATE_FIELD_ALLOWED` | lo stato non è fra questi: si cambia con una transizione |

Un webhook di ticket scrive quattro campi (`title`, `description`, `severity` o
`priority`, `category`). **Aperto**: passare anche i campi aggiunti dal cliente
ai servizi di creazione dei ticket, come già si fa per i CI.

---

## 5. Le derivazioni dal nome che restano, e perché

`scripts/migrations/20260908_1000_workflow_step_metadata.ts` deriva `category`,
`is_terminal` e `step_order` dal **nome** del passo. È una **migrazione storica**
— serviva a dare metadati ai passi nati prima che i metadati esistessero — e
non è una regola del prodotto:

- scrive solo dove il valore **manca** (`coalesce`), quindi non riscrive mai una
  scelta dell'amministratore, nemmeno con `--force`;
- il ripristino di fabbrica è un'operazione a parte, esplicita e con diff
  (`migrate-workflow-metadata --reset-from-factory`);
- i metadati di un passo li dichiara il **seed** della definizione
  (`packages/workflow/src/seed*.ts`, `scripts/lib/workflowDefinitions.ts`), non
  una tabella di nomi.

**Regola di linea per le migrazioni future: mai derivare qualcosa dal nome di un
passo, di un valore o di un tipo.** Se un dato manca, si dichiara dove nasce.

---

## 6. Dove guardare quando qualcosa «non si vede»

| Sintomo | Dove guardare |
|---|---|
| Un tipo CI creato dal cliente non compare nella ricerca globale / nei widget / nella REST | le cuciture che elencano i tipi: `lib/ciLabelsForTenant.ts` è la sorgente giusta, gli elenchi statici sono vietati dal lint `ciLabelSources` |
| Un valore aggiunto a un vocabolario non compare in un form | il campo punta al vocabolario del cliente? `customizeEnumType` fa la copia |
| Una regola sui campi «c'è ma non scatta» | il passo è stato rinominato dopo (§3) |
| Un tenant esiste e non può aprire ticket | `migrate --status` elenca i tenant incompleti; li completa la migrazione `20260918_1910` |
| Una voce della mappa di un webhook «non arriva» | §4: il salvataggio ora la rifiuta; una configurazione vecchia la fa finire in `last_error` sulla sorgente |
