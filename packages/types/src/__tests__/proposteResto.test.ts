/**
 * IMPROVEMENT PROPOSALS: the parts that decide when one comes BACK.
 *
 * "A rejected proposal returns if the evidence changes substantially" is not
 * an executable predicate. Implemented as "the hash of the evidence changed"
 * it would return every night. The logarithmic grade is what makes it one:
 * 47 → 52 reopens nothing, 47 → 190 does.
 *
 * And the decision is the SERVER's, deterministically: if the model decided,
 * it would be deciding when to work around its own rejection.
 */
import { describe, it, expect } from 'vitest'
import {
  PROPOSAL_AREAS, isProposalArea,
  PROPOSAL_STATUSES, isProposalStatus, PROPOSAL_OPEN_STATUSES,
  PROPOSAL_REJECTION_KINDS, isProposalRejectionKind,
  PROPOSAL_REJECTION_NOTE_MIN, PROPOSAL_REJECTION_NOTE_MAX,
  PROPOSAL_ACTION_TYPES, isProposalActionType, PROPOSAL_FORBIDDEN_ACTION_TYPES,
  evidenceGrade, proposalMayReturn, PROPOSAL_REJECTION_COOLDOWN_DAYS,
  PROPOSAL_LIMIT_DEFAULTS, PROPOSAL_LIMIT_RANGES,
} from '../proposals.js'

const NEVER: unknown[] = [undefined, null, 42, true, {}, [], '']

describe('the proposal vocabularies', () => {
  it('areas have names, not numbers: "area 4" and "wave 4" were two different things', () => {
    for (const a of PROPOSAL_AREAS) {
      expect(a).toMatch(/^[a-z_]+$/)
      expect(isProposalArea(a)).toBe(true)
    }
    for (const v of [...NEVER, '4', 'configurazione']) expect(isProposalArea(v)).toBe(false)
  })

  it('"not now" and "expired" are statuses of their own, and only they two plus open hold a slot', () => {
    // Without `not_now`, postponing forces a rejection — and a rejection
    // silences the fingerprint. Without `expired`, five ignored proposals
    // and the product stops proposing, indistinguishably from working.
    expect(PROPOSAL_STATUSES).toContain('not_now')
    expect(PROPOSAL_STATUSES).toContain('expired')
    expect([...PROPOSAL_OPEN_STATUSES]).toEqual(['open', 'not_now'])
    for (const s of PROPOSAL_OPEN_STATUSES) expect(isProposalStatus(s)).toBe(true)
    for (const v of [...NEVER, 'OPEN', 'pending']) expect(isProposalStatus(v)).toBe(false)
  })

  it('"wrong analysis" and "valid but declined" stay two: only the first means noise', () => {
    // For whoever reads it a month later, and for the analyst's quality
    // measure, these are completely different facts.
    expect([...PROPOSAL_REJECTION_KINDS]).toEqual(['wrong_analysis', 'valid_but_declined'])
    for (const k of PROPOSAL_REJECTION_KINDS) expect(isProposalRejectionKind(k)).toBe(true)
    for (const v of [...NEVER, 'no', 'rejected']) expect(isProposalRejectionKind(v)).toBe(false)
  })

  it('a rejection note has a floor and a ceiling', () => {
    expect(PROPOSAL_REJECTION_NOTE_MIN).toBeGreaterThan(0)
    expect(PROPOSAL_REJECTION_NOTE_MIN).toBeLessThan(PROPOSAL_REJECTION_NOTE_MAX)
  })
})

describe('the closed action catalogue', () => {
  it('every entry is "subject.verb", and the guard refuses anything else', () => {
    // An accepted proposal does not run "what the model wrote": it runs an
    // entry of this list, with typed parameters the server validates.
    for (const a of PROPOSAL_ACTION_TYPES) {
      expect(a).toMatch(/^[a-z_]+\.[a-z_]+$/)
      expect(isProposalActionType(a)).toBe(true)
    }
    for (const v of [...NEVER, 'portal_severities.remove', 'anything']) expect(isProposalActionType(v)).toBe(false)
  })

  it('the three things excluded for good are not in the catalogue, in any spelling', () => {
    // Running scripts, calling webhooks and advancing workflows: the server
    // refuses a proposal naming them, even indirectly (inside the actions of
    // an automation it proposes to create).
    expect([...PROPOSAL_FORBIDDEN_ACTION_TYPES].sort()).toEqual(['call_webhook', 'execute_script', 'transition_workflow'])
    for (const f of PROPOSAL_FORBIDDEN_ACTION_TYPES) expect(isProposalActionType(f)).toBe(false)
  })

  it('the entry that CREATES something creates it switched off', () => {
    // It is born disabled and carries origin 'ai_proposal' — not a label but
    // the rule by which every switch-on revalidates its actions against a
    // narrower allow-list.
    expect(PROPOSAL_ACTION_TYPES).toContain('automation.create_disabled')
    expect(PROPOSAL_ACTION_TYPES).not.toContain('automation.create' as never)
  })
})

describe('evidenceGrade — the band, not the count', () => {
  it('grows one step per doubling', () => {
    expect(evidenceGrade(1)).toBe(0)
    expect(evidenceGrade(2)).toBe(1)
    expect(evidenceGrade(3)).toBe(1)
    expect(evidenceGrade(4)).toBe(2)
    expect(evidenceGrade(47)).toBe(5)
    expect(evidenceGrade(52)).toBe(5)     // 47 → 52 is the same band
    expect(evidenceGrade(190)).toBe(7)    // 47 → 190 is not
  })

  it('nothing observed is grade zero, and a nonsense count does not throw', () => {
    for (const n of [0, -1, NaN, Infinity, -Infinity]) expect(evidenceGrade(n), String(n)).toBe(0)
  })
})

describe('proposalMayReturn', () => {
  const rejectedAt = new Date('2026-01-01T00:00:00Z')
  const after = (days: number) => new Date(rejectedAt.getTime() + days * 86_400_000)

  it('inside the cooldown it never returns, however much the evidence grew', () => {
    expect(proposalMayReturn({ rejectedGrade: 5, currentN: 10_000, rejectedAt, now: after(PROPOSAL_REJECTION_COOLDOWN_DAYS - 1) })).toBe(false)
  })

  it('after the cooldown it returns only when the BAND grew', () => {
    const now = after(PROPOSAL_REJECTION_COOLDOWN_DAYS + 1)
    expect(proposalMayReturn({ rejectedGrade: 5, currentN: 52, rejectedAt, now })).toBe(false)   // same band
    expect(proposalMayReturn({ rejectedGrade: 5, currentN: 190, rejectedAt, now })).toBe(true)
  })

  it('evidence that SHRANK never brings it back', () => {
    const now = after(365)
    expect(proposalMayReturn({ rejectedGrade: 7, currentN: 3, rejectedAt, now })).toBe(false)
    expect(proposalMayReturn({ rejectedGrade: 7, currentN: 0, rejectedAt, now })).toBe(false)
  })

  it('exactly at the cooldown boundary the band still has to have grown', () => {
    const now = after(PROPOSAL_REJECTION_COOLDOWN_DAYS)
    expect(proposalMayReturn({ rejectedGrade: 0, currentN: 100, rejectedAt, now })).toBe(true)
    expect(proposalMayReturn({ rejectedGrade: 9, currentN: 100, rejectedAt, now })).toBe(false)
  })
})

describe('the two caps', () => {
  it('each default sits inside its own range', () => {
    // They are factory values: the cap is tenant configuration, like the
    // catalog form limits — not a product constant.
    for (const k of ['maxOpen', 'maxPerDay'] as const) {
      const { min, max } = PROPOSAL_LIMIT_RANGES[k]
      expect(min).toBeLessThan(max)
      expect(PROPOSAL_LIMIT_DEFAULTS[k]).toBeGreaterThanOrEqual(min)
      expect(PROPOSAL_LIMIT_DEFAULTS[k]).toBeLessThanOrEqual(max)
    }
  })

  it('the daily flow cap is tighter than the open cap: one lucky night must not fill the page', () => {
    expect(PROPOSAL_LIMIT_DEFAULTS.maxPerDay).toBeLessThan(PROPOSAL_LIMIT_DEFAULTS.maxOpen)
  })
})
