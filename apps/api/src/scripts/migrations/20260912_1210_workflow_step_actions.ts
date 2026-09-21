/**
 * Personalizzazioni, ondata 0 (B0-5 / B-17) — azioni dei passi che il motore
 * dei workflow non conosce.
 *
 * Dal vivo: il passo `security_review` di «Incident — Security» (c-one) ha
 * `enter_actions = [{"type":"create_notification","params":{"channel":"in_app",
 * "message":"Incident in security review"}}]`. `create_notification` è il
 * vocabolario delle AUTOMAZIONI (lib/actionExecutor.ts), non quello del motore
 * dei workflow: il seed di quel passo scrive
 * `[{"type":"publish_event","params":{"event":"incident.security_review"}}]`,
 * quindi è deriva del dato, non un errore del seed. Da questa ondata il motore
 * FERMA la transizione davanti a un'azione che non conosce (prima la
 * transizione passava e l'azione non avveniva in silenzio), perciò il dato va
 * riallineato prima che il primo ingresso in quel passo si blocchi.
 *
 * Cosa fa: per ogni WorkflowStep, ogni azione `create_notification` diventa
 * `publish_event` con `event = '<entity_type>.<nome del passo>'` — la forma
 * esatta che il seed scrive per il passo colpito. La traduzione è fedele
 * all'intento: nel motore una notifica si ottiene pubblicando l'evento di
 * dominio che le regole di notifica ascoltano; `create_notification` non è mai
 * stata eseguita, quindi non si perde niente che oggi funzioni.
 *
 * Fail-loud: qualunque ALTRO tipo di azione fuori vocabolario FERMA la
 * migrazione nominando tenant, definizione, passo e tipo — non si indovina una
 * traduzione che nessuno ha ragionato. Un JSON corrotto ferma la migrazione
 * allo stesso modo. Idempotente: alla seconda esecuzione non resta nessuna
 * `create_notification` e non si scrive.
 */
import type { Migration } from '@opengraphity/neo4j'
import { isWorkflowActionType } from '@opengraphity/workflow'

/** Il tipo di azione delle automazioni che il motore dei workflow non ha. */
const LEGACY_NOTIFICATION_ACTION = 'create_notification'

interface ActionLike { type?: unknown; params?: Record<string, unknown> }

function parseActions(raw: unknown, what: string): ActionLike[] {
  if (raw == null || raw === '') return []
  if (typeof raw !== 'string') throw new Error(`${what} is not a JSON string (got ${typeof raw}); fix it before migrating`)
  let parsed: unknown
  try { parsed = JSON.parse(raw) }
  catch (e) { throw new Error(`${what} is corrupt JSON (${e instanceof Error ? e.message : String(e)}); fix it before migrating`) }
  if (!Array.isArray(parsed)) throw new Error(`${what} is not a JSON list; fix it before migrating`)
  return parsed as ActionLike[]
}

export const workflowStepActions: Migration = {
  id: '20260912_1210_workflow_step_actions',
  description: 'Personalizzazioni (ondata 0, B0-5): realign workflow step actions to the engine vocabulary — create_notification → publish_event(<entity_type>.<step>), as the seed writes it',
  async up(session) {
    const steps = await session.run(`
      MATCH (wd:WorkflowDefinition)-[:HAS_STEP]->(s:WorkflowStep)
      RETURN s.id AS id, s.name AS stepName,
             wd.tenant_id AS tenantId, wd.name AS defName, wd.entity_type AS entityType,
             s.enter_actions AS enterActions, s.exit_actions AS exitActions
      ORDER BY wd.tenant_id, wd.name, s.name
    `)

    const changes: string[] = []
    let updated = 0

    for (const record of steps.records) {
      const id         = String(record.get('id'))
      const stepName   = String(record.get('stepName'))
      const tenantId   = String(record.get('tenantId'))
      const defName    = String(record.get('defName'))
      const entityType = String(record.get('entityType'))
      const where      = `${tenantId}/${defName}/${stepName}`

      const lists = {
        enter_actions: parseActions(record.get('enterActions'), `${where} enter_actions`),
        exit_actions:  parseActions(record.get('exitActions'),  `${where} exit_actions`),
      }

      const next: Partial<Record<keyof typeof lists, string>> = {}
      for (const [key, actions] of Object.entries(lists) as Array<[keyof typeof lists, ActionLike[]]>) {
        let touched = false
        const translated = actions.map((action) => {
          if (action?.type === LEGACY_NOTIFICATION_ACTION) {
            touched = true
            const event = `${entityType}.${stepName}`
            changes.push(`${where} ${key}: ${LEGACY_NOTIFICATION_ACTION}(${JSON.stringify(action.params ?? {})}) → publish_event({"event":"${event}"})`)
            return { type: 'publish_event', params: { event } }
          }
          if (!isWorkflowActionType(action?.type)) {
            throw new Error(
              `${where} ${key}: azione di tipo ${JSON.stringify(action?.type ?? null)} fuori dal vocabolario del motore dei workflow. ` +
              `Questa migrazione traduce solo "${LEGACY_NOTIFICATION_ACTION}": correggi la definizione nel disegnatore prima di migrare.`,
            )
          }
          return action
        })
        if (touched) next[key] = JSON.stringify(translated)
      }

      if (Object.keys(next).length === 0) continue

      await session.run(`
        MATCH (s:WorkflowStep {id: $id})
        SET s.enter_actions = coalesce($enterActions, s.enter_actions),
            s.exit_actions  = coalesce($exitActions,  s.exit_actions)
      `, { id, enterActions: next.enter_actions ?? null, exitActions: next.exit_actions ?? null })
      updated++
    }

    console.log(
      `[${workflowStepActions.id}] ${steps.records.length} WorkflowStep esaminati, ${updated} riallineati` +
      (changes.length ? `\n  ${changes.join('\n  ')}` : ' — nessuna azione fuori vocabolario'),
    )
  },
}
