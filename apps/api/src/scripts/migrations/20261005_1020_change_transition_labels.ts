/**
 * L'ETICHETTA DI UN ARCO NOMINA TUTTO QUELLO CHE LA SUA CONDIZIONE VERIFICA,
 * anche sui workflow già seminati (17 set 2026).
 *
 * `all_assessments_complete` pretende TRE task per ogni CI impattato — il
 * l'assessment funzionale, quello tecnico e il PIANO di rilascio — e l'arco di
 * fabbrica si chiamava «Assessment completed». Chi lo vedeva non scattare
 * andava a guardare i due assessment, li trovava completati, e non aveva modo
 * di sapere che mancava il piano. Stessa cosa per `all_deployments_complete`,
 * che verifica la validazione E il deployment mentre l'arco diceva solo
 * «Deployment completed»: l'etichetta della *condizione* era già stata
 * corretta a suo tempo («e le verifiche»), quella dell'*arco* no.
 *
 * ## Si tocca solo ciò che è ancora di fabbrica
 * Il `WHERE` confronta l'etichetta con il valore vecchio esatto, in entrambe
 * le lingue. Un arco che il cliente ha rinominato è suo e resta suo: è la
 * regola di questo prodotto, e una migrazione che passa sopra una
 * personalizzazione la cancella senza che nessuno se ne accorga.
 *
 * Idempotente: dopo la prima passata nessuna riga corrisponde più.
 */
import type { Migration } from '@opengraphity/neo4j'

/** Vecchio (quello di fabbrica) → nuovo, per condizione. */
const RINOMINE: ReadonlyArray<{
  condition: string
  daLabel: string
  daLabels: string
  aLabel: string
  aIt: string
}> = [
  {
    condition: 'all_assessments_complete',
    daLabel:   'Assessment completed',
    daLabels:  '{"it":"Assessment completato"}',
    aLabel:    'Assessments and plan completed',
    aIt:       'Valutazioni e piano completati',
  },
  {
    condition: 'all_deployments_complete',
    daLabel:   'Deployment completed',
    daLabels:  '{"it":"Deployment completato"}',
    aLabel:    'Deployment and validations completed',
    aIt:       'Deployment e verifiche completati',
  },
]

export const changeTransitionLabels: Migration = {
  id: '20261005_1020_change_transition_labels',
  description: 'Change workflows: factory arc labels name the plan and the validations, where still untouched',
  async up(session) {
    for (const r of RINOMINE) {
      const res = await session.run(`
        MATCH (s:WorkflowStep)-[tr:TRANSITIONS_TO]->(d:WorkflowStep)
        WHERE tr.condition = $condition
          AND tr.label = $daLabel
          AND coalesce(tr.labels, '') = $daLabels
        SET tr.label = $aLabel, tr.labels = $aLabels
        RETURN count(tr) AS rinominati
      `, {
        condition: r.condition,
        daLabel:   r.daLabel,
        daLabels:  r.daLabels,
        aLabel:    r.aLabel,
        aLabels:   JSON.stringify({ it: r.aIt }),
      })
      const n = Number(res.records[0]?.get('rinominati') ?? 0)
      console.log(`[${changeTransitionLabels.id}] ${r.condition}: ${n} archi rinominati (le etichette personalizzate non si toccano)`)
    }
  },
}
