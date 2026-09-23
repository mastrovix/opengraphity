/**
 * WHAT PEOPLE WRITE IN THE DEMO TENANT'S TICKETS (23 Sep 2026; tour of the
 * same day: D17, D19, D20, D32).
 *
 * The texts are data, but the generator leans on them in ways a typo would
 * break silently — so what is pinned is what the rest of the generator takes
 * for granted:
 *
 *  - D19, one cause told once: a problem names its evidence by the ids of
 *    incident stories and its fix by the key of a change story, and both must
 *    be of the problem's own CI kind (an incident about a database linked to a
 *    problem about a certificate is the defect the tour found); the same for
 *    the fix an incident story names. Keys are unique: `changeStoryByKey`
 *    returns the first match, and a duplicate would pick the wrong story.
 *  - `changeStoryByKey` fails loud on a key that is not there.
 *  - `fill` puts the CI's name in every `{ci}`, and no other placeholder is
 *    left anywhere for a user to read.
 *  - D17: every trouble is written in several ways; an incident on a CI names
 *    it, a portal incident is in the requester's words (no CI name).
 *  - An incident is resolved only with a root cause (the workflow's condition
 *    `rootCause != null`): every story has at least one.
 *  - D20: the categories are the ones the product ships (the form offers
 *    them).
 */
import { describe, it, expect, vi } from 'vitest'
import { CHANGE_STORIES, INCIDENT_STORIES, PROBLEM_STORIES, changeStoryByKey, fill, PENDING_NOTES, WORK_COMMENTS, REQUESTER_COMMENTS } from '../ticketTexts.js'
import type { CILabel } from '../cmdb.js'

// seedEnumTypes reaches `@opengraphity/neo4j` through domainMatrix.ts: no driver in a unit test.
vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn() }))
const { SYSTEM_ENUMS } = await import('../../../seedEnumTypes.js')

const CI_KINDS = Object.keys(CHANGE_STORIES) as CILabel[]
const allIncidentStories = Object.values(INCIDENT_STORIES).flat()
const allProblemStories = Object.values(PROBLEM_STORIES).flat()
const allChangeStories = Object.values(CHANGE_STORIES).flat()

describe('D19: one cause, told once', () => {
  it('every problem\'s evidence is incident stories of its own CI kind, and its fix a change of its own CI kind', () => {
    for (const kind of CI_KINDS) {
      const incidents = new Set(INCIDENT_STORIES[kind].map((s) => s.id))
      const changes = new Set(CHANGE_STORIES[kind].map((s) => s.id))
      for (const p of PROBLEM_STORIES[kind]) {
        expect(p.symptoms.length, p.id).toBeGreaterThan(0)
        for (const symptom of p.symptoms) expect(incidents.has(symptom), `${p.id} ← ${symptom}`).toBe(true)
        expect(changes.has(p.fix), `${p.id} → ${p.fix}`).toBe(true)
      }
    }
  })

  it('the fix an incident story names is a change of the same CI kind; a portal incident has none', () => {
    for (const kind of CI_KINDS) {
      const changes = new Set(CHANGE_STORIES[kind].map((s) => s.id))
      for (const s of INCIDENT_STORIES[kind]) if (s.fix) expect(changes.has(s.fix), `${s.id} → ${s.fix}`).toBe(true)
    }
    expect(INCIDENT_STORIES.portal.every((s) => s.fix === undefined)).toBe(true)
  })

  it('the keys are unique, so a key always finds its own story', () => {
    for (const list of [allIncidentStories, allProblemStories, allChangeStories]) {
      const ids = list.map((s) => s.id)
      expect(new Set(ids).size).toBe(ids.length)
    }
  })
})

describe('changeStoryByKey', () => {
  it('finds the change story of any CI kind by its key', () => {
    expect(changeStoryByKey('srv.patch').title).toBe('Monthly OS patching of {ci}')
    expect(changeStoryByKey('cert.automate')).toBe(CHANGE_STORIES.Certificate.find((s) => s.id === 'cert.automate'))
    for (const s of allChangeStories) expect(changeStoryByKey(s.id)).toBe(s)
  })

  it('fails loud on a key that is not there, naming it', () => {
    expect(() => changeStoryByKey('srv.nothing')).toThrow('ticketTexts: no change story "srv.nothing"')
  })
})

describe('fill', () => {
  it('puts the CI\'s name in every {ci} of the text', () => {
    expect(fill('{ci} is down, and {ci} does not restart', 'SRV_MIL_001')).toBe('SRV_MIL_001 is down, and SRV_MIL_001 does not restart')
    expect(fill('My laptop does not start', 'SRV_MIL_001')).toBe('My laptop does not start')
  })

  it('leaves no placeholder for a user to read in any text of any story', () => {
    const texts = [
      ...allIncidentStories.flatMap((s) => [...s.titles, s.description, ...s.rootCauses]),
      ...allProblemStories.flatMap((s) => [s.title, s.description, s.workaround, s.rootCause]),
      ...allChangeStories.flatMap((s) => [s.title, s.why, s.what, ...s.steps]),
      ...PENDING_NOTES, ...WORK_COMMENTS, ...REQUESTER_COMMENTS,
    ]
    for (const t of texts) expect(fill(t, 'DB_ORDERS'), t).not.toMatch(/[{}]/)
  })
})

describe('D17: how people write', () => {
  it('every trouble is written in several ways, never twice the same', () => {
    for (const s of allIncidentStories) {
      expect(s.titles.length, s.id).toBeGreaterThanOrEqual(2)
      expect(new Set(s.titles).size, s.id).toBe(s.titles.length)
    }
  })

  it('an incident on a CI names the CI; one from the portal is in the requester\'s words', () => {
    for (const kind of CI_KINDS) for (const s of INCIDENT_STORIES[kind]) for (const t of s.titles) expect(t, s.id).toContain('{ci}')
    for (const s of INCIDENT_STORIES.portal) expect([...s.titles, s.description].some((t) => t.includes('{ci}')), s.id).toBe(false)
  })

  it('every incident can be resolved: each story has a root cause to give', () => {
    for (const s of allIncidentStories) {
      expect(s.rootCauses.length, s.id).toBeGreaterThan(0)
      for (const c of s.rootCauses) expect(c.trim(), s.id).not.toBe('')
    }
  })

  it('a problem has its workaround and its cause, a change its steps', () => {
    for (const p of allProblemStories) for (const text of [p.title, p.description, p.workaround, p.rootCause]) expect(text.trim(), p.id).not.toBe('')
    for (const c of allChangeStories) expect(c.steps.length, c.id).toBeGreaterThan(0)
  })
})

describe('D20: the categories are the product\'s own', () => {
  it('every incident and problem story is filed under a value of the shipped «category» vocabulary', () => {
    const categories = SYSTEM_ENUMS.find((e) => e.name === 'category')!.values
    for (const s of [...allIncidentStories, ...allProblemStories]) expect(categories, s.id).toContain(s.category)
  })
})
