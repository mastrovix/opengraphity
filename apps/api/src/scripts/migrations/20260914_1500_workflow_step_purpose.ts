/**
 * Personalizzazioni, ondata 4 (B-4 / C-9 / D-22): lo SCOPO ai passi che
 * esistono già.
 *
 * Il codice riconosceva i passi delle change e dei problem dal nome
 * (`'deployment'`, `'approval'`, `'change_requested'`…). Da questa ondata
 * chiede lo scopo (`WORKFLOW_STEP_PURPOSES`), che il cliente può assegnare a
 * un passo chiamato come vuole. I passi già seminati, però, non ce l'hanno:
 * questa migrazione lo scrive, **una volta**, usando l'unico posto in cui
 * guardare il nome è legittimo — la tabella `FACTORY_STEP_PURPOSES` dei nomi di
 * fabbrica.
 *
 * Regole:
 *  - scrive solo dove `purpose` è assente: uno scopo scelto dal cliente non si
 *    tocca mai (idempotente per costruzione);
 *  - un passo con un nome che non è di fabbrica resta senza scopo, ed è
 *    corretto: è del cliente, e lo dichiara lui nel disegnatore. Le regole di
 *    dominio che non trovano nessun passo con lo scopo che cercano si fermano
 *    dicendolo (`requireStepNamesByPurpose`), non in silenzio;
 *  - stampa quanti per tenant, definizione e scopo.
 */
import type { Migration } from '@opengraphity/neo4j'
import { FACTORY_STEP_PURPOSES } from '@opengraphity/types'

export const workflowStepPurpose: Migration = {
  id: '20260914_1500_workflow_step_purpose',
  description: 'WorkflowStep.purpose: scopo assegnato ai passi di fabbrica (change/problem/incident) dai loro nomi noti; i passi del cliente e gli scopi già scelti non si toccano',
  async up(session) {
    const res = await session.run(`
      MATCH (wd:WorkflowDefinition)-[:HAS_STEP]->(s:WorkflowStep)
      WITH wd, s, $purposes[s.name] AS wanted
      WHERE wanted IS NOT NULL AND s.purpose IS NULL
      SET s.purpose = wanted
      RETURN wd.tenant_id AS tenant, wd.name AS definition, s.name AS step, wanted AS purpose
      ORDER BY tenant, definition, step
    `, { purposes: FACTORY_STEP_PURPOSES })

    for (const r of res.records) {
      console.log(
        `[${workflowStepPurpose.id}] ${String(r.get('tenant'))} / "${String(r.get('definition'))}" / ` +
        `${String(r.get('step'))} → scopo "${String(r.get('purpose'))}"`,
      )
    }

    const left = await session.run(`
      MATCH (:WorkflowDefinition)-[:HAS_STEP]->(s:WorkflowStep)
      WHERE s.purpose IS NULL
      RETURN count(s) AS senzaScopo
    `)
    console.log(
      `[${workflowStepPurpose.id}] ${String(res.records.length)} passi hanno ricevuto lo scopo; ` +
      `${String(left.records[0]?.get('senzaScopo') ?? 0)} restano senza (passi del cliente o passi a cui lo scopo non serve: ` +
      `lo stato «come si vede da fuori» lo dice già la categoria).`,
    )
  },
}
