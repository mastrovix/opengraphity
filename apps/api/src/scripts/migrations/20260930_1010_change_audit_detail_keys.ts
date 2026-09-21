/**
 * Voci del registro della change scritte senza chiave (secondo giro UI del 15
 * set 2026). `assessment_response_submitted`, `assessment_task_completed`,
 * `ci_risk_computed` e `deploy_plan_saved` salvavano solo il testo inglese
 * («Technical · Portale clienti: score 100»), e il registro lo mostrava così
 * anche in italiano. Da ora si scrivono con chiave e parametri; qui si
 * convertono quelle già scritte, quando il testo ha la forma che il prodotto
 * scriveva. Un testo di forma diversa resta com'è (nessuna chiave inventata).
 * Idempotente: tocca solo le voci senza `detail_key`.
 */
import type { Migration } from '@opengraphity/neo4j'

const ROLE: Record<string, string> = { Functional: 'owner', Technical: 'support' }

type Parsed = { key: string; params: Record<string, string> } | null

export const PARSERS: Record<string, (detail: string) => Parsed> = {
  assessment_response_submitted: (d) => {
    const m = /^(Functional|Technical) · (.+?): "(.*)" → (.*)$/s.exec(d)
    return m ? { key: 'responseSubmitted', params: { role: ROLE[m[1]!]!, ci: m[2]!, question: m[3]!, answer: m[4]! } } : null
  },
  assessment_task_completed: (d) => {
    const m = /^(Functional|Technical) · (.+): score (\d+)$/.exec(d)
    return m ? { key: 'taskScored', params: { role: ROLE[m[1]!]!, ci: m[2]!, score: m[3]! } } : null
  },
  ci_risk_computed: (d) => {
    const m = /^(.+): risk (\d+)$/.exec(d)
    return m ? { key: 'ciRisk', params: { ci: m[1]!, score: m[2]! } } : null
  },
  deploy_plan_saved: (d) => {
    const m = /^(.+): (\d+) step — (.*)$/s.exec(d)
    return m ? { key: 'planSaved', params: { ci: m[1]!, count: m[2]!, steps: m[3]! } } : null
  },
}

export const changeAuditDetailKeys: Migration = {
  id:          '20260930_1010_change_audit_detail_keys',
  description: 'Registro della change: chiave e parametri per le voci di assessment, rischio e piano scritte solo in inglese',

  async up(session) {
    let converted = 0
    let kept = 0
    for (const [action, parse] of Object.entries(PARSERS)) {
      let cursor = ''
      for (;;) {
        const page = await session.run(
          `MATCH (e:ChangeAuditEntry {action: $action}) WHERE e.detail_key IS NULL AND e.detail IS NOT NULL AND e.id > $cursor
           RETURN e.id AS id, e.detail AS detail ORDER BY e.id LIMIT 500`,
          { action, cursor },
        )
        if (page.records.length === 0) break
        const rows: Array<{ id: string; key: string; params: string }> = []
        for (const r of page.records) {
          const id = String(r.get('id'))
          cursor = id
          const parsed = parse(String(r.get('detail')))
          if (parsed) rows.push({ id, key: parsed.key, params: JSON.stringify(parsed.params) }); else kept++
        }
        if (rows.length > 0) {
          await session.run(
            `UNWIND $rows AS row MATCH (e:ChangeAuditEntry {id: row.id}) SET e.detail_key = row.key, e.detail_params = row.params`,
            { rows },
          )
          converted += rows.length
        }
      }
    }
    console.log(`[${changeAuditDetailKeys.id}] voci convertite: ${converted}; lasciate com'erano (forma diversa): ${kept}`)
  },
}
