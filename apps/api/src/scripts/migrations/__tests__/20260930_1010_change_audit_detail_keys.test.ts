/** Secondo giro UI del 15 set 2026: le voci vecchie del registro della change diventano chiave e parametri. */
import { describe, it, expect } from 'vitest'
import { PARSERS } from '../20260930_1010_change_audit_detail_keys.js'

describe('20260930_1010 — dal testo inglese a chiave e parametri', () => {
  it('le quattro forme che il prodotto scriveva', () => {
    expect(PARSERS['assessment_task_completed']!('Technical · Portale clienti: score 100')).toEqual({ key: 'taskScored', params: { role: 'support', ci: 'Portale clienti', score: '100' } })
    expect(PARSERS['assessment_response_submitted']!('Functional · App: "Gli utenti sono stati avvisati?" → Sì, avvisati'))
      .toEqual({ key: 'responseSubmitted', params: { role: 'owner', ci: 'App', question: 'Gli utenti sono stati avvisati?', answer: 'Sì, avvisati' } })
    expect(PARSERS['ci_risk_computed']!('Portale clienti: risk 95')).toEqual({ key: 'ciRisk', params: { ci: 'Portale clienti', score: '95' } })
    expect(PARSERS['deploy_plan_saved']!('App portale clienti: 1 step — "Rilascio versione 2.4"')).toEqual({ key: 'planSaved', params: { ci: 'App portale clienti', count: '1', steps: '"Rilascio versione 2.4"' } })
  })

  it('un testo di forma diversa non si converte (nessuna chiave inventata)', () => {
    expect(PARSERS['assessment_task_completed']!('Tecnico · X: punteggio 3')).toBeNull()
  })
})

describe('20260930_1020 — la forma più vecchia, Owner/Support', async () => {
  const { PARSERS_OWNER_SUPPORT } = await import('../20260930_1020_change_audit_detail_keys_owner_support.js')
  it('Owner · APP-001: score 35', () => {
    expect(PARSERS_OWNER_SUPPORT['assessment_task_completed']!('Owner · APP-001: score 35')).toEqual({ key: 'taskScored', params: { role: 'owner', ci: 'APP-001', score: '35' } })
    expect(PARSERS_OWNER_SUPPORT['assessment_response_submitted']!('Support · APP-001: "Does the change require downtime?" → Partial / degraded'))
      .toEqual({ key: 'responseSubmitted', params: { role: 'support', ci: 'APP-001', question: 'Does the change require downtime?', answer: 'Partial / degraded' } })
  })
})
