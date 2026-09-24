/**
 * THE PRECEDENCE OF THE TEAM OF A NEW INCIDENT, in one place: chosen by hand,
 * then the CI's support group, then the AI's suggestion.
 */
import { describe, it, expect } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { incidentTeam, useIncidentTeam } from './incidentTeam'

const DBA = { id: 'tm-2', name: 'DBA' }
const NET = { id: 'tm-1', name: 'Network Ops' }
const AI = { id: 'tm-9', name: 'Suggested' }

describe('incidentTeam', () => {
  it('nobody chose: the support group of the CI, or else the suggestion, or else nobody', () => {
    expect(incidentTeam(undefined, DBA, AI)).toEqual(DBA)
    expect(incidentTeam(undefined, null, AI)).toEqual(AI)
    expect(incidentTeam(undefined, null, null)).toBeNull()
  })

  it('a choice by hand wins over both — «no team» included', () => {
    expect(incidentTeam(NET, DBA, AI)).toEqual(NET)
    expect(incidentTeam(null, null, AI)).toBeNull()
  })
})

describe('useIncidentTeam: the suggestion the support group replaced (G19, 24 Sep 2026)', () => {
  it('is named while the support group stands in its place, and forgotten once someone chooses', () => {
    const { result, rerender } = renderHook(({ cis }) => useIncidentTeam(cis), { initialProps: { cis: [] as Array<{ id: string; name: string; supportGroup?: typeof DBA | null }> } })
    act(() => result.current.suggest(AI))
    expect(result.current.team).toEqual(AI)
    expect(result.current.overriddenSuggestion).toBeNull()
    rerender({ cis: [{ id: 'ci-1', name: 'db-01', supportGroup: DBA }] })
    expect(result.current.team).toEqual(DBA)
    expect(result.current.overriddenSuggestion).toEqual(AI)
    act(() => result.current.choose(AI))
    expect(result.current.overriddenSuggestion).toBeNull()
  })

  it('the same team suggested and supporting is not an override', () => {
    const { result } = renderHook(() => useIncidentTeam([{ id: 'ci-1', name: 'db-01', supportGroup: DBA }]))
    act(() => result.current.suggest(DBA))
    expect(result.current.overriddenSuggestion).toBeNull()
  })
})
