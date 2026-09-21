/**
 * Ondata 2 delle quattro decise il 13 set 2026 — **impatto, urgenza e
 * priorita nel metamodello ITIL**.
 *
 * Il nodo Incident ha `impact`, `urgency` e `priority` da sempre, e
 * l'interfaccia li mostra. Il METAMODELLO no. Conseguenze misurate dal vivo:
 *
 *  - nelle condizioni e nelle azioni di trigger e business rule quei tre campi
 *    NON comparivano: si poteva scrivere «se la severita e critical», non «se
 *    la priorita e P1»;
 *  - la tendina «Ambito» delle policy SLA leggeva `incident.priority` dal
 *    metamodello e, non trovandolo, restava VUOTA: su quella pagina non si
 *    poteva scrivere nessuna policy per severita o priorita.
 *
 * Il problem ha gia `priority` ma non impatto e urgenza, e il suo form li
 * scrive (priorita = impatto × urgenza, come per l'incident): quindi ne riceve
 * due.
 *
 * ## `required: false`, di proposito
 *
 * `required` guida `validateRequiredFields`, che gira anche sul percorso REST
 * v1: marcarli obbligatori comincerebbe a rifiutare richieste che ieri
 * passavano. Il campo qui serve a essere NOMINABILE; chi deve esserci lo
 * impongono gia il form e la matrice di dominio.
 *
 * ## Perche in coda
 *
 * L'ordine dei campi decide la disposizione nelle pagine che li rendono:
 * inserirli in mezzo avrebbe rinumerato i campi esistenti. Si aggiungono dopo,
 * e nel disegnatore compaiono in fondo.
 *
 * Scritta sui tipi di SISTEMA e su ogni copia per tenant (un tipo ITIL
 * personalizzato vince in lettura: senza, chi l'aveva personalizzato non
 * vedrebbe i campi nuovi). Idempotente: `MERGE` su tipo + nome + tenant, e il
 * legame col vocabolario solo se manca.
 *
 * ## Correzione del 5 ott 2026
 *
 * Non era idempotente: `scope` stava nella CHIAVE del MERGE, e quando un'altra
 * migrazione ha riscritto quei nodi il MERGE ne ha creati altri accanto — cinque
 * doppioni, visti dal vivo come «Priorità» due volte nelle tendine delle
 * automazioni. La chiave ora è tipo + nome + tenant; vedi il commento sul MERGE.
 */
import type { Migration } from '@opengraphity/neo4j'
import { v4 as uuidv4 } from 'uuid'

/** I campi da aggiungere, per tipo ITIL. Congelata: descrive il 20 set 2026. */
const CAMPI: ReadonlyArray<{ tipo: string; nome: string; label: string; vocabolario: string; ordine: number }> = [
  { tipo: 'incident', nome: 'impact',   label: 'Impatto',  vocabolario: 'impact',   ordine: 10 },
  { tipo: 'incident', nome: 'urgency',  label: 'Urgenza',  vocabolario: 'urgency',  ordine: 11 },
  { tipo: 'incident', nome: 'priority', label: 'Priorità', vocabolario: 'priority', ordine: 12 },
  { tipo: 'problem',  nome: 'impact',   label: 'Impatto',  vocabolario: 'impact',   ordine: 10 },
  { tipo: 'problem',  nome: 'urgency',  label: 'Urgenza',  vocabolario: 'urgency',  ordine: 11 },
]

export const itilPriorityImpactUrgency: Migration = {
  id:          '20260920_1720_itil_priority_impact_urgency',
  description: 'impact/urgency/priority nel metamodello ITIL di incident e problem (ondata 2)',

  async up(session) {
    let creati = 0
    let legati = 0
    for (const c of CAMPI) {
      // Ogni definizione di quel tipo: quella di sistema e le copie dei tenant.
      const tipi = await session.run(
        `MATCH (t:CITypeDefinition {scope: 'itil', name: $tipo})
         RETURN t.id AS id, t.tenant_id AS tenant`,
        { tipo: c.tipo },
      )
      for (const rec of tipi.records) {
        const tipoId = rec.get('id')     as string
        const tenant = rec.get('tenant') as string
        /*
         * LA CHIAVE DEL MERGE È tipo + nome + tenant, e NON `scope`.
         *
         * Con `scope: 'itil'` dentro la chiave questa migrazione si è
         * duplicata i propri campi (5 doppioni su c-test: incident.impact,
         * urgency, priority e problem.impact, urgency, visibili come «Priorità»
         * due volte nelle tendine delle automazioni). Il motivo: una migrazione
         * successiva ha riscritto quei nodi, il MERGE non li ha più riconosciuti
         * come suoi e ne ha creati altri accanto. Una proprietà che qualcun altro
         * può cambiare non può stare nella chiave di un MERGE — `scope` si scrive
         * solo alla creazione. I doppioni già in giro li toglie la migrazione
         * `20261005_1010_metamodel_duplicate_fields`.
         */
        const r = await session.run(
          `MATCH (t:CITypeDefinition {id: $tipoId})
           MERGE (t)-[:HAS_FIELD]->(f:CIFieldDefinition {name: $nome, tenant_id: $tenant})
           ON CREATE SET f.id = $id, f.label = $label, f.field_type = 'enum',
                         f.required = false, f.order = $ordine, f.scope = 'itil',
                         f.is_system = true, f.created_at = $now
           RETURN (f.created_at = $now) AS creato`,
          { tipoId, nome: c.nome, tenant, id: uuidv4(), label: c.label, ordine: c.ordine, now: new Date().toISOString() },
        )
        if (r.records[0]?.get('creato') === true) creati += 1

        /*
         * Il legame col vocabolario, con la stessa precedenza della lettura: la
         * copia del tenant vince su quella spedita. Legare il campo di un
         * tenant al vocabolario di sistema gli farebbe ignorare i valori che
         * quel cliente ha aggiunto — ed e esattamente il difetto che questo
         * programma chiude da otto ondate.
         */
        const l = await session.run(
          `MATCH (t:CITypeDefinition {id: $tipoId})-[:HAS_FIELD]->(f:CIFieldDefinition {name: $nome})
           WHERE NOT (f)-[:USES_ENUM]->(:EnumTypeDefinition)
           OPTIONAL MATCH (own:EnumTypeDefinition {name: $vocabolario, tenant_id: $tenant})
           OPTIONAL MATCH (sys:EnumTypeDefinition {name: $vocabolario, tenant_id: 'system'})
           WITH f, coalesce(own, sys) AS e
           WHERE e IS NOT NULL
           MERGE (f)-[:USES_ENUM]->(e)
           RETURN e.tenant_id AS vocTenant`,
          { tipoId, nome: c.nome, vocabolario: c.vocabolario, tenant },
        )
        if (l.records.length > 0) {
          legati += 1
          console.log(
            `[20260920_1720] ${tenant}/${c.tipo}.${c.nome} → vocabolario «${c.vocabolario}» ` +
            `di ${l.records[0]!.get('vocTenant') as string}`,
          )
        }
      }
    }
    console.log(`[20260920_1720] campi creati: ${creati}, legami al vocabolario: ${legati}`)
  },
}
