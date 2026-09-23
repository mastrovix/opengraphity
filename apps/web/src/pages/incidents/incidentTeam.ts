/**
 * THE TEAM OF A NEW INCIDENT (23 Sep 2026, the owner's rule).
 *
 * Every incident goes to the SUPPORT GROUP of its CI, whatever the channel
 * that opens it. In this form the team field is therefore prefilled with the
 * support group of the first chosen CI that has one; the person may change
 * it, and a team chosen by hand is never overwritten when more CIs are added.
 * The chosen team travels with the creation (`createIncident(input.teamId)`):
 * one assignment, one note — no second call after the creation.
 *
 * Precedence, in one place: the team chosen by hand, then the CI's support
 * group, then the one the AI triage suggested. So the AI can fill the field
 * only when no CI has a support group and nobody chose, and never replaces
 * the support group silently.
 */
import { useState } from 'react'

export interface TeamRef { id: string; name: string }
export interface CIWithSupportGroup { id: string; name: string; supportGroup?: TeamRef | null }

/** `hand`: undefined = nobody chose; null = «no team» was chosen. */
export function incidentTeam(hand: TeamRef | null | undefined, supportGroup: TeamRef | null, suggested: TeamRef | null): TeamRef | null {
  if (hand !== undefined) return hand
  return supportGroup ?? suggested
}

export function useIncidentTeam(cis: readonly CIWithSupportGroup[]) {
  const [hand, setHand] = useState<TeamRef | null | undefined>(undefined)
  const [suggested, setSuggested] = useState<TeamRef | null>(null)
  /** The first chosen CI with a support group: where the prefilled team comes from. */
  const fromCI = cis.find((ci) => ci.supportGroup) ?? null
  const team = incidentTeam(hand, fromCI?.supportGroup ?? null, suggested)
  return {
    team,
    fromCI,
    /** The team is the CI's support group, not a choice (nobody changed it). */
    prefilled: hand === undefined && fromCI !== null,
    choose: (t: TeamRef | null) => setHand(t),
    suggest: (t: TeamRef) => setSuggested(t),
  }
}
