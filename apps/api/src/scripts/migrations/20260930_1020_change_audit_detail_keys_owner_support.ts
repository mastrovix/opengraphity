/**
 * Seguito della 1010: le voci ancora più vecchie scrivevano il ruolo come
 * «Owner» / «Support» invece di «Functional» / «Technical» (su c-one: 18 voci
 * rimaste senza chiave). Stessa conversione, stessa regola: un testo di forma
 * diversa resta com'è. Idempotente.
 */
import type { Migration } from '@opengraphity/neo4j'

const ROLE: Record<string, string> = { Owner: 'owner', Support: 'support' }

export const PARSERS_OWNER_SUPPORT: Record<string, (detail: string) => { key: string; params: Record<string, string> } | null> = {
  assessment_response_submitted: (d) => {
    const m = /^(Owner|Support) · (.+?): "(.*)" → (.*)$/s.exec(d)
    return m ? { key: 'responseSubmitted', params: { role: ROLE[m[1]!]!, ci: m[2]!, question: m[3]!, answer: m[4]! } } : null
  },
  assessment_task_completed: (d) => {
    const m = /^(Owner|Support) · (.+): score (\d+)$/.exec(d)
    return m ? { key: 'taskScored', params: { role: ROLE[m[1]!]!, ci: m[2]!, score: m[3]! } } : null
  },
}

export const changeAuditDetailKeysOwnerSupport: Migration = {
  id:          '20260930_1020_change_audit_detail_keys_owner_support',
  description: 'Registro della change: chiave e parametri anche per le voci col ruolo scritto Owner/Support',

  async up(session) {
    let converted = 0
    for (const [action, parse] of Object.entries(PARSERS_OWNER_SUPPORT)) {
      const res = await session.run(
        `MATCH (e:ChangeAuditEntry {action: $action}) WHERE e.detail_key IS NULL AND e.detail IS NOT NULL RETURN e.id AS id, e.detail AS detail`,
        { action },
      )
      const rows = res.records
        .map((r) => ({ id: String(r.get('id')), parsed: parse(String(r.get('detail'))) }))
        .filter((r) => r.parsed)
        .map((r) => ({ id: r.id, key: r.parsed!.key, params: JSON.stringify(r.parsed!.params) }))
      for (let i = 0; i < rows.length; i += 500) {
        await session.run(`UNWIND $rows AS row MATCH (e:ChangeAuditEntry {id: row.id}) SET e.detail_key = row.key, e.detail_params = row.params`, { rows: rows.slice(i, i + 500) })
      }
      converted += rows.length
    }
    console.log(`[${changeAuditDetailKeysOwnerSupport.id}] voci convertite: ${converted}`)
  },
}
