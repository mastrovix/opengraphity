/**
 * Revisione totale del 16 set 2026 · C-35: `WorkflowStep.deadline_calendar_id`
 * è la proprietà su cui il prodotto decide se un calendario di servizio è
 * ancora usato, ma la scriveva SOLO il disegnatore. Una scadenza arrivata da
 * un seed o da una migrazione lasciava la proprietà vuota: il calendario si
 * poteva cancellare, e la passata delle scadenze poi falliva ogni ora perché
 * il calendario citato dalla scadenza non esisteva più.
 *
 * Qui la proprietà si ricostruisce dal JSON della scadenza, che è la sorgente.
 * Idempotente: tocca solo i passi dove le due cose non combaciano.
 */
import type { Migration } from '@opengraphity/neo4j'

export const stepDeadlineCalendar: Migration = {
  id:          '20261002_1030_step_deadline_calendar',
  description: 'deadline_calendar_id ricostruito dal JSON della scadenza dei passi (C-35)',

  async up(session) {
    const rows = await session.run(`
      MATCH (wd:WorkflowDefinition)-[:HAS_STEP]->(s:WorkflowStep)
      WHERE s.deadline IS NOT NULL
      RETURN s.id AS id, wd.id AS definitionId, wd.tenant_id AS tenantId,
             s.name AS step, s.deadline AS deadline, s.deadline_calendar_id AS current`)
    let fixed = 0
    for (const r of rows.records) {
      const raw = r.get('deadline') as string
      let calendarId: string | null
      try {
        const parsed = JSON.parse(raw) as { calendar_id?: string | null }
        calendarId = parsed.calendar_id ?? null
      } catch {
        console.log(`[${stepDeadlineCalendar.id}] ${String(r.get('tenantId'))}/${String(r.get('step'))}: scadenza illeggibile, lasciata com'è`)
        continue
      }
      const current = (r.get('current') ?? null) as string | null
      if (current === calendarId) continue
      await session.run(`
        // Gli id dei passi non sono garantiti unici fra definizioni: si passa dalla definizione.
        MATCH (:WorkflowDefinition {id: $definitionId, tenant_id: $tenantId})-[:HAS_STEP]->(s:WorkflowStep {id: $id})
        SET s.deadline_calendar_id = $calendarId`,
        { id: r.get('id'), definitionId: r.get('definitionId'), tenantId: r.get('tenantId'), calendarId })
      fixed += 1
      console.log(`[${stepDeadlineCalendar.id}] ${String(r.get('tenantId'))}/${String(r.get('step'))}: calendario ${String(calendarId)}`)
    }
    console.log(`[${stepDeadlineCalendar.id}] passi allineati: ${String(fixed)} su ${String(rows.records.length)}`)
  },
}
