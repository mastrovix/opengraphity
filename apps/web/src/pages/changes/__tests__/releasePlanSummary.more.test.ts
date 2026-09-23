/**
 * THE CONSOLIDATED PLAN OF A CHANGE: THE CASES AT THE EDGES.
 *
 * The main suite covers CIs whose plan task exists. A change is created with
 * its CIs well before anyone writes a plan, and in that state the summary is
 * what a Change Manager reads to chase people. So these tests pin:
 *  - a CI with no plan task at all is listed as "no date", with no task code
 *    (none exists), with the team that will write it, and its three tasks
 *    count as open — never as done;
 *  - the list of plans without dates, and windows that start at the same
 *    instant, have a stable order (by CI name), so the page does not reshuffle
 *    between two openings;
 *  - with no window at all, the Gantt axis has no ticks to draw.
 */
import { describe, it, expect } from 'vitest'
import type { AffectedCI, DeployStep } from '@/types/change'
import { riepilogoRilascio, taccheDelPiano, barreDelPiano } from '../releasePlanSummary'

const step = (title: string, start: string, end: string): DeployStep =>
  ({ title, validationWindow: { start, end }, releaseWindow: { start, end } })

/** A CI of the change: without a plan task and without assessments unless given. */
const ci = (name: string, over: Partial<Pick<AffectedCI, 'deployPlan' | 'assessmentOwner' | 'assessmentSupport'>> & { supportGroup?: string } = {}): AffectedCI => ({
  ciPhase: 'assessment', riskScore: null,
  ci: { id: `ci-${name}`, name, type: 'server', environment: 'production', ownerGroup: null,
    supportGroup: over.supportGroup ? { id: 'g', name: over.supportGroup } : null },
  assessmentOwner: over.assessmentOwner ?? null,
  assessmentSupport: over.assessmentSupport ?? null,
  deployPlan: over.deployPlan ?? null,
  validation: null, deployment: null, review: null,
})

const plan = (code: string, steps: DeployStep[]) =>
  ({ id: `dp-${code}`, code, status: 'in-progress', steps, completedBy: null, completedAt: null, assignedTeam: null, assignee: null })

describe('a CI whose plan task does not exist yet', () => {
  it('is listed as a plan without dates, without a task code, owed by the support group of the CI', () => {
    const r = riepilogoRilascio([ci('db-prod-01', { supportGroup: 'DBA' })])
    expect(r.voci).toEqual([])
    expect(r.senzaDate).toEqual([
      { ciId: 'ci-db-prod-01', ciName: 'db-prod-01', taskCode: null, stato: null, teamName: 'DBA', vuoto: true },
    ])
    expect(r.inviluppo).toBeNull()
  })

  it('its three tasks count as open, and it is neither a filled-in nor a completed plan', () => {
    const r = riepilogoRilascio([ci('db-prod-01')])
    expect(r).toMatchObject({ taskChiusi: 0, taskTotali: 3, pianiCompilati: 0, pianiCompletati: 0, pianiTotali: 1 })
  })
})

describe('a stable order', () => {
  it('the plans without dates are sorted by CI name, whatever the order of the CIs', () => {
    const r = riepilogoRilascio([ci('zeta-01'), ci('alfa-01'), ci('mid-01')])
    expect(r.senzaDate.map((p) => p.ciName)).toEqual(['alfa-01', 'mid-01', 'zeta-01'])
  })

  it('two windows of the same kind starting at the same instant follow the CI name', () => {
    const same = [step('Deploy', '2026-09-21T20:00:00Z', '2026-09-21T21:00:00Z')]
    const r = riepilogoRilascio([
      ci('web-02', { deployPlan: plan('TASK2', same) }),
      ci('web-01', { deployPlan: plan('TASK1', same) }),
    ])
    expect(r.voci.map((v) => `${v.tipo}/${v.ciName}`)).toEqual([
      'validation/web-01', 'validation/web-02', 'release/web-01', 'release/web-02',
    ])
  })
})

describe('the Gantt with nothing to draw', () => {
  it('has neither ticks nor bars', () => {
    expect(taccheDelPiano([])).toEqual([])
    expect(barreDelPiano([])).toEqual([])
  })
})
