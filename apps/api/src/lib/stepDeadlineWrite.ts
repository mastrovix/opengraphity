/**
 * LE SCADENZE DEI PASSI IN SCRITTURA (verifica «Cosa resta cablato», ondata 3).
 * Il motore delle scadenze è in `stepDeadlines.ts`; qui solo quello che serve a
 * chi salva un workflow, senza caricare il motore.
 */
import type { ManagedTransaction, Session } from 'neo4j-driver'
import {
  DEADLINE_PROTECTED_SOURCE_PURPOSES, DEADLINE_PROTECTED_TARGET_PURPOSES,
  StepDeadlineError, parseStepDeadline, type StepDeadline,
} from '@opengraphity/types'
import { ValidationError } from './errors.js'
import { assertStepFieldValue, stepFieldMetas } from './stepFieldWrites.js'

/** Un errore di forma, con la chiave del problema. */
function deadlineShapeError(e: StepDeadlineError, where: string): ValidationError {
  return new ValidationError(`${where}: ${e.message}`, { key: `errors.stepDeadline.${e.problem}`, params: { where, ...e.params } })
}

/**
 * Il campo `deadline` di un passo in scrittura, con la convenzione dello scopo:
 * `undefined`/`null` = non mandato (resta com'è), `''` = tolta, altrimenti una
 * scadenza valida nella forma, riscritta normalizzata.
 */
export function normalizeStepDeadlineInput(raw: string | null | undefined, where: string): { given: boolean; deadline: StepDeadline | null } {
  if (raw == null) return { given: false, deadline: null }
  if (raw.trim() === '') return { given: true, deadline: null }
  try {
    return { given: true, deadline: parseStepDeadline(raw) }
  } catch (e) {
    if (e instanceof StepDeadlineError) throw deadlineShapeError(e, where)
    throw e
  }
}

/** Campi e valori della scadenza contro il metamodello del cliente. Lancia come la scrittura di un passo. */
export async function assertDeadlineFields(session: Session, tenantId: string, entityType: string, deadline: StepDeadline, where: string): Promise<void> {
  if (deadline.set_fields.length === 0) return
  const metas = await stepFieldMetas(session, tenantId, entityType)
  for (const f of deadline.set_fields) {
    assertStepFieldValue(metas, entityType, f.field, f.value, where, { allowTemplate: false })
  }
}

interface DefinitionStepRow { name: string; label: string; purpose: string | null; deadline: string | null }

/**
 * Le scadenze della definizione, controllate contro il resto del workflow.
 * Dentro la transazione di chi scrive: chiamata DOPO la modifica, lancia se la
 * modifica rompe una scadenza, e la transazione non si chiude.
 */
export async function assertDefinitionDeadlines(tx: ManagedTransaction, tenantId: string, definitionId: string): Promise<void> {
  const res = await tx.run(`
    MATCH (wd:WorkflowDefinition {id: $definitionId, tenant_id: $tenantId})-[:HAS_STEP]->(s:WorkflowStep)
    OPTIONAL MATCH (s)-[:TRANSITIONS_TO]->(to:WorkflowStep)
    RETURN wd.entity_type AS entityType, wd.name AS definitionName,
           s.name AS name, coalesce(s.label, s.name) AS label, s.purpose AS purpose, s.deadline AS deadline,
           collect(DISTINCT to.name) AS targets
  `, { definitionId, tenantId })
  if (res.records.length === 0) return
  const entityType = res.records[0]!.get('entityType') as string
  const steps = new Map<string, DefinitionStepRow & { targets: string[] }>()
  for (const r of res.records) {
    steps.set(r.get('name') as string, {
      name: r.get('name') as string, label: r.get('label') as string,
      purpose: (r.get('purpose') ?? null) as string | null, deadline: (r.get('deadline') ?? null) as string | null,
      targets: (r.get('targets') as (string | null)[]).filter((t): t is string => t != null),
    })
  }

  for (const step of steps.values()) {
    if (!step.deadline) continue
    const where = `deadline of step "${step.label}"`
    let deadline: StepDeadline | null
    try { deadline = parseStepDeadline(step.deadline) } catch (e) {
      if (e instanceof StepDeadlineError) throw deadlineShapeError(e, where)
      throw e
    }
    if (!deadline) continue
    const target = steps.get(deadline.to_step)

    if (deadline.to_step === step.name) {
      throw new ValidationError(`${where}: the ticket is already in "${step.label}"; choose another step to move it to.`,
        { key: 'errors.stepDeadline.sameStep', params: { step: step.label } })
    }
    if (!target || !step.targets.includes(deadline.to_step)) {
      throw new ValidationError(
        `${where}: there is no arc from "${step.label}" to "${target?.label ?? deadline.to_step}". A deadline follows one of the arcs `
        + 'that leave the step: draw the arc first, or keep it — a deadline that uses it cannot lose it.',
        { key: 'errors.stepDeadline.noArc', params: { step: step.label, target: target?.label ?? deadline.to_step } },
      )
    }
    if (entityType === 'change') {
      if (target.purpose && (DEADLINE_PROTECTED_TARGET_PURPOSES as readonly string[]).includes(target.purpose)) {
        throw new ValidationError(
          `${where}: "${target.label}" is protected by the approvals (purpose «${target.purpose}»). A deadline has no person behind it, `
          + 'so it cannot bring a change there: move it with the approval flow.',
          { key: 'errors.stepDeadline.protectedTarget', params: { step: step.label, target: target.label, purpose: target.purpose } },
        )
      }
      if (step.purpose && (DEADLINE_PROTECTED_SOURCE_PURPOSES as readonly string[]).includes(step.purpose)) {
        throw new ValidationError(
          `${where}: "${step.label}" is where the change is approved, and leaving it needs the approvals: a deadline cannot do it.`,
          { key: 'errors.stepDeadline.protectedSource', params: { step: step.label, purpose: step.purpose } },
        )
      }
    }
    if (deadline.calendar_id) {
      const cal = await tx.run('MATCH (c:ServiceCalendar {id: $id, tenant_id: $tenantId}) RETURN c.name AS name', { id: deadline.calendar_id, tenantId })
      if (cal.records.length === 0) {
        throw new ValidationError(`${where}: the service calendar it counts with no longer exists. Choose a calendar, or 24×7.`,
          { key: 'errors.stepDeadline.calendarMissing', params: { step: step.label } })
      }
    }
  }
}

