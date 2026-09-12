/**
 * **Bersagli** di transizione risolti dal dato, non dal nome (ondata 4 · A4-2).
 *
 * Il nucleo (`lib/workflowHelpers.ts`) risponde «quali passi hanno questo
 * scopo / questa categoria». Qui sopra c'è l'ultimo passaggio che serve alle
 * transizioni automatiche: «a QUALE passo devo portare questa istanza».
 *
 * La regola di lettura è quella del nucleo, e vale anche per i bersagli:
 * - **scopo** dove il ruolo nel processo è ciò che conta (`scheduled`,
 *   `assessment`, `investigation`, `change_requested`, `change_in_progress`);
 * - **categoria** dove il ruolo è lo stato visibile da fuori (`resolved`,
 *   `closed`): un passo «Risolto» è riconoscibile dalla sua categoria, e
 *   inventare uno scopo `resolved` duplicherebbe un'informazione che c'è già.
 *
 * Due scelte deliberate:
 * - **fail-loud**: se nessun passo del tenant ha lo scopo (o la categoria) del
 *   bersaglio, si ferma con un messaggio che nomina ciò che manca e la strada
 *   per rimediare. Prima il sintomo era un CONFLICT incomprensibile
 *   («Approvazioni complete ma la change non è avanzata a "scheduled"») con la
 *   change che non si approvava né si rifiutava più.
 * - **determinismo**: più passi con lo stesso scopo sono legittimi (due
 *   finestre di rilascio, due livelli di approvazione). Come bersaglio di una
 *   transizione automatica se ne può scegliere uno solo: si prende quello con
 *   lo `step_order` più basso, e a parità il nome in ordine alfabetico. Chi
 *   può scegliere meglio (esiste una transizione disponibile verso uno di
 *   essi) usa `preferAvailable`.
 *
 * Gli scopi sono tipati `WorkflowStepPurpose`: uno scopo inventato non
 * compila, quindi non può finire in produzione come stringa muta.
 */
import type { Session } from 'neo4j-driver'
import type { WorkflowStepPurpose } from '@opengraphity/types'
import { getWorkflowSteps, requireStepNamesByPurpose, type StepRow } from './workflowHelpers.js'

/** Ordine deterministico: `step_order` crescente (assenti in fondo), poi il nome. */
function byOrder(a: StepRow, b: StepRow): number {
  const ao = a.stepOrder ?? Number.MAX_SAFE_INTEGER
  const bo = b.stepOrder ?? Number.MAX_SAFE_INTEGER
  return ao !== bo ? ao - bo : a.name.localeCompare(b.name)
}

/** I nomi dei passi con una di queste CATEGORIE, in ordine deterministico. */
export async function stepNamesByCategory(
  session: Session, tenantId: string, entityType: string, categories: readonly string[],
): Promise<string[]> {
  const wanted = new Set(categories)
  const steps = await getWorkflowSteps(session, tenantId, entityType)
  return [...new Set(steps.filter((s) => s.category != null && wanted.has(s.category)).sort(byOrder).map((s) => s.name))]
}

/** I nomi dei passi con uno di questi SCOPI, in ordine deterministico (vuoto se nessuno). */
export async function stepNamesByPurposeOrdered(
  session: Session, tenantId: string, entityType: string, purposes: readonly WorkflowStepPurpose[],
): Promise<string[]> {
  const wanted = new Set<string>(purposes)
  const steps = await getWorkflowSteps(session, tenantId, entityType)
  return [...new Set(steps.filter((s) => s.purpose != null && wanted.has(s.purpose)).sort(byOrder).map((s) => s.name))]
}

/** Fra i candidati, il primo raggiungibile dalle transizioni disponibili; altrimenti il primo. */
function pick(candidates: readonly string[], preferAvailable?: readonly string[]): string {
  if (preferAvailable) {
    const reachable = candidates.find((n) => preferAvailable.includes(n))
    if (reachable) return reachable
  }
  return candidates[0]!
}

/**
 * Il passo a cui portare l'istanza, scelto per SCOPO. Fail-loud (il messaggio
 * del nucleo, `requireStepNamesByPurpose`) se nessun passo lo dichiara.
 * `preferAvailable`: i `toStep` delle transizioni disponibili, quando il
 * chiamante li ha già in mano.
 */
export async function targetStepByPurpose(
  session: Session, tenantId: string, entityType: string, purposes: readonly WorkflowStepPurpose[], what: string,
  preferAvailable?: readonly string[],
): Promise<string> {
  // Il fail-loud (e il messaggio) sono del nucleo; l'ordine lo mette qui.
  await requireStepNamesByPurpose(session, tenantId, entityType, purposes, what)
  return pick(await stepNamesByPurposeOrdered(session, tenantId, entityType, purposes), preferAvailable)
}

/**
 * Il passo a cui portare l'istanza, scelto per CATEGORIA (lo stato visibile:
 * `resolved`, `closed`). Fail-loud se il workflow del tenant non ha nessun
 * passo di quelle categorie.
 */
export async function targetStepByCategory(
  session: Session, tenantId: string, entityType: string, categories: readonly string[], what: string,
  preferAvailable?: readonly string[],
): Promise<string> {
  const names = await stepNamesByCategory(session, tenantId, entityType, categories)
  if (names.length === 0) {
    throw new Error(
      `${what}: nel workflow "${entityType}" del tenant ${tenantId} nessun passo ha la categoria ` +
      `[${categories.join(', ')}]. Assegna la categoria ai passi nel disegnatore: senza, questa regola non ` +
      `sa dove portare il ticket.`,
    )
  }
  return pick(names, preferAvailable)
}
