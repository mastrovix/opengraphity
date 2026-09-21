/**
 * Revisione del 14 set 2026 · CH-2: i codici di change e task passano al
 * contatore atomico (`lib/sequence.ts`). Qui i contatori `change` e `task` di
 * ogni tenant si allineano al massimo dei codici esistenti — solo verso l'alto,
 * mai verso il basso — così la numerazione continua invece di ripartire da 1.
 * (Il seed dei contatori in `packages/neo4j` init cercava l'etichetta
 * `ChangeTask`, che non esiste: sui task non aveva mai allineato niente.)
 */
import type { Migration } from '@opengraphity/neo4j'

export const changeTaskCounters: Migration = {
  id: '20260923_1060_change_task_counters',
  description: 'Contatori atomici change/task allineati al massimo dei codici esistenti (i codici non si generano più con max()+1)',
  async up(session) {
    const res = await session.run(`
      CALL {
        MATCH (ch:Change) WHERE ch.tenant_id IS NOT NULL AND ch.code STARTS WITH 'CHG'
        RETURN ch.tenant_id AS t, 'change' AS kind, max(toInteger(substring(ch.code, 3))) AS mx
        UNION
        MATCH (tk) WHERE (tk:AssessmentTask OR tk:DeployPlanTask OR tk:ValidationTest OR tk:DeploymentTask OR tk:ReviewTask)
          AND tk.tenant_id IS NOT NULL AND tk.code STARTS WITH 'TASK'
        RETURN tk.tenant_id AS t, 'task' AS kind, max(toInteger(substring(tk.code, 4))) AS mx
      }
      MERGE (c:Counter {tenant_id: t, kind: kind})
      WITH c, t, kind, mx, c.value AS before
      SET c.value = CASE WHEN c.value IS NULL OR c.value < mx THEN mx ELSE c.value END
      RETURN t, kind, before, c.value AS after
      ORDER BY t, kind
    `)
    for (const r of res.records) console.log(`[${changeTaskCounters.id}] ${String(r.get('t'))} ${String(r.get('kind'))}: ${String(r.get('before'))} → ${String(r.get('after'))}`)
  },
}
