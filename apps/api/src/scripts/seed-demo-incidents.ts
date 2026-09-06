/**
 * Demo data: ricrea da zero gli incident SEGUENDO il workflow.
 *
 * Cancella tutti gli incident esistenti (workflow, storia, SLA, commenti: nessun
 * orfano) e ne crea 1500:
 *   - 1000 CHIUSI  → percorso completo new→assigned→in_progress→resolved→closed,
 *                    con una WorkflowStepExecution per ogni step (storia reale,
 *                    durate coerenti), assegnatario e SLA valutata.
 *   -  150 ASSEGNATI → new→assigned, assegnati a un utente, in attesa di presa
 *                    in carico.
 *   -  350 NUOVI   → ancora da assegnare (step "new").
 *
 * Lo stato prodotto è identico a quello del motore (CURRENT_STEP + storia +
 * status sincronizzato), quindi i pulsanti di transizione funzionano e il
 * motore live prosegue dallo stato seed. Il percorso viene VALIDATO contro le
 * transizioni definite nella WorkflowDefinition: se il workflow cambia, lo
 * script fallisce invece di fabbricare uno stato incoerente.
 *
 * Uso (da host): pnpm --filter @opengraphity/api exec tsx src/scripts/seed-demo-incidents.ts
 */
import { getSession } from '@opengraphity/neo4j'
import { v4 as uuidv4 } from 'uuid'

const TENANT = 'c-one'
const DEF_ID = '2f47bd00-4cb3-4ae6-bb25-932c324aa914' // incident workflow definition
const N_CLOSED = 1000
const N_ASSIGNED = 150
const N_NEW = 350
const BATCH = 250
const now = Date.now()
const DAY = 24 * 60 * 60 * 1000
const MIN = 60 * 1000

const pick = <T>(a: T[]): T => a[Math.floor(Math.random() * a.length)]!
const rand = (min: number, max: number) => min + Math.random() * (max - min)
const iso = (ms: number) => new Date(ms).toISOString()

// ── Testi realistici per tipo di CI ────────────────────────────────────────────
const SCENARIOS: Record<string, Array<{ t: string; d: string; rc: string }>> = {
  Server: [
    { t: 'Server {n} irraggiungibile',    d: 'Il server {n} non risponde ai ping né via SSH. Servizi ospitati non disponibili.', rc: 'Scheda di rete in fault, sostituita; ripristinata la connettività.' },
    { t: 'Utilizzo CPU al 100% su {n}',   d: 'Carico CPU costante al 100% su {n} da oltre 30 minuti, con degrado delle prestazioni.', rc: 'Processo runaway terminato; aggiunto limite cgroup.' },
    { t: 'Spazio disco esaurito su {n}',  d: 'Il filesystem /var su {n} ha superato il 95%. Rischio di blocco delle scritture.', rc: 'Ruotati e compressi i log; ampliato il volume.' },
    { t: 'Riavvio inatteso di {n}',       d: 'Il server {n} si è riavviato senza intervento pianificato. Da verificare la causa.', rc: 'Kernel panic da driver difettoso; kernel aggiornato.' },
    { t: 'Memoria esaurita (OOM) su {n}', d: "L'OOM killer ha terminato processi su {n} per esaurimento memoria.", rc: 'Memory leak applicativo corretto con patch.' },
    { t: 'Latenza elevata da {n}',        d: 'Tempi di risposta dei servizi su {n} degradati oltre le soglie attese.', rc: 'Saturazione I/O disco risolta spostando il carico su SSD.' },
  ],
  Database: [
    { t: 'Timeout connessioni su {n}',    d: 'Le applicazioni ricevono timeout aprendo connessioni verso il database {n}.', rc: 'Connection pool esaurito; aumentato max_connections.' },
    { t: 'Replica in ritardo su {n}',     d: 'Il lag di replica su {n} supera i limiti accettabili, dati non allineati.', rc: 'Transazione lunga interrotta; replica riallineata.' },
    { t: 'Deadlock ricorrenti su {n}',    d: 'Numerosi deadlock rilevati su {n} con rollback delle transazioni.', rc: 'Rivisto ordine di lock nella procedura batch.' },
    { t: 'Backup fallito per {n}',        d: 'Il backup notturno del database {n} è fallito. Nessuna copia valida disponibile.', rc: 'Spazio su destinazione backup esaurito; ampliato e ripianificato.' },
    { t: 'Tablespace esaurito su {n}',    d: 'Lo spazio del tablespace su {n} è esaurito, le scritture vengono rifiutate.', rc: 'Aggiunto datafile; abilitato autoextend.' },
    { t: 'Query lente degradano {n}',     d: 'Query non ottimizzate stanno degradando le prestazioni del database {n}.', rc: 'Creato indice mancante; aggiornate le statistiche.' },
  ],
  Application: [
    { t: 'Errori HTTP 500 su {n}',        d: 'Gli utenti riscontrano errori 500 diffusi utilizzando {n}.', rc: 'Eccezione non gestita corretta con hotfix.' },
    { t: '{n} non risponde',              d: 'Gli health check di {n} falliscono, il servizio risulta non disponibile.', rc: 'Servizio bloccato su lock; riavviato e aggiunto watchdog.' },
    { t: 'Login non funzionante su {n}',  d: 'Impossibile autenticarsi su {n}: gli utenti restano bloccati alla pagina di login.', rc: 'Certificato del provider SSO rinnovato.' },
    { t: 'Certificato TLS scaduto per {n}', d: 'Il certificato TLS di {n} è scaduto, i browser mostrano avvisi di sicurezza.', rc: 'Certificato rinnovato e automatizzato il rinnovo.' },
    { t: 'Tempi di risposta degradati su {n}', d: 'Le pagine di {n} rispondono con forte lentezza rispetto alla baseline.', rc: 'Cache ripristinata; ottimizzata chiamata a valle.' },
    { t: 'Errori di integrazione API su {n}', d: 'Le chiamate API in uscita da {n} falliscono con errori intermittenti.', rc: 'Timeout e retry configurati sul client HTTP.' },
  ],
}
const CATEGORY: Record<string, string> = { Server: 'infrastructure', Database: 'database', Application: 'application' }

// ── Matrice ITIL Impatto × Urgenza → severità (priorità) ───────────────────────
type IU = 'high' | 'medium' | 'low'
function derive(impact: IU, urgency: IU): 'critical' | 'high' | 'medium' | 'low' {
  if (impact === 'high' && urgency === 'high') return 'critical'
  if ((impact === 'high' && urgency === 'medium') || (impact === 'medium' && urgency === 'high')) return 'high'
  if ((impact === 'high' && urgency === 'low') || (impact === 'medium' && urgency === 'medium') || (impact === 'low' && urgency === 'high')) return 'medium'
  return 'low'
}
// Default incident SLA tiers (minuti) — allineati a DEFAULT_SLA_POLICIES
const TIER: Record<string, { resp: number; res: number }> = {
  critical: { resp: 15, res: 240 }, high: { resp: 60, res: 480 },
  medium: { resp: 240, res: 1440 }, low: { resp: 480, res: 4320 },
}
const IUS: IU[] = ['high', 'medium', 'low']

interface Exec { step: string; entered: string; exited: string | null; duration: number | null; trigger: string; notes: string | null }
interface Row {
  id: string; wiId: string; slaId: string; number: string
  title: string; description: string; rootCause: string | null
  severity: string; impact: string; urgency: string; status: string; category: string
  createdAt: string; updatedAt: string; resolvedAt: string | null; assignedAt: string | null
  ciId: string; teamId: string; assigneeId: string | null
  currentStep: string; wiStatus: string
  responseDeadline: string; resolveDeadline: string
  responseMet: boolean; resolveMet: boolean; breached: boolean
  tierResp: number; tierRes: number
  execs: Exec[]
}

function baseRow(i: number, ci: { id: string; name: string; type: string; teamId: string }): Row {
  const sc = pick(SCENARIOS[ci.type]!)
  const impact = pick(IUS), urgency = pick(IUS)
  const severity = derive(impact, urgency)
  const tier = TIER[severity]!
  return {
    id: uuidv4(), wiId: uuidv4(), slaId: uuidv4(),
    number: '', // assegnato dopo, sequenziale
    title: sc.t.replace('{n}', ci.name), description: sc.d.replace('{n}', ci.name), rootCause: sc.rc,
    severity, impact, urgency, status: 'new', category: CATEGORY[ci.type]!,
    createdAt: '', updatedAt: '', resolvedAt: null, assignedAt: null,
    ciId: ci.id, teamId: ci.teamId, assigneeId: null,
    currentStep: 'new', wiStatus: 'active',
    responseDeadline: '', resolveDeadline: '',
    responseMet: false, resolveMet: false, breached: false,
    tierResp: tier.resp, tierRes: tier.res,
    execs: [],
  }
}

async function main() {
  const session = getSession(undefined, 'WRITE')
  try {
    // ── 1. Valida il percorso contro il workflow reale ──────────────────────────
    const pathEdges = [['new', 'assigned'], ['assigned', 'in_progress'], ['in_progress', 'resolved'], ['resolved', 'closed']]
    const edgeRes = await session.executeRead((tx) => tx.run(`
      MATCH (s:WorkflowStep {definition_id:$d})-[:TRANSITIONS_TO]->(n:WorkflowStep {definition_id:$d})
      RETURN s.name AS from, n.name AS to
    `, { d: DEF_ID }))
    const edges = new Set(edgeRes.records.map((r) => `${r.get('from')}->${r.get('to')}`))
    for (const [a, b] of pathEdges) {
      if (!edges.has(`${a}->${b}`)) throw new Error(`Workflow non conforme: manca la transizione ${a}->${b}. Aggiorna lo script al workflow corrente.`)
    }
    console.log('[seed] percorso workflow validato:', pathEdges.map(([a, b]) => `${a}→${b}`).join(' '))

    // ── 2. Cancella gli incident esistenti senza lasciare orfani ────────────────
    const del = await session.executeWrite((tx) => tx.run(`
      MATCH (i:Incident {tenant_id:$t})
      OPTIONAL MATCH (i)-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
      OPTIONAL MATCH (wi)-[:STEP_HISTORY]->(ex:WorkflowStepExecution)
      OPTIONAL MATCH (i)-[:HAS_SLA]->(sla:SLAStatus)
      OPTIONAL MATCH (i)-[:HAS_COMMENT]->(cm:Comment)
      DETACH DELETE ex, wi, sla, cm, i
      RETURN count(DISTINCT i) AS n
    `, { t: TENANT }))
    console.log(`[seed] cancellati ${del.records[0]!.get('n')} incident (con workflow/SLA/commenti)`)
    // Bonifica eventuali SLAStatus incident orfane rimaste da run precedenti
    const orphan = await session.executeWrite((tx) => tx.run(`
      MATCH (s:SLAStatus {tenant_id:$t, entity_type:'incident'})
      WHERE NOT (s)<-[:HAS_SLA]-()
      DETACH DELETE s RETURN count(s) AS n
    `, { t: TENANT }))
    console.log(`[seed] bonificate ${orphan.records[0]!.get('n')} SLAStatus orfane`)

    // ── 3. Carica CI (con support team) e utenti operativi ──────────────────────
    const ciRes = await session.executeRead((tx) => tx.run(`
      MATCH (ci {tenant_id:$t})-[:SUPPORTED_BY]->(team:Team)
      WHERE labels(ci)[0] IN ['Server','Database','Application']
      RETURN ci.id AS id, ci.name AS name, labels(ci)[0] AS type, team.id AS teamId
    `, { t: TENANT }))
    const cis = ciRes.records.map((r) => ({ id: r.get('id') as string, name: r.get('name') as string, type: r.get('type') as string, teamId: r.get('teamId') as string }))
    if (cis.length === 0) throw new Error('Nessun CI con support team trovato')

    const userRes = await session.executeRead((tx) => tx.run(`
      MATCH (u:User {tenant_id:$t}) WHERE u.role = 'operator' RETURN u.id AS id
    `, { t: TENANT }))
    const users = userRes.records.map((r) => r.get('id') as string)
    if (users.length === 0) throw new Error('Nessun utente operator trovato per assegnazione')
    console.log(`[seed] ${cis.length} CI, ${users.length} operator disponibili`)

    // ── 4. Costruisci le righe ──────────────────────────────────────────────────
    const rows: Row[] = []

    // CHIUSI: percorso completo, retrodatati sull'ultimo anno
    for (let k = 0; k < N_CLOSED; k++) {
      const r = baseRow(k, pick(cis))
      const tier = TIER[r.severity]!
      // creato tra 1 anno fa e 2h fa, con abbastanza margine per l'intero ciclo
      const createdMs = now - rand(2 * 60 * MIN, 365 * DAY)
      // durata di risoluzione realistica (a volte oltre target), con clamp a now
      let resolveDur = tier.res * MIN * rand(0.2, 1.6)
      const closeDelay = Math.min(72 * 60 * MIN, Math.max(30 * MIN, rand(6, 72) * 60 * MIN))
      if (createdMs + resolveDur + closeDelay > now - MIN) resolveDur = Math.max(30 * MIN, (now - MIN - closeDelay - createdMs) * rand(0.5, 0.95))
      const assignedMs   = createdMs + resolveDur * rand(0.02, 0.10)
      const inProgressMs = assignedMs + resolveDur * rand(0.03, 0.15)
      const resolvedMs   = createdMs + resolveDur
      const closedMs     = Math.min(now - MIN, resolvedMs + closeDelay)
      r.createdAt = iso(createdMs)
      r.assignedAt = iso(assignedMs)
      r.resolvedAt = iso(resolvedMs)
      r.updatedAt = iso(closedMs)
      r.status = 'closed'; r.currentStep = 'closed'; r.wiStatus = 'completed'
      r.assigneeId = pick(users)
      r.responseDeadline = iso(createdMs + tier.resp * MIN)
      r.resolveDeadline  = iso(createdMs + tier.res * MIN)
      r.responseMet = assignedMs <= createdMs + tier.resp * MIN
      r.resolveMet  = resolvedMs <= createdMs + tier.res * MIN
      r.breached    = !r.resolveMet
      r.execs = [
        { step: 'new',         entered: iso(createdMs),    exited: iso(assignedMs),   duration: Math.round(assignedMs - createdMs),     trigger: 'automatic', notes: null },
        { step: 'assigned',    entered: iso(assignedMs),   exited: iso(inProgressMs), duration: Math.round(inProgressMs - assignedMs),  trigger: 'manual',    notes: 'Assegnato al team di supporto' },
        { step: 'in_progress', entered: iso(inProgressMs), exited: iso(resolvedMs),   duration: Math.round(resolvedMs - inProgressMs),  trigger: 'manual',    notes: 'Presa in carico' },
        { step: 'resolved',    entered: iso(resolvedMs),   exited: iso(closedMs),     duration: Math.round(closedMs - resolvedMs),      trigger: 'manual',    notes: r.rootCause },
        { step: 'closed',      entered: iso(closedMs),     exited: null,              duration: null,                                   trigger: 'timer',     notes: 'Chiusura automatica' },
      ]
      rows.push(r)
    }

    // ASSEGNATI: new→assigned, assegnati a un utente, ultimi 90 giorni
    for (let k = 0; k < N_ASSIGNED; k++) {
      const r = baseRow(k, pick(cis))
      const tier = TIER[r.severity]!
      const createdMs = now - rand(10 * MIN, 90 * DAY)
      const assignedMs = Math.min(now - MIN, createdMs + rand(2, 240) * MIN)
      r.createdAt = iso(createdMs)
      r.assignedAt = iso(assignedMs)
      r.updatedAt = iso(assignedMs)
      r.status = 'assigned'; r.currentStep = 'assigned'; r.wiStatus = 'active'
      r.assigneeId = pick(users)
      r.responseDeadline = iso(createdMs + tier.resp * MIN)
      r.resolveDeadline  = iso(createdMs + tier.res * MIN)
      r.responseMet = assignedMs <= createdMs + tier.resp * MIN
      r.resolveMet  = false
      r.breached    = now > createdMs + tier.res * MIN
      r.execs = [
        { step: 'new',      entered: iso(createdMs),  exited: iso(assignedMs), duration: Math.round(assignedMs - createdMs), trigger: 'automatic', notes: null },
        { step: 'assigned', entered: iso(assignedMs), exited: null,            duration: null,                              trigger: 'manual',    notes: 'Assegnato al team di supporto' },
      ]
      rows.push(r)
    }

    // NUOVI: ancora da assegnare, ultimi 30 giorni
    for (let k = 0; k < N_NEW; k++) {
      const r = baseRow(k, pick(cis))
      const tier = TIER[r.severity]!
      const createdMs = now - rand(1 * MIN, 30 * DAY)
      r.createdAt = iso(createdMs)
      r.updatedAt = iso(createdMs)
      r.status = 'new'; r.currentStep = 'new'; r.wiStatus = 'active'
      r.responseDeadline = iso(createdMs + tier.resp * MIN)
      r.resolveDeadline  = iso(createdMs + tier.res * MIN)
      r.responseMet = false
      r.resolveMet  = false
      r.breached    = now > createdMs + tier.res * MIN
      r.execs = [
        { step: 'new', entered: iso(createdMs), exited: null, duration: null, trigger: 'automatic', notes: null },
      ]
      rows.push(r)
    }

    // Mescola e numera in ordine cronologico di creazione (INC più bassi = più vecchi)
    rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    rows.forEach((r, i) => { r.number = 'INC' + String(i + 1).padStart(8, '0') })

    // ── 5. Inserimento a batch ──────────────────────────────────────────────────
    for (let off = 0; off < rows.length; off += BATCH) {
      const chunk = rows.slice(off, off + BATCH)
      await session.executeWrite((tx) => tx.run(`
        UNWIND $rows AS r
        MATCH (ci {id: r.ciId, tenant_id: $t})
        MATCH (team:Team {id: r.teamId})
        CREATE (i:Incident {
          id: r.id, tenant_id: $t, number: r.number, title: r.title, description: r.description,
          severity: r.severity, impact: r.impact, urgency: r.urgency, status: r.status,
          category: r.category, created_at: r.createdAt, updated_at: r.updatedAt,
          resolved_at: r.resolvedAt, assigned_at: r.assignedAt, root_cause: r.rootCause
        })
        CREATE (i)-[:AFFECTED_BY]->(ci)
        CREATE (i)-[:ASSIGNED_TO_TEAM]->(team)
        CREATE (i)-[:HAS_WORKFLOW]->(wi:WorkflowInstance {
          id: r.wiId, tenant_id: $t, definition_id: $defId, entity_type: 'incident',
          entity_id: r.id, current_step: r.currentStep, status: r.wiStatus,
          created_at: r.createdAt, updated_at: r.updatedAt
        })
        WITH i, r, wi
        MATCH (cs:WorkflowStep {definition_id: $defId, name: r.currentStep})
        CREATE (wi)-[:CURRENT_STEP]->(cs)
        WITH i, r, wi
        OPTIONAL MATCH (u:User {id: r.assigneeId, tenant_id: $t})
        FOREACH (_ IN CASE WHEN u IS NULL THEN [] ELSE [1] END | CREATE (i)-[:ASSIGNED_TO]->(u))
        CREATE (i)-[:HAS_SLA]->(s:SLAStatus {
          id: r.slaId, tenant_id: $t, entity_id: r.id, entity_type: 'incident',
          started_at: r.createdAt, response_deadline: r.responseDeadline, resolve_deadline: r.resolveDeadline,
          response_met: r.responseMet, resolve_met: r.resolveMet, breached: r.breached,
          tier_severity: r.severity, tier_response_minutes: r.tierResp, tier_resolve_minutes: r.tierRes,
          tier_business_hours: false
        })
        WITH r, wi
        UNWIND r.execs AS ex
        CREATE (wi)-[:STEP_HISTORY]->(:WorkflowStepExecution {
          id: randomUUID(), tenant_id: $t, instance_id: r.wiId, step_name: ex.step,
          entered_at: ex.entered, exited_at: ex.exited, duration_ms: ex.duration,
          triggered_by: 'system', trigger_type: ex.trigger, notes: ex.notes
        })
      `, { rows: chunk, t: TENANT, defId: DEF_ID }))
      console.log(`[seed] inseriti ${Math.min(off + BATCH, rows.length)}/${rows.length}`)
    }

    console.log(`[seed] FATTO — ${rows.length} incident: ${N_CLOSED} closed, ${N_ASSIGNED} assigned, ${N_NEW} new`)
  } finally {
    await session.close()
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
