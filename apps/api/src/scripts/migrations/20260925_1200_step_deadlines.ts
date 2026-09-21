/**
 * Verifica «Cosa resta cablato», ondata 3: la chiusura automatica diventa la
 * SCADENZA del passo.
 *
 * Prima: sul passo «resolved» degli incident un'azione di ingresso
 * `schedule_job(auto_close, delay_hours)` e una di uscita `cancel_job(auto_close)`;
 * il job sapeva chiudere solo un incident. Ora: `WorkflowStep.deadline` con la
 * stessa durata, 24×7, verso il passo di categoria «closed» raggiungibile con un
 * arco da quel passo (ordinato per `step_order`, poi per nome, come sceglieva il
 * job); le due azioni si tolgono.
 *
 * Stato di fatto conservato: stessa durata, stesso tempo continuo, stesso
 * arrivo. Il job lanciava se non trovava un passo di chiusura, e il motore
 * rifiuta una transizione senza arco: un passo senza arco verso un «closed» non
 * si chiudeva nemmeno prima, quindi riceve niente e lo si dice nel log.
 *
 * `schedule_job` e `cancel_job` escono dal vocabolario del motore. Nessun job
 * diverso da `auto_close` esisteva nel lavoratore (ogni altro nome falliva con
 * «unknown job»): un'azione così, se c'è, si toglie e si nomina nel log.
 *
 * La migrazione 20260912_1210 legge il vocabolario del motore e rifiuta i tipi
 * che non conosce. Tutte le installazioni l'hanno già applicata prima di
 * questa, e un'installazione nuova nasce dal seed che non ha più queste azioni.
 *
 * Idempotente: dopo il primo giro non restano azioni `schedule_job`/`cancel_job`.
 */
import type { Migration } from '@opengraphity/neo4j'
import type { StepDeadline } from '@opengraphity/types'

const tag = '[20260925_1200_step_deadlines]'
const RETIRED = new Set(['schedule_job', 'cancel_job'])

interface Action { type?: string; params?: Record<string, unknown> }

function parseActions(raw: unknown, where: string): Action[] {
  if (raw == null || raw === '') return []
  const parsed: unknown = JSON.parse(String(raw))
  if (!Array.isArray(parsed)) throw new Error(`${tag} ${where}: the actions are not a list`)
  return parsed as Action[]
}

/** Le ore dell'auto-chiusura, o `null` se il passo non ne ha una. */
export function autoCloseHours(enter: Action[]): number | null {
  const job = enter.find((a) => a.type === 'schedule_job' && a.params?.['job'] === 'auto_close')
  if (!job) return null
  const hours = parseInt(String(job.params?.['delay_hours'] ?? '0'), 10)
  return Number.isFinite(hours) && hours > 0 ? hours : null
}

export const stepDeadlines: Migration = {
  id: '20260925_1200_step_deadlines',
  description: 'La chiusura automatica (schedule_job auto_close) diventa la scadenza del passo; schedule_job e cancel_job escono dal vocabolario',
  async up(session) {
    const steps = await session.run(`
      MATCH (wd:WorkflowDefinition)-[:HAS_STEP]->(s:WorkflowStep)
      WHERE s.enter_actions CONTAINS 'schedule_job' OR s.enter_actions CONTAINS 'cancel_job'
         OR s.exit_actions  CONTAINS 'schedule_job' OR s.exit_actions  CONTAINS 'cancel_job'
      OPTIONAL MATCH (s)-[:TRANSITIONS_TO]->(to:WorkflowStep {category: 'closed'})
      WITH wd, s, to ORDER BY coalesce(to.step_order, 999), to.name
      RETURN s.id AS id, wd.id AS definitionId, wd.tenant_id AS tenantId, wd.name AS definition, s.name AS step,
             s.enter_actions AS enter, s.exit_actions AS exit, s.deadline AS deadline,
             collect(to.name)[0] AS closedStep
    `)
    for (const r of steps.records) {
      const where = `${String(r.get('tenantId'))}/${String(r.get('definition'))}/${String(r.get('step'))}`
      const enter = parseActions(r.get('enter'), where)
      const exit  = parseActions(r.get('exit'), where)
      const hours = autoCloseHours(enter)
      const other = [...enter, ...exit].filter((a) => RETIRED.has(String(a.type)) && a.params?.['job'] !== 'auto_close')
      if (other.length > 0) {
        console.log(`${tag} ${where}: tolte ${String(other.length)} azioni ${other.map((a) => `${String(a.type)}(${String(a.params?.['job'] ?? '')})`).join(', ')} — nessun lavoratore le eseguiva`)
      }

      const closedStep = r.get('closedStep') as string | null
      let deadline: string | null = (r.get('deadline') ?? null) as string | null
      if (hours != null && deadline == null) {
        if (closedStep) {
          deadline = JSON.stringify({ after: hours, unit: 'hours', calendar_id: null, to_step: closedStep, set_fields: [] } satisfies StepDeadline)
          console.log(`${tag} ${where}: scadenza ${String(hours)} ore → «${closedStep}»`)
        } else {
          console.log(`${tag} ${where}: auto_close di ${String(hours)} ore senza un arco verso un passo «closed» — non si chiudeva nemmeno prima, nessuna scadenza`)
        }
      }

      const keep = (list: Action[]) => list.filter((a) => !RETIRED.has(String(a.type)))
      await session.run(`
        // Gli id dei passi non sono garantiti unici fra definizioni: si passa dalla definizione.
        MATCH (:WorkflowDefinition {id: $definitionId, tenant_id: $tenantId})-[:HAS_STEP]->(s:WorkflowStep {id: $id})
        SET s.enter_actions = $enter, s.exit_actions = $exit, s.deadline = $deadline
      `, {
        id: r.get('id'), definitionId: r.get('definitionId'), tenantId: r.get('tenantId'),
        enter: JSON.stringify(keep(enter)), exit: JSON.stringify(keep(exit)), deadline,
      })
    }
  },
}
