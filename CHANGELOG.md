# Changelog

Modifiche rilevanti al progetto. Ordine dal più recente.

## 2026-09-05 — Rifiniture ITSM, coerenza workflow e chiusura lacune UI

### Service Request
- Il **catalogo servizi** è ora usato anche nella creazione di una richiesta dal main app
  (selettore "Voce di catalogo" consigliato, richiesta generica ancora possibile). `ac6701b`
- Workflow di evasione completo, catalogo servizi (admin + self-service nel portale),
  transizioni della richiesta pilotabili dal dettaglio. `0964ed7`

### Incident / Problem
- Alla creazione di un **incident** il **CI impattato è obbligatorio** (UI + backend;
  il portale self-service resta esente). `710d497`
- Fix: il **dettaglio problem** andava in errore — la query chiedeva campi obsoleti del
  tipo Change (`type/status/scheduledStart`). `8a599b7`

### Stato dei ticket
- Lo **status** di incident/problem/change/service request cambia **solo** tramite le
  transizioni di workflow: rimosso `status` dagli input di update. `8945a2d`

### SLA / OLA / UC
- **Report SLA** con compliance reale e attainment OLA/UC; entità OLA/UC di prima classe. `0964ed7`
- **Pausa/ripresa SLA** su step di attesa, con granularità per-tipo (response/resolve). `0964ed7` `5c315e0`
- **Breach OLA/UC** proattivo (anche per i change) e **auto-escalation** su breach SLA/OLA
  (esegue la transizione con trigger `sla_breach`). `5c315e0` `7612404`

### Knowledge Base
- **Versioning** degli articoli (snapshot ad ogni modifica, storico, ripristino). `0964ed7`

### Workflow Designer
- Ora si possono **creare ed eliminare transizioni** (e step) dall'interfaccia, con
  persistenza degli handle — così l'auto-escalation è configurabile senza codice. `43160aa`

### Codice / UI
- Chiuse le lacune UI: creazione team, assegnazione owner/support ai CI, edit incident/SR,
  eliminazione problem/step, annullamento approvazioni, edit/elimina messaggi chat interna. `16e4e58`
- Fix: assegnazione owner/support del CI ora **sostituisce** invece di accumulare. `16e4e58`

Storia precedente (KEDB, priorità Impatto×Urgenza, Major Incident, tipi Change+CAB, layer AI/GraphRAG,
revisione architetturale) nei commit fino a `618624f` e nelle note di progetto.
